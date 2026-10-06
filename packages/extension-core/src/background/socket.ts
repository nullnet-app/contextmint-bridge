/**
 * The bridge transport: the loopback link, plus zero-or-more configured
 * remote links, held open together.
 *
 * Before remote targets this module held ONE socket in `state.ws` and one
 * per-connection nonce in `state.currentExtSessionNonce`. Both are now
 * per-link (`links.ts`), and that is the substance of the change rather than
 * a refactor: the ready signature commits to the nonce of the connection its
 * hello arrived on, so a global nonce would sign one link's ready with
 * another link's handshake and the MCP would correctly reject it.
 *
 * What did NOT change, and must not:
 *
 * - **`connect` is still the keepalive's `ensureConnected`** — no parameters,
 *   idempotent, safe to call on every alarm tick. It now ensures EVERY link
 *   rather than one, and the `readyState` short-circuit still turns a tick
 *   into a no-op per link.
 * - **the loopback link is unconditional.** Remote targets are additional; no
 *   configuration removes or redirects `ws://127.0.0.1:37149`.
 * - **frames route DOWN** — `onEncryptedFrame` → `handlers/dispatch.ts`, and
 *   handlers reply through `send-inner.ts` rather than back through here.
 *
 * The one new refusal: a frame is dropped unless its `mcpId` is bound to the
 * link it arrived on. Decryption would fail anyway (the session key is
 * per-MCP and this extension holds a different one for the other link's
 * session), but "the id is not yours" is a routing answer and belongs before
 * the crypto rather than behind it.
 */

import {
  openEncryptedFrameDetailed,
  peekHelloVersion,
  validateFrame,
  toB64,
  PROTOCOL_VERSION,
  type Frame,
  type HelloFrameFromExtension,
  type InnerFrame,
  type EncryptedFrame,
  unavailableCapabilitiesHelloField,
  ACCOUNT_KEY_FRAME,
  ACCOUNT_ATTEST_FRAME,
  accountKeyId,
  fromB64,
  type AccountKeyFrame,
  type AccountAttestFrame,
} from '@fetchproxy/protocol';

import type { ChromeApi } from '../chrome-api.js';
import { bridgeSubprotocols, type RemoteTarget } from '../remote-targets.js';
import { loadRemoteTargets } from '../vault-records.js';
import { currentPlatform } from '../platform.js';
import { unavailableCapabilities } from '../capabilities.js';
// `MIN_SERVER_VERSION` — the `@fetchproxy/server` version at which protocol 4
// lands — is named in the refusal below, because a version number with no
// remedy beside it is a diagnosis the reader cannot act on. It lives in
// `lib/version-mismatch.ts` rather than here because Task 4.3's popup line
// states the same fact to the browser user, and two copies of a remedy are two
// things to forget to bump.
import { MIN_SERVER_VERSION } from '../lib/version-mismatch.js';
import {
  EXTENSION_MISMATCH_CLOSE,
  EXTENSION_MISMATCH_MESSAGE,
  gatewayOriginFor,
} from '../bridge-gateway.js';
import {
  ACCOUNT_CONFIRMED_CLOSE,
  BROWSER_TAKEN_CLOSE,
  CREDENTIAL_REVOKED_CLOSE,
  FACTS_CHANGED_CLOSE,
  browserTakenMessage,
} from '../bridge-close-codes.js';
import { AccountTrustStore, type TrustedAccount } from '../account-trust-store.js';

import { state } from './state.js';
import { setConnectionStatus, flashActivity } from './badge.js';
import { sendInner } from './send-inner.js';
import { clearAccountSessionApprovals, onServerHello, sendHelloRejected } from './server-hello.js';
import { forgetVersionMismatch, noteVersionMismatch } from './version-mismatch-store.js';
import { handleRequest } from './handlers/dispatch.js';
import { broadcastConnectionsChanged, clearSessionScopeFor } from './session-scope.js';
import { syncMainWorldBridgeForActiveTrust } from './main-world-bridge-sync.js';
import {
  IMMEDIATE_REDIAL_SPACING_MS,
  LOCAL_LINK_ID,
  anyLinkOpen,
  linkForMcp,
  links,
  localLink,
  remoteLink,
  unbindLink,
  unbindMcp,
  storeAccountAttestation,
  clearAccountAttestations,
  type Link,
} from './links.js';

