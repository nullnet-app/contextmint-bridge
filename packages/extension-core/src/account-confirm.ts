/**
 * Confirming THIS browser for its account — the extension half of mcp-host's
 * account confirmation (mcp-host
 * docs/superpowers/specs/2026-09-27-account-level-bridge-pairing-design.md
 * §4.4, decisions D2 and D11, invariant I-7; plan task C3, cut as C3a for the
 * managed-pin slice, D4).
 *
 * A pairing code, a pasted credential and a hand-off each DELIVER a
 * credential. None of them confirms one, because the code could be an
 * attacker's (phishing). A bound credential becomes account-confirmed — and
 * so admissible to a host-managed pin set — only when a signed-in session of
 * its CREATOR approves it AND the approval's result comes back to the BOUND
 * extension, which proves receipt by signing with its non-extractable key:
 *
 * ```
 * extension ── POST <origin>/bridge/account-confirm/start {ts, sig} ──> gateway
 *   sig = Ed25519(bound, "mcp-host/bridge-confirm/v1" NUL origin NUL tokenId NUL decimal(ts))
 *   <── {challengeUrl: "<origin>/bridge/confirm#<challenge>"}
 * extension opens that URL in a tab and records the tab's id
 * page (creator's session) mints a one-time COMPLETION and posts it to its own window
 * content script (same tab, gateway origin) relays it to the background
 * extension ── POST <origin>/bridge/account-confirm/finish {completion, sig} ──> gateway
 *   sig = Ed25519(bound, "mcp-host/bridge-confirm-finish/v1" NUL origin NUL tokenId NUL completion)
 *   → confirmed; the room closes this browser 4005 ACCOUNT_CONFIRMED, and it re-dials
 * ```
 *
 * Safari inside ContextMint has a second door (D11): the extension signs
 * `"mcp-host/bridge-confirm-app/v1" NUL origin NUL tokenId NUL decimal(ts)`
 * and hands `{type:"account-confirm", tokenId, extFingerprint, ts, sig}` to
 * the app, which confirms the credential IT minted with its own session. That
 * message carries NO challenge (red-team R4-7) — every field is public.
 *
 * `origin` is always the gateway the extension already DIALS, derived from the
 * bridge URL (`gatewayOriginFor`) — never from anything a server answered —
 * and the gateway checks it against its own configured origin.
 *
 * WHAT THIS DOES NOT DO. Confirming grants this extension nothing: no trust
 * record, no account record, no scope. It lets the account's pin sets admit
 * this browser's key. Nothing here reads, writes or widens trust.
 *
 * Everything here is total: a network failure, a malformed answer, a URL that
 * is not a bridge URL — each is an outcome, never a throw.
 */

import { toB64 } from '@fetchproxy/protocol';

import { gatewayOriginFor, post, readJson } from './bridge-binding.js';
import { signWithExtensionIdentity, type ExtensionIdentity } from './extension-identity.js';
import { isBridgeTokenId, validateRemoteTargetToken } from './remote-targets.js';

/** Domain separation for the start signature; the gateway's constant. */
export const BRIDGE_CONFIRM_START_CONTEXT = 'mcp-host/bridge-confirm/v1';
/** Domain separation for the finish signature; distinct, so one never passes as the other. */
export const BRIDGE_CONFIRM_FINISH_CONTEXT = 'mcp-host/bridge-confirm-finish/v1';
/** Domain separation for the ContextMint app route's signature (D11). */
export const BRIDGE_CONFIRM_APP_CONTEXT = 'mcp-host/bridge-confirm-app/v1';

/**
 * The `type` of the `window.postMessage` the gateway's confirm page sends its
 * own tab with the completion. The content script relays only this.
 */
export const BRIDGE_CONFIRM_MESSAGE_TYPE = 'mcp-host/bridge-account-confirm/v1';

/** The confirm page's path on the gateway. The completion is taken only from it. */
export const CONFIRM_PAGE_PATH = '/bridge/confirm';

/**
 * The room's close after this credential was confirmed (mcp-host
 * `BRIDGE_CLOSE.ACCOUNT_CONFIRMED`): re-dial at once, the next attach is
 * confirmed. Not an error.
 */
export const ACCOUNT_CONFIRMED_CLOSE = 4005;

/**
 * The room's close when the facts behind this credential changed (mcp-host
 * `FACTS_CHANGED`, spec §4.6.5): re-dial at once. Not an error.
 */
export const FACTS_CHANGED_CLOSE = 4006;

/** How long a challenge or a completion lives at the gateway. */
export const CONFIRM_TTL_MS = 10 * 60 * 1000;

function encode(parts: string[]): Uint8Array {
  return new TextEncoder().encode(parts.join('\0'));
}

/** The exact bytes signed to ask for a challenge. `ts` is Unix seconds. */
export function bridgeConfirmStartMessage(origin: string, tokenId: string, ts: number): Uint8Array {
  return encode([BRIDGE_CONFIRM_START_CONTEXT, origin, tokenId, String(ts)]);
}

/** The exact bytes signed to hand back a completion. */
export function bridgeConfirmFinishMessage(
  origin: string,
  tokenId: string,
  completion: string,
): Uint8Array {
  return encode([BRIDGE_CONFIRM_FINISH_CONTEXT, origin, tokenId, completion]);
}

/** The exact bytes signed for the ContextMint app to confirm the credential. */
export function bridgeConfirmAppMessage(origin: string, tokenId: string, ts: number): Uint8Array {
  return encode([BRIDGE_CONFIRM_APP_CONTEXT, origin, tokenId, String(ts)]);
}

