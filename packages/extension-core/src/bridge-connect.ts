/** Browser initiated account pairing (mcp-host X1, plan task X3). */
import { toB64 } from '@fetchproxy/protocol';
import { signWithExtensionIdentity, type ExtensionIdentity } from './extension-identity.js';
import { post, gatewayOriginFor } from './bridge-gateway.js';
import { validateRemoteTargetToken, validateRemoteTargetUrl } from './remote-targets.js';
import { BRIDGE_CONNECT_MESSAGE_TYPE, DEFAULT_BRIDGE_ORIGIN, isAllowedGatewayOrigin } from './bridge-connect-contract.js';

export const BRIDGE_CONNECT_START_CONTEXT = 'mcp-host/bridge-connect-start/v1';
export const BRIDGE_CONNECT_FINISH_CONTEXT = 'mcp-host/bridge-connect-finish/v1';
export const BRIDGE_CONNECT_TTL_MS = 10 * 60_000;
export { BRIDGE_CONNECT_MESSAGE_TYPE, DEFAULT_BRIDGE_ORIGIN };

function encode(parts: string[]): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(parts.join('\0'));
  const out = new Uint8Array(new ArrayBuffer(encoded.length));
  out.set(encoded);
  return out;
}

export function bridgeConnectStartMessage(origin: string, x25519Pub: string, ed25519Pub: string, ts: number): Uint8Array<ArrayBuffer> {
  return encode([BRIDGE_CONNECT_START_CONTEXT, origin, x25519Pub, ed25519Pub, String(ts)]);
}

export function bridgeConnectFinishMessage(origin: string, requestId: string, nonce: string, approval: string, x25519Pub: string, ed25519Pub: string): Uint8Array<ArrayBuffer> {
  return encode([BRIDGE_CONNECT_FINISH_CONTEXT, origin, requestId, nonce, approval, x25519Pub, ed25519Pub]);
}

export function connectPageUrl(origin: string, candidate: unknown, requestId: string): string | null {
  if (typeof candidate !== 'string' || !/^bcr_[0-9a-f]{32}$/.test(requestId)) return null;
  let url: URL;
  try { url = new URL(candidate); } catch { return null; }
  if (url.origin !== origin || url.username || url.password || url.pathname !== '/bridge/connect' || url.hash) return null;
  const requests = url.searchParams.getAll('request');
  if (requests.length !== 1 || requests[0] !== requestId || [...url.searchParams.keys()].length !== 1) return null;
  return `${origin}/bridge/connect?request=${requestId}`;
}

function isConnectSecret(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value); }
function jsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try { return jsonObject(await response.json()); } catch { return null; }
}

export type ConnectStart = { ok: true; requestId: string; nonce: string; connectUrl: string } | { ok: false; reason: string };

export async function startBridgeConnect(identity: ExtensionIdentity, origin: string, name: string, nowMs = Date.now()): Promise<ConnectStart> {
  const normalizedName = normaliseConnectName(name);
  if (!isAllowedGatewayOrigin(origin) || !normalizedName) return { ok: false, reason: 'This gateway or browser name is not configured.' };
  const x25519Pub = toB64(identity.x25519Pub);
  const ed25519Pub = toB64(identity.ed25519Pub);
  const ts = Math.floor(nowMs / 1000);
  try {
    const sig = await signWithExtensionIdentity(identity, bridgeConnectStartMessage(origin, x25519Pub, ed25519Pub, ts));
    const response = await post(`${origin}/bridge/connect/start`, { x25519Pub, ed25519Pub, name: normalizedName, ts, sig: toB64(sig) });
    const body = await readJson(response);
    if (!response.ok) return { ok: false, reason: typeof body?.error === 'string' ? body.error : `Gateway returned HTTP ${response.status}.` };
    const requestId = body?.requestId;
    const nonce = body?.nonce;
    const connectUrl = connectPageUrl(origin, body?.connectUrl, typeof requestId === 'string' ? requestId : '');
    if (typeof requestId !== 'string' || !/^bcr_[0-9a-f]{32}$/.test(requestId) || !isConnectSecret(nonce) || !connectUrl) {
      return { ok: false, reason: 'The gateway returned an invalid Connect request.' };
    }
    return { ok: true, requestId, nonce, connectUrl };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Could not reach the gateway.' };
  }
}

export type ConnectCredential = { token: string; tokenId: string; name: string; bridgeUrl: string; account: { slug: string; displayName: string } };
export async function finishBridgeConnect(identity: ExtensionIdentity, origin: string, requestId: string, nonce: string, approval: string): Promise<{ ok: true; credential: ConnectCredential } | { ok: false; reason: string }> {
  if (!isAllowedGatewayOrigin(origin) || !/^bcr_[0-9a-f]{32}$/.test(requestId) || !isConnectSecret(nonce) || !isConnectSecret(approval)) {
    return { ok: false, reason: 'This Connect approval is invalid or expired.' };
  }
  const x25519Pub = toB64(identity.x25519Pub);
  const ed25519Pub = toB64(identity.ed25519Pub);
  try {
    const sig = await signWithExtensionIdentity(identity, bridgeConnectFinishMessage(origin, requestId, nonce, approval, x25519Pub, ed25519Pub));
    const response = await post(`${origin}/bridge/connect/finish`, { requestId, nonce, approval, sig: toB64(sig) });
    const body = await readJson(response);
    if (!response.ok) return { ok: false, reason: typeof body?.error === 'string' ? body.error : `Gateway returned HTTP ${response.status}.` };
    const account = jsonObject(body?.account);
    if (typeof body?.token !== 'string' || !validateRemoteTargetToken(body.token).ok || typeof body.tokenId !== 'string' || !/^brt_[A-Za-z0-9_-]{1,64}$/.test(body.tokenId) || typeof body.name !== 'string' || typeof body.bridgeUrl !== 'string' || !validateRemoteTargetUrl(body.bridgeUrl).ok || gatewayOriginFor(body.bridgeUrl) !== origin || typeof account?.slug !== 'string' || typeof account.displayName !== 'string') {
      return { ok: false, reason: 'The gateway returned an invalid bridge credential.' };
    }
    return { ok: true, credential: { token: body.token, tokenId: body.tokenId, name: body.name, bridgeUrl: body.bridgeUrl, account: { slug: account.slug, displayName: account.displayName } } };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'Could not reach the gateway.' };
  }
}

/** Same name constraints the gateway applies before displaying the approval. */
export function normaliseConnectName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  if (!name || [...name].length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(name) || /\p{Bidi_Control}/u.test(name)) return null;
  return name;
}