declare const chrome: ChromeApi;

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 5000, 10_000];
/**
 * A remote link backs off further than the loopback one. Loopback failure
 * means "the MCP is not running yet" and is expected to clear in seconds; a
 * remote failure means a WAN round-trip to something that may be down,
 * revoked or unreachable, and retrying that every ten seconds forever is a
 * service worker that never idles.
 */
const REMOTE_RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 15_000, 30_000, 60_000];

/** Ensure the loopback link exists. Called before every connect sweep. */
function ensureLocalLink(): Link {
  const existing = links.get(LOCAL_LINK_ID);
  if (existing) return existing;
  const link = localLink();
  links.set(link.id, link);
  return link;
}

/** The vault's configured targets, as last read. */
let vaultTargets: RemoteTarget[] = [];

/**
 * Bring the live link set in line with the configured remote targets.
 *
 * Called at boot and on every storage change. Targets that vanished (or were
 * disabled) are torn down here rather than left dangling: a target the user
 * removed must stop being dialled, and its sessions must go with it.
 */
export function reconcileRemoteLinks(targets: RemoteTarget[]): void {
  vaultTargets = targets;
  reconcileLinks();
}

function reconcileLinks(): void {
  const wanted = new Map<string, RemoteTarget>();
  for (const t of vaultTargets) {
    if (t.enabled) wanted.set(`remote:${t.id}`, t);
  }
  for (const link of [...links.values()]) {
    if (link.kind !== 'remote') continue;
    const target = wanted.get(link.id);
    // A URL or credential change is a different bridge, not the same one with
    // new details: drop the link so the new one handshakes from scratch. The
    // credential counts because a rotated token means the old socket is
    // authenticated as something the user has stopped meaning.
    const sameCredential =
      target !== undefined &&
      bridgeSubprotocols(target.token).join(',') === link.protocols.join(',');
    if (!target || target.url !== link.url || !sameCredential) removeLink(link);
  }
  for (const [id, target] of wanted) {
    if (links.has(id)) continue;
    links.set(id, remoteLink(target, bridgeSubprotocols(target.token)));
  }
  connect();
}

/**
 * Read the configured targets from the vault and reconcile onto them. The
 * vault, not `storage.local`: a content script can write the latter, and a
 * bridge this browser dials must be one the user configured (#252).
 */
export async function loadRemoteLinks(): Promise<void> {
  try {
    reconcileRemoteLinks(await loadRemoteTargets());
  } catch (e) {
    console.error('[fetchproxy] could not read remote bridge targets:', e);
  }
}

function removeLink(link: Link): void {
  link.closed = true;
  links.delete(link.id);
  teardownLink(link);
  try {
    link.ws?.close();
  } catch {
    /* already gone */
  }
  link.ws = null;
}

/**
 * Drop everything derived from one link's current connection: its sessions,
 * their scope grants, and their bindings. Sessions on other links are
 * deliberately untouched — this is the whole reason teardown became per-link.
 */
function teardownLink(link: Link): void {
  const dropped = unbindLink(link);
  for (const mcpId of dropped) {
    state.sessions?.remove(mcpId);
    clearSessionScopeFor(mcpId);
    if (state.trust) void syncMainWorldBridgeForActiveTrust(state.trust);
  }
  link.sessionNonce = null;
  if (dropped.length > 0) broadcastConnectionsChanged();
}

/**
 * Idempotent connect for every link. This is the keepalive's
 * `ensureConnected` — do not wrap it or give it parameters.
 */
export function connect(): void {
  if (!state.trust || !state.sessions || !state.extIdentity) return;
  ensureLocalLink();
  for (const link of links.values()) connectLink(link);
}

