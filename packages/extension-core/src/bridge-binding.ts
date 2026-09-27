/**
 * Binding a bridge credential to THIS extension's identity — the extension
 * half of mcp-host's "pair once" (mcp-host
 * docs/superpowers/specs/2026-09-27-account-level-bridge-pairing-design.md
 * §4.3, plan task C2, invariant I-13).
 *
 * An mcp-host `mcpb_*` bridge credential is a bearer: whoever holds it could
 * attach THEIR browser whenever this one was away. A BOUND credential names
 * this extension's long-term identity — the same `identityX25519Pub` /
 * `identityEd25519Pub` every extension hello carries — and the gateway's room
 * closes any other hello with `4004 EXTENSION_MISMATCH`.
 *
 * Two ways a credential gets bound, both signed by the vault's
 * NON-EXTRACTABLE Ed25519 key (`signWithExtensionIdentity`):
 *
 * - **at redeem** — a pairing code traded for a credential carries an
 *   `extension` block, and the gateway creates the credential bound in the
 *   same write that spends the code ({@link redeemPairingCode});
 * - **after the fact** — a pasted or ContextMint-handed-off credential binds
 *   itself with `POST /bridge/bind` on its first successful attach
 *   ({@link bindCredential}; `background/bind-on-connect.ts` decides when).
 *
 * The signed message, spelled exactly as the gateway verifies it:
 *
 * ```
 * "mcp-host/bridge-bind/v1" NUL origin NUL subject NUL b64(x25519Pub) NUL b64(ed25519Pub)
 * ```
 *
 * - `origin` is the gateway this extension is about to DIAL, derived from the
 *   bridge URL ({@link gatewayOriginFor}) — never from anything a server
 *   answered. The gateway checks it against its own configured origin, so a
 *   body captured on its way to one deployment binds nothing at another.
 * - `subject` is the pairing code exactly as sent (redeem), or the
 *   credential's `brt_*` id (`/bridge/bind`), so a captured body cannot be
 *   moved to another code or another credential.
 *
 * WHAT THIS DOES NOT DO. Binding is not admission (spec §4.3): it narrows what
 * a credential admits from "any browser" to "this one", and grants this
 * extension nothing anywhere. Nothing here reads, writes or widens trust.
 *
 * Everything here is total: a network failure, a malformed answer, a URL that
 * is not a bridge URL — each is an outcome, never a throw.
 */

import { toB64 } from '@fetchproxy/protocol';

import { signWithExtensionIdentity, type ExtensionIdentity } from './extension-identity.js';
import {
  isBridgeTokenId,
  validateRemoteTargetToken,
  validateRemoteTargetUrl,
} from './remote-targets.js';

export { isBridgeTokenId };

/** Domain separation for the bind signature; the gateway's constant. */
export const BRIDGE_BIND_CONTEXT = 'mcp-host/bridge-bind/v1';

/**
 * The room's close code for a hello whose identity keys are not the ones the
 * credential is bound to (mcp-host `BRIDGE_CLOSE.EXTENSION_MISMATCH`).
 */
export const EXTENSION_MISMATCH_CLOSE = 4004;

/** What the popup says about a bridge that closed {@link EXTENSION_MISMATCH_CLOSE}. */
export const EXTENSION_MISMATCH_MESSAGE = 'This bridge is paired with a different browser';

/** How long one gateway call may take before it is an outcome of its own. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The exact bytes signed. One spelling, the gateway's. */
export function bridgeBindMessage(
  origin: string,
  subject: string,
  x25519Pub: string,
  ed25519Pub: string,
): Uint8Array {
  return new TextEncoder().encode(
    [BRIDGE_BIND_CONTEXT, origin, subject, x25519Pub, ed25519Pub].join('\0'),
  );
}

/**
 * The gateway origin behind a bridge URL: `wss://host/bridge` → `https://host`,
 * and `ws://` → `http://` only for the loopback hosts a remote target may use
 * plain `ws://` for. Null for anything a remote target could not be — so the
 * credential is only ever sent where the extension already sends it.
 */
export function gatewayOriginFor(bridgeUrl: string): string | null {
  if (!validateRemoteTargetUrl(bridgeUrl).ok) return null;
  const url = new URL(bridgeUrl);
  const scheme = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : null;
  if (!scheme) return null;
  return `${scheme}//${url.host}`;
}

/** Is `origin` a bare gateway origin (scheme://host[:port], nothing else)? */
function isGatewayOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  const ws = `${url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : 'x:'}//${url.host}/`;
  return gatewayOriginFor(ws) === origin;
}

export interface SignedExtensionBinding {
  x25519Pub: string;
  ed25519Pub: string;
  sig: string;
}

/** This extension's two identity keys and its signature over `origin` and `subject`. */
export async function signExtensionBinding(
  identity: ExtensionIdentity,
  origin: string,
  subject: string,
): Promise<SignedExtensionBinding> {
  // The same spelling the extension hello uses (`socket.ts`), so the keys the
  // room later compares against the hello are these bytes.
  const x25519Pub = toB64(identity.x25519Pub);
  const ed25519Pub = toB64(identity.ed25519Pub);
  const sig = await signWithExtensionIdentity(
    identity,
    bridgeBindMessage(origin, subject, x25519Pub, ed25519Pub),
  );
  return { x25519Pub, ed25519Pub, sig: toB64(sig) };
}

