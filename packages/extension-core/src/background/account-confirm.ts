/**
 * "Confirm this browser" — asking the gateway to mark a remote link's
 * credential ACCOUNT-CONFIRMED, so the account's host-managed pin sets admit
 * this browser's key (mcp-host plan task C3, cut as C3a for the managed-pin
 * slice D4; spec §4.4, decisions D2 and D11, invariant I-7). The wire and why
 * the result must travel back are in `../account-confirm.ts`.
 *
 * The person asks in the popup ({@link beginAccountConfirm}); nothing starts
 * a confirmation on its own. Then:
 *
 * - **Safari inside ContextMint, for the credential ContextMint handed over**:
 *   `sendNativeMessage({type:"account-confirm", tokenId, extFingerprint, ts,
 *   sig})` (hand-off contract v1.1) and the app confirms the credential it
 *   minted, with its own session. No challenge crosses. Anything but
 *   `{ok:true}` — a rejection, `unknown-request` from an app older than v1.1
 *   — falls back to the tab flow.
 * - **Everywhere else, the tab flow**: a signed `start`, then the challenge
 *   URL opens in a tab whose id is RECORDED. The confirm page, once the
 *   creator's session approves, posts a one-time completion to its own
 *   window; the content script relays it ({@link onConfirmCompletion}); and
 *   it is accepted ONLY when the browser says it came from that tab, from
 *   the top frame, on the link's gateway origin, on the confirm page — once,
 *   within the gateway's ten minutes. Then `finish`, signed by the bound key.
 *   There is no field anywhere that takes a completion or a challenge from
 *   the person: a forwarded link gets a phisher a completion in THEIR
 *   browser, which this extension never receives (red-team R4-3).
 *
 * The recorded tab lives in `storage.session` (content scripts cannot read or
 * write it; an MV3 worker or Safari event page may be unloaded while the
 * person signs in), and holds no credential — only the tab id, the link id,
 * the origin, the credential's public id, its SHA-256 and an expiry. The
 * credential is read from the live link at `finish`, which must still carry
 * the same credential the start was signed for.
 *
 * WHAT THIS DOES NOT DO: write trust. No `trustedMcps`, no account record, no
 * scope — it changes which browser the gateway's pin sets admit, and nothing
 * this extension decides. `link.confirm` is display state for the popup.
 */

import {
  CONFIRM_PAGE_PATH,
  CONFIRM_TTL_MS,
  appConfirmRequest,
  finishAccountConfirm,
  isConfirmSecret,
  startAccountConfirm,
} from '../account-confirm.js';
import { ACCOUNT_CONFIRM_COMPLETION } from '../account-confirm-relay.js';
import { gatewayOriginFor } from '../bridge-binding.js';
import { credentialKey } from '../bridge-bind-store.js';
import {
  CONTEXTMINT_APP_ID,
  nativeMessagingRuntime,
  type NativeMessagingRuntime,
} from '../native-handoff.js';

import { links, isConfirmable, type ConfirmState, type Link } from './links.js';
import { broadcastConnectionsChanged } from './session-scope.js';
import { state } from './state.js';

/** The popup's request to start. Honoured only from an extension page. */
export const ACCOUNT_CONFIRM_BEGIN = 'account-confirm-begin';

/** The `storage.session` key of the recorded confirm tabs. */
export const PENDING_CONFIRM_KEY = 'accountConfirmPending';

/** One confirm tab this extension opened. No credential — only its SHA-256. */
interface PendingConfirm {
  tabId: number;
  linkId: string;
  origin: string;
  tokenId: string;
  /** `credentialKey` of the credential the start was signed for. */
  credentialHash: string;
  expiresAt: number;
}

export type BeginResult = { ok: true; via: 'tab' | 'app' } | { ok: false; reason: string };

export interface AccountConfirmDeps {
  /** Epoch ms. */
  now: () => number;
  /** Open `url` in a new tab and answer its id. */
  openTab: (url: string) => Promise<number | undefined>;
  /** The runtime that reaches ContextMint, or null (Chrome). */
  nativeRuntime: () => NativeMessagingRuntime | null;
}

interface TabsCreate {
  tabs?: { create?: (props: { url: string }) => Promise<{ id?: number }> };
}