function connectLink(link: Link): void {
  if (link.closed) return;
  // Refused for good (4004): the keepalive tick must not re-dial it either.
  if (link.refusal !== null) return;
  if (!state.trust || !state.sessions || !state.extIdentity) return;
  if (Date.now() < link.nextAttemptAt) return;
  if (
    link.ws &&
    (link.ws.readyState === WebSocket.CONNECTING || link.ws.readyState === WebSocket.OPEN)
  ) {
    return;
  }
  let ws: WebSocket;
  try {
    ws =
      link.protocols.length > 0 ? new WebSocket(link.url, link.protocols) : new WebSocket(link.url);
  } catch (e) {
    // A malformed URL or subprotocol throws synchronously. There is no socket
    // to hang a close handler on, so schedule the retry here — the target may
    // be repaired in storage while this link keeps failing.
    console.error(`[fetchproxy] could not open ${link.label}:`, e);
    scheduleReconnect(link);
    return;
  }
  link.ws = ws;
  // Whether THIS socket ever opened: a close after an open is a change the
  // popup must hear about, a failed dial (still "not connected") is not.
  let wasOpen = false;
  ws.addEventListener('open', () => {
    if (!state.extIdentity || link.closed) return;
    wasOpen = true;
    link.reconnectAttempt = 0;
    link.nextAttemptAt = 0;
    link.notice = null;
    setConnectionStatus('connected');
    // Fresh per-LINK, per-connection nonce. The corresponding ready-frame
    // signature commits to (mcpHelloNonce || this nonce || the ephemeral pub),
    // so each connection on each link gets a fresh handshake — replaying a
    // captured ready frame against a future connection, or against the other
    // link, fails.
    const sessionNonce = new Uint8Array(32);
    (globalThis.crypto as Crypto).getRandomValues(sessionNonce);
    link.sessionNonce = sessionNonce;
    clearAccountAttestations(link);
    const extHello: HelloFrameFromExtension = {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      role: 'extension',
      // From the build's esbuild define, never a literal — see platform.ts.
      platform: currentPlatform(),
      extensionId: 'fetchproxy',
      version: chrome.runtime.getManifest().version,
      identityX25519Pub: toB64(state.extIdentity.x25519Pub),
      identityEd25519Pub: toB64(state.extIdentity.ed25519Pub),
      sessionNonce: toB64(sessionNonce),
      // B-BUG-9: host → extension notices this build understands. A host
      // sends `peer-gone` only to an extension that lists it.
      // Account identity frames are meaningful only on configured remote
      // credentials. Loopback's advertised contract stays unchanged.
      accepts:
        link.kind === 'remote'
          ? ['peer-gone', 'hello-rejected', ACCOUNT_KEY_FRAME, ACCOUNT_ATTEST_FRAME]
          : ['peer-gone'],
      // #418: what this browser cannot serve, found by runtime API detection,
      // so an MCP can refuse those verbs locally with a hint that blames the
      // browser. Sent on EVERY link, before any MCP hello: every published
      // validator ends the extension hello with `return raw`, so an MCP that
      // predates the field ignores it and an older host relays it intact.
      // The helper returns `{}` for an empty list, so a browser missing
      // nothing (Chrome) puts the same bytes on the wire as before. Unsigned
      // and advisory — the authority is `dispatch.ts`, which answers from its
      // own probe, never from anything on the wire.
      ...unavailableCapabilitiesHelloField(unavailableCapabilities(chrome)),
    };
    ws.send(JSON.stringify(extHello));
    // The link is up: tell any open popup, whose bridge row otherwise keeps
    // the "Offline" it rendered while this socket was still dialling. On
    // Safari that is the normal order of events, not a race: the popup's own
    // status query is what wakes the event page, so the first answer it gets
    // always describes a link that has not opened yet.
    broadcastConnectionsChanged();
  });
  ws.addEventListener('message', (ev: MessageEvent) => {
    void onMessage(link, ev.data as string).catch((e) =>
      console.error('[fetchproxy] onMessage:', e),
    );
  });
  ws.addEventListener('close', (ev: CloseEvent) => {
    teardownLink(link);
    const roomFull = link.kind === 'remote' && ev?.code === BROWSER_TAKEN_CLOSE;
    if (!roomFull) link.notice = null;
    // A link that was up is down: the popup's row must stop saying Connected.
    // Only after an open, so a target that keeps failing to dial does not
    // re-render an open popup on every retry.
    if (wasOpen) broadcastConnectionsChanged();
    if (
      link.kind === 'remote' &&
      (ev?.code === CREDENTIAL_REVOKED_CLOSE || ev?.code === EXTENSION_MISMATCH_CLOSE) &&
      link.tokenId
    ) {
      void accountTrust.deleteByToken(link.tokenId).catch((e) =>
        console.warn('[fetchproxy] could not remove revoked account trust:', e),
      );
      void clearAccountSessionApprovals(link.tokenId).catch((e) =>
        console.warn('[fetchproxy] could not clear revoked account session approvals:', e),
      );
    }
    if (!anyLinkOpen()) setConnectionStatus('disconnected');
    // 1008 on a remote link is the relay refusing this browser — a revoked or
    // wrong credential, or another browser already holding the account's
    // bridge. Say so once per close rather than letting it read as a network
    // blip in the retry log.
    if (link.kind === 'remote' && ev?.code === 1008) {
      console.warn(
        `[fetchproxy] ${link.label} refused this browser: ${ev.reason || 'no reason given'}`,
      );
    }
    // 4004 EXTENSION_MISMATCH: this credential is bound to a DIFFERENT
    // browser's identity (mcp-host spec §4.3). Final for this credential — a
    // binding never moves — so stop dialling it rather than retrying into the
    // same refusal forever, and say why in the popup. A new credential is a
    // new link and starts clean. Every other close, 4003 (revoked) included,
    // keeps the reconnect it always had.
    if (link.kind === 'remote' && ev?.code === EXTENSION_MISMATCH_CLOSE) {
      link.refusal = EXTENSION_MISMATCH_MESSAGE;
      console.warn(
        `[fetchproxy] ${link.label}: ${EXTENSION_MISMATCH_MESSAGE} — revoke this credential and pair this browser again`,
      );
      broadcastConnectionsChanged();
      return;
    }
    // 4001 BROWSER_TAKEN: the account's room has no place for this browser
    // (at its browser limit, or its one slot held elsewhere). Re-dialling at
    // the floor would only knock on a full room every second, so jump to the
    // slowest step (the room accepted the socket before closing it, so the
    // open above reset the backoff), and say why in the popup. Not final like
    // 4004: a browser disconnecting elsewhere frees a place.
    if (roomFull) {
      link.notice = browserTakenMessage(ev.reason);
      console.warn(`[fetchproxy] ${link.label}: ${link.notice}`);
      link.reconnectAttempt = REMOTE_RECONNECT_BACKOFF_MS.length - 1;
      scheduleReconnect(link);
      broadcastConnectionsChanged();
      return;
    }
    // 4005 ACCOUNT_CONFIRMED and 4006 FACTS_CHANGED (what the room knows about
    // this credential changed): not errors. The
    // next attach is the one that counts, so re-dial now rather than after a
    // backoff — once per spacing, so a room that kept closing is still dialled
    // at the backoff's pace. The re-dial leaves `reconnectAttempt` alone (only
    // a successful open resets it), so a room that keeps closing climbs the
    // backoff rather than sitting at its floor. Remote only: the loopback link
    // has no account.
    if (
      link.kind === 'remote' &&
      (ev?.code === ACCOUNT_CONFIRMED_CLOSE || ev?.code === FACTS_CHANGED_CLOSE)
    ) {
      const now = Date.now();
      if (now - link.lastImmediateRedialAt >= IMMEDIATE_REDIAL_SPACING_MS) {
        link.lastImmediateRedialAt = now;
        link.nextAttemptAt = 0;
        connectLink(link);
        return;
      }
    }
    scheduleReconnect(link);
  });
  ws.addEventListener('error', () => {
    /* close will follow */
  });
}