/** A challenge or completion as the gateway mints one: 128 bits, base64url, unpadded. */
export function isConfirmSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value);
}

/**
 * The gateway's fingerprint of this extension: the first 8 bytes of
 * sha256(raw X25519 public key), lowercase hex. The confirm page shows it,
 * so the person can check the page is about THIS browser.
 */
export async function extensionKeyFingerprint(x25519Pub: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', x25519Pub as Uint8Array<ArrayBuffer>),
  );
  return [...digest.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * `url` if it is exactly `<origin>/bridge/confirm#<challenge>`, else null.
 * The extension opens only that: a start answer pointing anywhere else —
 * another host, another path, a query, credentials in the URL — opens nothing.
 */
export function confirmChallengeUrl(origin: string, url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== origin) return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.pathname !== CONFIRM_PAGE_PATH || parsed.search !== '') return null;
  if (!isConfirmSecret(parsed.hash.slice(1))) return null;
  return `${origin}${CONFIRM_PAGE_PATH}${parsed.hash}`;
}

export type ConfirmStartResult = { ok: true; challengeUrl: string } | { ok: false; reason: string };
export type ConfirmFinishResult = { ok: true } | { ok: false; reason: string };

function usable(bridgeUrl: string, tokenId: string, token: string): string | null {
  const origin = gatewayOriginFor(bridgeUrl);
  if (!origin || !isBridgeTokenId(tokenId) || !validateRemoteTargetToken(token).ok) return null;
  return origin;
}

function failure(
  response: Response,
  body: Record<string, unknown> | null,
): { ok: false; reason: string } {
  return {
    ok: false,
    reason: body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`,
  };
}

/**
 * `POST /bridge/account-confirm/start` at the bridge URL's own gateway, with
 * the credential as bearer and the bound key's signature. Answers the
 * challenge URL to open, checked by {@link confirmChallengeUrl}.
 */
export async function startAccountConfirm(
  identity: ExtensionIdentity,
  bridgeUrl: string,
  tokenId: string,
  token: string,
  nowSeconds: number,
): Promise<ConfirmStartResult> {
  const origin = usable(bridgeUrl, tokenId, token);
  if (!origin) return { ok: false, reason: 'this bridge cannot be confirmed from here' };
  const ts = Math.floor(nowSeconds);
  let response: Response;
  try {
    const sig = await signWithExtensionIdentity(
      identity,
      bridgeConfirmStartMessage(origin, tokenId, ts),
    );
    response = await post(
      `${origin}/bridge/account-confirm/start`,
      { ts, sig: toB64(sig) },
      { authorization: `Bearer ${token}` },
    );
  } catch (e) {
    return {
      ok: false,
      reason: `could not reach ${origin}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const body = await readJson(response);
  if (!response.ok) return failure(response, body);
  const challengeUrl = confirmChallengeUrl(origin, body?.challengeUrl);
  if (!challengeUrl) {
    return { ok: false, reason: `the gateway answered with a page that is not on ${origin}` };
  }
  return { ok: true, challengeUrl };
}

/**
 * `POST /bridge/account-confirm/finish` with the completion the confirm page
 * handed back, signed by the bound key. The ONLY browser-side call that
 * confirms. Confirmed only on a 200 that says so.
 */
export async function finishAccountConfirm(
  identity: ExtensionIdentity,
  bridgeUrl: string,
  tokenId: string,
  token: string,
  completion: string,
): Promise<ConfirmFinishResult> {
  const origin = usable(bridgeUrl, tokenId, token);
  if (!origin || !isConfirmSecret(completion)) {
    return { ok: false, reason: 'this bridge cannot be confirmed from here' };
  }
  let response: Response;
  try {
    const sig = await signWithExtensionIdentity(
      identity,
      bridgeConfirmFinishMessage(origin, tokenId, completion),
    );
    response = await post(
      `${origin}/bridge/account-confirm/finish`,
      { completion, sig: toB64(sig) },
      { authorization: `Bearer ${token}` },
    );
  } catch (e) {
    return {
      ok: false,
      reason: `could not reach ${origin}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const body = await readJson(response);
  if (!response.ok) return failure(response, body);
  if (body?.accountConfirmed !== true) {
    return { ok: false, reason: 'the gateway did not confirm this browser' };
  }
  return { ok: true };
}

/** The ContextMint hand-off v1.1 request. Every field is public; there is no challenge. */
export interface AppConfirmRequest {
  type: 'account-confirm';
  tokenId: string;
  extFingerprint: string;
  ts: number;
  sig: string;
}

/**
 * The native message asking ContextMint to confirm the credential it minted
 * (D11). Made only when the person asks for it in the extension: the
 * signature is what stops a phisher — who IS the credential's creator and can
 * read the public fingerprint — confirming this browser from their own machine.
 */
export async function appConfirmRequest(
  identity: ExtensionIdentity,
  origin: string,
  tokenId: string,
  nowSeconds: number,
): Promise<AppConfirmRequest> {
  const ts = Math.floor(nowSeconds);
  const sig = await signWithExtensionIdentity(
    identity,
    bridgeConfirmAppMessage(origin, tokenId, ts),
  );
  return {
    type: 'account-confirm',
    tokenId,
    extFingerprint: await extensionKeyFingerprint(identity.x25519Pub),
    ts,
    sig: toB64(sig),
  };
}