const defaultDeps: AccountConfirmDeps = {
  now: () => Date.now(),
  openTab: async (url) => {
    const c = (globalThis as { chrome?: TabsCreate }).chrome;
    if (typeof c?.tabs?.create !== 'function') return undefined;
    return (await c.tabs.create({ url }))?.id;
  },
  nativeRuntime: () => nativeMessagingRuntime(),
};

/** What the browser says about a runtime message's sender. Only it may speak to these. */
export interface MessageSenderLike {
  tab?: { id?: number };
  frameId?: number;
  url?: string;
  origin?: string;
}

// ---------------------------------------------------------------------------
// The recorded tabs: storage.session when there is one, else this worker's
// memory (a restart then forgets the tab, and the person starts again).

interface SessionArea {
  get: (k: string) => Promise<Record<string, unknown>>;
  set: (kv: Record<string, unknown>) => Promise<void>;
}

function sessionArea(): SessionArea | null {
  const c = (globalThis as { chrome?: { storage?: { session?: SessionArea } } }).chrome;
  const area = c?.storage?.session;
  return area && typeof area.get === 'function' && typeof area.set === 'function' ? area : null;
}

let memoryPending: Record<string, PendingConfirm> = {};

function isPending(v: unknown): v is PendingConfirm {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.tabId === 'number' &&
    typeof p.linkId === 'string' &&
    typeof p.origin === 'string' &&
    typeof p.tokenId === 'string' &&
    typeof p.credentialHash === 'string' &&
    typeof p.expiresAt === 'number'
  );
}

async function readPending(): Promise<Record<string, PendingConfirm>> {
  const area = sessionArea();
  if (!area) return { ...memoryPending };
  const raw = (await area.get(PENDING_CONFIRM_KEY))[PENDING_CONFIRM_KEY];
  const out: Record<string, PendingConfirm> = {};
  if (typeof raw === 'object' && raw !== null) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (isPending(v) && String(v.tabId) === k) out[k] = v;
    }
  }
  return out;
}

async function writePending(next: Record<string, PendingConfirm>): Promise<void> {
  const area = sessionArea();
  if (!area) {
    memoryPending = { ...next };
    return;
  }
  await area.set({ [PENDING_CONFIRM_KEY]: next });
}

// ---------------------------------------------------------------------------

function show(link: Link, confirm: ConfirmState): void {
  link.confirm = confirm;
  broadcastConnectionsChanged();
}

function failed(link: Link | null, reason: string): BeginResult {
  if (link) show(link, { phase: 'failed', message: reason });
  return { ok: false, reason };
}

/** Is `link` still the live link, with the credential it had? */
function stillCurrent(link: Link, tokenId: string): boolean {
  return links.get(link.id) === link && !link.closed && link.credentialId === tokenId;
}

/**
 * Start confirming the link `linkId` for its account. Called for the popup's
 * {@link ACCOUNT_CONFIRM_BEGIN} — the person's own request — and nothing else.
 */