function scheduleReconnect(link: Link): void {
  if (link.closed) return;
  const table = link.kind === 'remote' ? REMOTE_RECONNECT_BACKOFF_MS : RECONNECT_BACKOFF_MS;
  const ms = table[Math.min(link.reconnectAttempt, table.length - 1)]!;
  link.reconnectAttempt++;
  link.nextAttemptAt = Date.now() + ms;
  setTimeout(() => connectLink(link), ms);
}

/**
 * A v3 MCP meeting this v4 extension (Task 4.1).
 *
 * `validateFrame` refuses a hello whose `protocolVersion` is not
 * {@link PROTOCOL_VERSION}, and until 3.0.0 that was the end of the story: the
 * frame was dropped with a `console.warn` in a service worker nobody has open,
 * and the MCP then waited out its 30-second `SESSION_READY_TIMEOUT_MS` before
 * reporting `not-ready` with a hint blaming a signed-out session or a changed
 * scope. A hang is the worst failure mode a version mismatch can have — the
 * person seeing it has nothing to act on and no reason to suspect a version —
 * and on a hosted relay, across a fleet whose pins move on a nightly cron,
 * that is the shape a v4 rollout would otherwise take.
 *
 * `hello-rejected` is the vehicle because it PREDATES the break: it landed in
 * 2.6.0, the cohort declares `accepts: ['hello-rejected']`, and the frame
 * carries no authority — a forged one can make a session fail, which a silent
 * peer could do anyway by never answering. So a v3 MCP needs no change at all
 * to hear this; only this side does.
 *
 * It GRANTS NOTHING, which is the contract `peekHelloVersion` is written to
 * and the reason this lives in the catch rather than anywhere a session could
 * be started from: no binding, no trust read or write, no counter, no session.
 * Every field it reads came out of a frame no validator accepted, so the
 * `mcpId` is used only to address the answer back down the socket it arrived
 * on and the `accepts` list only to decide whether to speak at all.
 *
 * Returns whether it answered FOR the mismatch — false leaves the caller on
 * the pre-existing silent-drop path, so the version mismatch is the only case
 * that gets new treatment and a malformed-frame flood is not a send amplifier.
 */