/** The redemption body: the code as typed, and this extension's signed keys. */
export async function redeemRequestBody(
  identity: ExtensionIdentity,
  origin: string,
  code: string,
): Promise<{ code: string; extension: SignedExtensionBinding }> {
  return { code, extension: await signExtensionBinding(identity, origin, code) };
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const timeout = (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout?.(
    REQUEST_TIMEOUT_MS,
  );
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    // A redirect is never followed: the signature names THIS origin, and the
    // bearer must not be carried to wherever a server points.
    redirect: 'error',
    credentials: 'omit',
    cache: 'no-store',
    ...(timeout ? { signal: timeout } : {}),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A credential a redemption produced, in the shape a remote target stores. */
export interface RedeemedTarget {
  url: string;
  token: string;
  tokenId: string;
  label?: string;
}

export type RedeemResult =
  { ok: true; target: RedeemedTarget; bound: boolean } | { ok: false; reason: string };

/**
 * Trade a pairing code for a credential at `origin`, bound to this extension
 * in the same write (`POST /api/v1/bridge-tokens/redeem`).
 *
 * The answer is checked before anything is returned to be stored: the bridge
 * URL must be on the SAME origin the code was redeemed at (the signature was
 * for that gateway, and a response must not redirect this browser to another
 * relay), the credential must be one the WebSocket can carry, and the id must
 * be a credential id.
 */
export async function redeemPairingCode(
  identity: ExtensionIdentity,
  origin: string,
  code: string,
): Promise<RedeemResult> {
  if (!isGatewayOrigin(origin))
    return { ok: false, reason: `not a bridge gateway origin: ${origin}` };
  let response: Response;
  try {
    response = await post(
      `${origin}/api/v1/bridge-tokens/redeem`,
      await redeemRequestBody(identity, origin, code),
    );
  } catch (e) {
    return {
      ok: false,
      reason: `could not reach ${origin}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const body = await readJson(response);
  if (!response.ok) {
    const error = body && typeof body.error === 'string' ? body.error : `HTTP ${response.status}`;
    return { ok: false, reason: error };
  }
  if (!body)
    return { ok: false, reason: 'the gateway answered with something that is not a credential' };
  const { token, id, bridgeUrl, name, bound } = body;
  if (typeof token !== 'string' || !validateRemoteTargetToken(token).ok) {
    return { ok: false, reason: 'the gateway answered with a credential this browser cannot use' };
  }
  if (!isBridgeTokenId(id))
    return { ok: false, reason: 'the gateway answered without a credential id' };
  if (typeof bridgeUrl !== 'string' || gatewayOriginFor(bridgeUrl) !== origin) {
    return { ok: false, reason: `the gateway named a bridge that is not on ${origin}` };
  }
  return {
    ok: true,
    target: {
      url: bridgeUrl,
      token,
      tokenId: id,
      ...(typeof name === 'string' && name !== '' ? { label: name } : {}),
    },
    bound: bound === true,
  };
}

/**
 * What one `POST /bridge/bind` means for the caller, which is what it must
 * remember:
 *
 * - `bound` — 200 `{bound: true}`: bound to this extension (now, or already).
 *   Never ask again for this credential.
 * - `conflict` — 409: bound to a DIFFERENT extension. First writer wins and
 *   nothing changes; asking again cannot help, and the room will refuse this
 *   browser `4004` on its next hello.
 * - `unsupported` — 404: the gateway predates binding. Remember per origin,
 *   do not retry every wake.
 * - `refused` — 400 / 401, or nothing a bind could be sent for. NOT retried:
 *   the gateway counts both against the same per-address allowance `/bridge`
 *   uses, so a retry loop here would lock this browser out of its own bridge.
 * - `retry` — anything transient (network, 429, 5xx, an unreadable 200).
 */
export type BindOutcome = 'bound' | 'conflict' | 'unsupported' | 'refused' | 'retry';

/**
 * Bind the credential `token` (id `tokenId`) for the bridge at `bridgeUrl` to
 * this extension. Sent only to the bridge URL's own gateway origin — where the
 * credential already travels as a WebSocket subprotocol — and never for a URL
 * a remote target could not be.
 */
export async function bindCredential(
  identity: ExtensionIdentity,
  bridgeUrl: string,
  tokenId: string,
  token: string,
): Promise<BindOutcome> {
  const origin = gatewayOriginFor(bridgeUrl);
  if (!origin || !isBridgeTokenId(tokenId) || !validateRemoteTargetToken(token).ok)
    return 'refused';
  let response: Response;
  try {
    response = await post(
      `${origin}/bridge/bind`,
      await signExtensionBinding(identity, origin, tokenId),
      {
        authorization: `Bearer ${token}`,
      },
    );
  } catch {
    return 'retry';
  }
  if (response.status === 200) {
    const body = await readJson(response);
    return body?.bound === true ? 'bound' : 'retry';
  }
  if (response.status === 409) return 'conflict';
  if (response.status === 404) return 'unsupported';
  if (response.status === 400 || response.status === 401) return 'refused';
  return 'retry';
}