export async function beginAccountConfirm(
  linkId: string,
  deps: AccountConfirmDeps = defaultDeps,
): Promise<BeginResult> {
  const link = links.get(linkId);
  // Remote only: the loopback link has no account and nothing to confirm.
  if (!link || !isConfirmable(link))
    return failed(null, 'this bridge cannot be confirmed from here');
  const identity = state.extIdentity;
  const origin = gatewayOriginFor(link.url);
  const tokenId = link.credentialId!;
  const credential = link.credential!;
  if (!identity || !origin) return failed(link, 'this bridge cannot be confirmed from here');
  const nowSeconds = Math.floor(deps.now() / 1000);

  // Safari inside ContextMint: the app confirms the credential it minted —
  // which is only ever the handed-off one, so only that one is offered to it.
  const runtime = link.handoff ? deps.nativeRuntime() : null;
  if (runtime) {
    let answer: unknown;
    try {
      const request = await appConfirmRequest(identity, origin, tokenId, nowSeconds);
      // Called ON the runtime: Safari's methods need their receiver.
      answer = await runtime.sendNativeMessage(CONTEXTMINT_APP_ID, request);
    } catch {
      answer = undefined; // no handler: fall back to the tab flow
    }
    if (typeof answer === 'object' && answer !== null && (answer as { ok?: unknown }).ok === true) {
      if (!stillCurrent(link, tokenId)) return failed(null, 'this bridge changed; try again');
      show(link, { phase: 'app' });
      return { ok: true, via: 'app' };
    }
  }

  const started = await startAccountConfirm(identity, link.url, tokenId, credential, nowSeconds);
  if (!started.ok) return failed(link, started.reason);
  if (!stillCurrent(link, tokenId)) return failed(null, 'this bridge changed; try again');
  let tabId: number | undefined;
  try {
    tabId = await deps.openTab(started.challengeUrl);
  } catch {
    tabId = undefined;
  }
  if (typeof tabId !== 'number') return failed(link, 'could not open the confirmation page');

  // One confirm tab per link: the gateway supersedes an earlier challenge on
  // a new start, so the tab it was opened in is forgotten too.
  const pending = await readPending();
  for (const [k, p] of Object.entries(pending)) {
    if (p.linkId === link.id || p.expiresAt <= deps.now()) delete pending[k];
  }
  pending[String(tabId)] = {
    tabId,
    linkId: link.id,
    origin,
    tokenId,
    credentialHash: await credentialKey(credential),
    expiresAt: deps.now() + CONFIRM_TTL_MS,
  };
  await writePending(pending);
  show(link, { phase: 'tab' });
  return { ok: true, via: 'tab' };
}

/**
 * The origin and path the sender was on, from what the BROWSER reported —
 * never from the message. `sender.origin` (Chrome) and `sender.url` must
 * agree when both are present.
 */
function senderPage(sender: MessageSenderLike): { origin: string; path: string } | null {
  if (typeof sender.url !== 'string') return null;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return null;
  }
  if (sender.origin !== undefined && sender.origin !== url.origin) return null;
  return { origin: url.origin, path: url.pathname };
}

/**
 * A completion the content script relayed. Finishes the confirmation only when
 * it came from the tab this extension opened for it (`sender.tab.id`), from
 * the top frame, on the link's gateway origin and the confirm page, within the
 * ten minutes — and only once. Anything else is dropped without spending the
 * recorded tab. Answers whether the gateway confirmed.
 */
export async function onConfirmCompletion(
  msg: unknown,
  sender: MessageSenderLike | undefined,
  deps: AccountConfirmDeps = defaultDeps,
): Promise<boolean> {
  if (typeof msg !== 'object' || msg === null) return false;
  const { type, completion } = msg as { type?: unknown; completion?: unknown };
  if (type !== ACCOUNT_CONFIRM_COMPLETION || !isConfirmSecret(completion)) return false;
  const tabId = sender?.tab?.id;
  if (typeof tabId !== 'number') return false;
  if (sender!.frameId !== undefined && sender!.frameId !== 0) return false;

  const pending = await readPending();
  const entry = pending[String(tabId)];
  if (!entry || entry.tabId !== tabId) return false;
  if (entry.expiresAt <= deps.now()) {
    delete pending[String(tabId)];
    await writePending(pending);
    return false;
  }
  const page = senderPage(sender!);
  if (!page || page.origin !== entry.origin || page.path !== CONFIRM_PAGE_PATH) return false;

  // Single use: forgotten BEFORE finish, so a second copy finishes nothing.
  delete pending[String(tabId)];
  await writePending(pending);

  const link = links.get(entry.linkId);
  const identity = state.extIdentity;
  if (
    !link ||
    !identity ||
    link.closed ||
    link.credential === null ||
    link.credentialId !== entry.tokenId ||
    gatewayOriginFor(link.url) !== entry.origin ||
    (await credentialKey(link.credential)) !== entry.credentialHash
  ) {
    return false;
  }
  show(link, { phase: 'finishing' });
  const finished = await finishAccountConfirm(
    identity,
    link.url,
    entry.tokenId,
    link.credential,
    completion,
  );
  if (!finished.ok) {
    console.warn(`[fetchproxy] ${link.label}: this browser was not confirmed: ${finished.reason}`);
    show(link, { phase: 'failed', message: finished.reason });
    return false;
  }
  show(link, { phase: 'confirmed' });
  return true;
}