function refuseVersionMismatch(link: Link, raw: unknown): boolean {
  const peek = peekHelloVersion(raw);
  if (!peek || peek.protocolVersion === PROTOCOL_VERSION) return false;
  // No id, nothing to address an answer to — and nothing worth claiming a
  // version mismatch about either, since `peekHelloVersion` also answers for
  // an EXTENSION hello, which carries no `mcpId` by construction.
  if (!peek.mcpId) return false;
  const reason =
    `protocol version mismatch: this browser extension speaks fetchproxy protocol ` +
    `${PROTOCOL_VERSION}, this MCP speaks ${peek.protocolVersion} — upgrade ` +
    `@fetchproxy/server to >= ${MIN_SERVER_VERSION}`;
  // Said on this side whether or not it can be said on the wire: an MCP older
  // than 2.6.0 cannot hear `hello-rejected`, and the browser user still has
  // the console and the popup.
  console.warn(`[fetchproxy] refused hello for ${peek.mcpId} on ${link.label}: ${reason}`);
  sendHelloRejected(link, peek.mcpId, peek.accepts, reason);
  // Task 4.3: and to the person in front of the browser, who has neither the
  // wire nor that console. Written whether or not the frame above went out —
  // an MCP too old to hear `hello-rejected` is exactly when the popup is the
  // only surface left. Fire-and-forget: a popup line never fails a refusal.
  noteVersionMismatch(link, peek.mcpId, peek.protocolVersion);
  return true;
}

async function onMessage(link: Link, data: string): Promise<void> {
  if (!state.trust) return;
  if (link.closed) return;
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch (e) {
    console.warn('[fetchproxy] dropped malformed frame:', e);
    return;
  }
  // The local concentrator has no account identity. Drop these frame names
  // before validation so loopback never parses or acts on them.
  if (link.kind === 'local' && raw !== null && typeof raw === 'object') {
    const type = (raw as { type?: unknown }).type;
    if (type === ACCOUNT_KEY_FRAME || type === ACCOUNT_ATTEST_FRAME) return;
  }
  let frame: Frame;
  try {
    frame = validateFrame(raw);
  } catch (e) {
    if (!refuseVersionMismatch(link, raw)) {
      console.warn('[fetchproxy] dropped malformed frame:', e);
    }
    return;
  }
  if (frame.type === 'hello' && frame.role === 'server') {
    // Task 4.3: this hello passed `validateFrame`, which accepts a hello only
    // at PROTOCOL_VERSION — so it refutes any version complaint standing
    // against this server on this link, whatever the trust decision below
    // turns out to be. Hung off the hello rather than off the session for that
    // reason: a v4 hello that then fails on trust is a different complaint
    // with its own surfaces, and leaving a VERSION line up for it would be the
    // popup saying something untrue.
    forgetVersionMismatch(link, frame.mcpId);
    await onServerHello(link, frame);
  } else if (frame.type === 'frame') {
    await onEncryptedFrame(link, frame);
  } else if (frame.type === 'peer-gone') {
    onPeerGone(link, frame.mcpId);
  } else if (frame.type === ACCOUNT_KEY_FRAME) {
    await onAccountKey(link, frame);
  } else if (frame.type === ACCOUNT_ATTEST_FRAME) {
    storeAccountAttestation(link, frame as AccountAttestFrame);
  }
  // ready frames from the host shouldn't reach us; ignore.
}

const accountTrust = new AccountTrustStore();
const ACCOUNT_CARDS_KEY = 'pendingAccountCards';

export interface PendingAccountCard {
  key: string;
  linkId: string;
  tokenId: string;
  origin: string;
  account: AccountKeyFrame;
  keyChanged: boolean;
}

async function onAccountKey(link: Link, frame: AccountKeyFrame): Promise<void> {
  // The frame has passed the published protocol validator. It is still
  // advisory until its public-key fingerprint, token and live link match.
  if (link.kind !== 'remote' || !link.tokenId || frame.tokenId !== link.tokenId) return;
  const origin = gatewayOriginFor(link.url);
  if (!origin) return;
  if (
    link.connectApproved &&
    (!link.connectAccount ||
      link.connectAccount.slug !== frame.slug ||
      link.connectAccount.displayName !== frame.displayName)
  ) {
    console.warn(
      `[fetchproxy] refused account key that did not match the Connect result on ${link.label}`,
    );
    return;
  }
  const fingerprint = await accountKeyId(fromB64(frame.publicKey));
  if (fingerprint !== frame.kid) {
    console.warn(`[fetchproxy] refused account key with an invalid fingerprint on ${link.label}`);
    return;
  }
  const highWater = await accountTrust.getHighWater(origin, frame.accountId);
  if (frame.generation < highWater) {
    console.warn(
      `[fetchproxy] refused account key below its generation high-water mark on ${link.label}`,
    );
    return;
  }
  const existing = await accountTrust.get(origin, frame.accountId);
  const keyChanged =
    !!existing &&
    (frame.generation > existing.generation ||
      (frame.generation === existing.generation && frame.kid !== existing.kid));
  if (
    existing &&
    existing.tokenId === link.tokenId &&
    frame.generation === existing.generation &&
    frame.kid === existing.kid
  )
    return;

  const record: TrustedAccount = {
    origin,
    accountId: frame.accountId,
    slug: frame.slug,
    displayName: frame.displayName,
    tokenId: frame.tokenId,
    kid: frame.kid,
    publicKey: frame.publicKey,
    generation: frame.generation,
    generationHighWater: Math.max(highWater, frame.generation),
    approvedAt: Date.now(),
  };
  // A successful Connect was initiated by the extension click (the explicit
  // I-6 approval) and this frame names the account returned by that request.
  // This consent is specific to the newly-created token. Key changes still
  // require a fresh card approval.
  if (link.connectApproved && !keyChanged) {
    const consumed = await accountTrust.putApproved(record, link.targetId ?? '', true);
    if (consumed) {
      link.connectApproved = undefined;
      link.connectAccount = undefined;
      return;
    }
    const raced = await accountTrust.get(origin, frame.accountId);
    if (
      raced?.tokenId === link.tokenId &&
      raced.generation === frame.generation &&
      raced.kid === frame.kid
    )
      return;
  }

  const area = (
    globalThis as {
      chrome?: {
        storage?: {
          session?: {
            get: (k: string) => Promise<Record<string, unknown>>;
            set: (v: Record<string, unknown>) => Promise<void>;
          };
        };
      };
    }
  ).chrome?.storage?.session;
  if (!area) return;
  const key = `${link.id}:${frame.accountId}`;
  const stored = await area.get(ACCOUNT_CARDS_KEY);
  const cards =
    stored[ACCOUNT_CARDS_KEY] && typeof stored[ACCOUNT_CARDS_KEY] === 'object'
      ? { ...(stored[ACCOUNT_CARDS_KEY] as Record<string, PendingAccountCard>) }
      : {};
  cards[key] = { key, linkId: link.id, tokenId: link.tokenId, origin, account: frame, keyChanged };
  await area.set({ [ACCOUNT_CARDS_KEY]: cards });
  broadcastConnectionsChanged();
}

export async function decideAccountCard(key: unknown, approve: boolean): Promise<boolean> {
  if (typeof key !== 'string' || key.length > 256) return false;
  const area = (
    globalThis as {
      chrome?: {
        storage?: {
          session?: {
            get: (k: string) => Promise<Record<string, unknown>>;
            set: (v: Record<string, unknown>) => Promise<void>;
            remove: (k: string) => Promise<void>;
          };
        };
      };
    }
  ).chrome?.storage?.session;
  if (!area) return false;
  const stored = await area.get(ACCOUNT_CARDS_KEY);
  const cards =
    stored[ACCOUNT_CARDS_KEY] && typeof stored[ACCOUNT_CARDS_KEY] === 'object'
      ? { ...(stored[ACCOUNT_CARDS_KEY] as Record<string, PendingAccountCard>) }
      : {};
  const card = cards[key];
  if (!card || typeof card.linkId !== 'string' || typeof card.tokenId !== 'string') return false;
  delete cards[key];
  if (Object.keys(cards).length === 0) await area.remove(ACCOUNT_CARDS_KEY);
  else await area.set({ [ACCOUNT_CARDS_KEY]: cards });
  if (!approve) return true;

  const link = links.get(card.linkId);
  if (
    !link ||
    link.kind !== 'remote' ||
    link.ws?.readyState !== WebSocket.OPEN ||
    link.tokenId !== card.tokenId
  )
    return false;
  if (gatewayOriginFor(link.url) !== card.origin || card.account.tokenId !== card.tokenId)
    return false;
  const highWater = await accountTrust.getHighWater(card.origin, card.account.accountId);
  if (card.account.generation < highWater) return false;
  if ((await accountKeyId(fromB64(card.account.publicKey))) !== card.account.kid) return false;
  const saved = await accountTrust.putApproved({
    origin: card.origin,
    accountId: card.account.accountId,
    slug: card.account.slug,
    displayName: card.account.displayName,
    tokenId: card.tokenId,
    kid: card.account.kid,
    publicKey: card.account.publicKey,
    generation: card.account.generation,
    generationHighWater: Math.max(highWater, card.account.generation),
    approvedAt: Date.now(),
  }, link.targetId ?? '');
  if (saved) {
    await clearAccountSessionApprovals(card.tokenId, card.origin, card.account.accountId);
    link.connectApproved = undefined;
    link.connectAccount = undefined;
    broadcastConnectionsChanged();
  }
  return saved;
}

/**
 * B-BUG-9: the host says a peer MCP's socket closed. Drop everything this
 * extension holds for that mcpId — session key, scope grants, link binding —
 * as `teardownLink` does for a whole link. Without it every short-lived peer
 * (a bootstrap lift, an `fpx` call; each has a fresh mcpId) left a session
 * behind for the life of the link, and the popup showed it as connected.
 *
 * Only for an mcpId bound to THIS link: a link speaks for its own MCPs and
 * nobody else's, the same routing rule `onEncryptedFrame` applies.
 */
function onPeerGone(link: Link, mcpId: string): void {
  if (linkForMcp(mcpId) !== link) return;
  unbindMcp(mcpId, link);
  state.sessions?.remove(mcpId);
  clearSessionScopeFor(mcpId);
  if (state.trust) void syncMainWorldBridgeForActiveTrust(state.trust);
  broadcastConnectionsChanged();
}

async function onEncryptedFrame(link: Link, frame: EncryptedFrame): Promise<void> {
  if (!state.sessions) return;
  // Routing before crypto: an mcpId bound to another link is not this link's
  // to speak for, whatever it can or cannot decrypt.
  if (linkForMcp(frame.mcpId) !== link) return;
  const entry = state.sessions.get(frame.mcpId);
  if (!entry) return;
  // Claimed SYNCHRONOUSLY, before any await. `onMessage` is dispatched
  // fire-and-forget, so two copies of one frame delivered in a single read run
  // concurrently: a gate that only ASKED whether the seq was fresh answered
  // yes to both, because nothing moves the counter until the open returns.
  // Here that is not a wedge but a double EXECUTION — a duplicated
  // `write_cookies` or non-GET `fetch` reaches `handleRequest` twice, and
  // `handlers/dispatch.ts` has no per-id guard of its own. The claim takes the
  // seq out of circulation now, so the second copy is refused as a replay.
  const claim = entry.claimInboundSeq(frame.seq);
  // A replay is dropped silently. Saturation is not a replay — it drops frames
  // that may be genuine requests — so it is said out loud, but once per run of
  // it: the entry latches the warning until an 'ok' claim shows the set has
  // drained (#376).
  if (entry.saturationWarningDue(claim)) {
    console.warn(
      `[fetchproxy] dropped an inbound frame from ${frame.mcpId} (seq ${frame.seq}) unread — ` +
        `too many of its frames are still being opened (inbound claims saturated). Not a replay. ` +
        `Further drops are not logged until the in-flight set drains.`,
    );
  }
  if (claim !== 'ok') return;
  flashActivity();
  let opened;
  try {
    // 's2e': every frame reaching the extension was sealed by an MCP.
    opened = await openEncryptedFrameDetailed(entry.sessionKey, frame, 's2e');
  } catch (e) {
    // It reports both failures in its result rather than throwing, so this is
    // the unexpected path — but a claim must not leak out of it.
    entry.releaseInboundSeq(frame.seq);
    throw e;
  }
  // The counter moves for a frame that AUTHENTICATED, which is every outcome
  // except `decrypt-failed`; that one gives the claim back instead, spending
  // nothing. Advancing on the way IN meant anything able to
  // reach this socket could name a seq without holding the key, and every
  // genuine frame after it — all carrying lower numbers — was dropped as a
  // replay while the socket stayed open and looked healthy. Advancing only on
  // `ok` is the same bug from the other side: a frame that decrypted under the
  // live session key was sent by whoever holds that key, so its seq is spent
  // whatever the plaintext then turns out to be, and leaving the counter
  // behind leaves that seq replayable. `peer.ts` states and implements exactly
  // this rule; the two ends of the same session must not disagree about which
  // frames are still accepted.
  if (opened.stage !== 'decrypt-failed') entry.commitInboundSeq(frame.seq);
  else entry.releaseInboundSeq(frame.seq);
  if (opened.stage === 'decrypt-failed') {
    // Typically a straggler from a session that already rotated (the MCP
    // reconnected mid-flight). Nothing about the plaintext can be trusted —
    // drop it quietly, the next frame on the live key will land.
    console.warn('[fetchproxy] decrypt failed:', opened.error);
    return;
  }
  if (opened.stage === 'validation-failed') {
    // Decryption SUCCEEDED, so this really is the live MCP on the other end
    // and the malformed plaintext is a protocol bug rather than a stale-key
    // symptom. Say so on its own channel rather than in the warn bucket every
    // straggler lands in. No synthetic reply goes back: the extension is the
    // RESPONDER here, so there is no pending call of ours to fail — the MCP's
    // own request timeout is what covers a request we could not read.
    console.error(
      '[fetchproxy] received a frame that decrypted OK but failed validation:',
      opened.error,
    );
    return;
  }
  const inner: InnerFrame = opened.inner;
  if (inner.type === 'ping') {
    await sendInner(frame.mcpId, { type: 'pong' });
  } else if (inner.type === 'request') {
    await handleRequest(frame.mcpId, inner);
  }
  // pong + response from server: ignore (we don't ping or request inward yet).
}
