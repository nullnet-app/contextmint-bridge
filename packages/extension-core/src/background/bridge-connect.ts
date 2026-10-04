import { loadRemoteTargets, saveRemoteTargets } from '../vault-records.js';
import { type RemoteTarget } from '../remote-targets.js';
import {
  BRIDGE_CONNECT_TTL_MS,
  DEFAULT_BRIDGE_ORIGIN,
  finishBridgeConnect,
  normaliseConnectName,
  startBridgeConnect,
} from '../bridge-connect.js';
import { BRIDGE_CONNECT_APPROVAL, isAllowedGatewayOrigin } from '../bridge-connect-contract.js';
export { BRIDGE_CONNECT_APPROVAL } from '../bridge-connect-contract.js';
import { state } from './state.js';
import { loadRemoteLinks } from './socket.js';

export const BRIDGE_CONNECT_BEGIN = 'bridge-connect-begin';
export const BRIDGE_CONNECT_ORIGINS = 'bridge-connect-origins';
export const PENDING_BRIDGE_CONNECT_KEY = 'bridgeConnectPending';
export const BRIDGE_CONNECT_STATUS_KEY = 'bridgeConnectStatus';
const approvalsInFlight = new Set<number>();

export interface PendingConnect {
  tabId: number;
  origin: string;
  requestId: string;
  nonce: string;
  expiresAt: number;
}
interface SessionArea { get: (key: string) => Promise<Record<string, unknown>>; set: (value: Record<string, unknown>) => Promise<void> }
export interface ConnectSender { tab?: { id?: number }; frameId?: number; url?: string; origin?: string }
export interface ConnectApprovalDeps {
  finish: typeof finishBridgeConnect;
  loadTargets: typeof loadRemoteTargets;
  saveTargets: typeof saveRemoteTargets;
  /**
   * Re-read the saved targets and reconcile this worker's live links onto
   * them — dial the new bridge, drop links whose targets went away. Called
   * directly: this handler runs IN the background worker, and
   * `runtime.sendMessage` is never delivered to the context that sent it, so
   * messaging `remote-targets-changed` to ourselves did nothing (the new
   * bridge was saved but never dialled until a restart or a popup toggle).
   */
  reconcileLinks: () => Promise<void>;
}
interface ConnectRuntime { tabs?: { create?: (options: { url: string }) => Promise<{ id?: number }> }; storage?: { session?: SessionArea; managed?: { get: (keys: string[]) => Promise<Record<string, unknown>> } } }
const runtime = (): ConnectRuntime => (globalThis as { chrome?: ConnectRuntime }).chrome ?? {};

function readOriginList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((v): v is string => typeof v === 'string' && isAllowedGatewayOrigin(v)))].slice(0, 3);
}

export async function configuredConnectOrigins(): Promise<string[]> {
  let managed: Record<string, unknown> = {};
  try { managed = await runtime().storage?.managed?.get(['bridgeConnectOrigins']) ?? {}; } catch { /* managed storage is optional */ }
  return [DEFAULT_BRIDGE_ORIGIN, ...readOriginList(managed.bridgeConnectOrigins).filter((x) => x !== DEFAULT_BRIDGE_ORIGIN)];
}

export async function connectPopupOptions(): Promise<{ origins: string[]; status?: string }> {
  const origins = await configuredConnectOrigins();
  const area = runtime().storage?.session;
  if (!area) return { origins };
  const pending = await readPending(area);
  let expired = false;
  const now = Date.now();
  for (const [key, request] of Object.entries(pending)) if (request.expiresAt <= now) { delete pending[key]; expired = true; }
  if (expired) {
    await area.set({ [PENDING_BRIDGE_CONNECT_KEY]: pending, [BRIDGE_CONNECT_STATUS_KEY]: 'Connect request expired. Start again.' });
  }
  const saved = (await area.get(BRIDGE_CONNECT_STATUS_KEY))[BRIDGE_CONNECT_STATUS_KEY];
  return { origins, ...(typeof saved === 'string' ? { status: saved } : {}) };
}

async function setConnectStatus(status: string): Promise<void> {
  try { await runtime().storage?.session?.set({ [BRIDGE_CONNECT_STATUS_KEY]: status.slice(0, 160) }); } catch { /* status is best effort; credential flow is independent */ }
}

async function readPending(area: SessionArea): Promise<Record<string, PendingConnect>> {
  const raw = (await area.get(PENDING_BRIDGE_CONNECT_KEY))[PENDING_BRIDGE_CONNECT_KEY];
  const out: Record<string, PendingConnect> = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const p = value as Record<string, unknown>;
    if (p.tabId === Number(key) && typeof p.origin === 'string' && typeof p.requestId === 'string' && typeof p.nonce === 'string' && typeof p.expiresAt === 'number') {
      out[key] = p as unknown as PendingConnect;
    }
  }
  return out;
}

function relayPageUrl(origin: string, requestId: string): string {
  return `${origin}/bridge/connect?request=${requestId}`;
}

export function validConnectApproval(message: unknown, sender: ConnectSender, request: PendingConnect, now = Date.now()): boolean {
  const msg = typeof message === 'object' && message !== null ? message as Record<string, unknown> : {};
  return msg.type === BRIDGE_CONNECT_APPROVAL && sender.tab?.id === request.tabId && sender.frameId === 0 &&
    sender.url === relayPageUrl(request.origin, request.requestId) && sender.origin === request.origin &&
    msg.requestId === request.requestId && typeof msg.approval === 'string' && /^[A-Za-z0-9_-]{22}$/.test(msg.approval) &&
    Number.isSafeInteger(request.expiresAt) && request.expiresAt > now;
}

export async function beginBridgeConnect(originValue: unknown, nameValue: unknown, now = Date.now()): Promise<{ ok: true } | { ok: false; reason: string }> {
  const origin = typeof originValue === 'string' ? originValue : '';
  const name = normaliseConnectName(nameValue);
  const origins = await configuredConnectOrigins();
  const area = runtime().storage?.session;
  if (!origins.includes(origin) || !name) return { ok: false, reason: 'Choose a configured gateway and enter a valid browser name.' };
  if (!area || typeof runtime().tabs?.create !== 'function') return { ok: false, reason: 'This browser cannot open a Connect request.' };
  const identity = state.extIdentity;
  if (!identity) return { ok: false, reason: 'The browser identity is still loading. Try again.' };
  const started = await startBridgeConnect(identity, origin, name, now);
  if (!started.ok) return started;
  let tabId: number | undefined;
  try { tabId = (await runtime().tabs!.create!({ url: started.connectUrl }))?.id; } catch { /* report below */ }
  if (typeof tabId !== 'number') return { ok: false, reason: 'Could not open the gateway Connect page.' };
  const pending = await readPending(area);
  for (const [key, request] of Object.entries(pending)) if (request.expiresAt <= now || request.origin === origin) delete pending[key];
  pending[String(tabId)] = { tabId, origin, requestId: started.requestId, nonce: started.nonce, expiresAt: now + BRIDGE_CONNECT_TTL_MS };
  await area.set({ [PENDING_BRIDGE_CONNECT_KEY]: pending });
  await setConnectStatus('Waiting for account approval…');
  return { ok: true };
}

export async function onBridgeConnectApproval(
  message: unknown,
  sender: ConnectSender,
  now = Date.now(),
  deps: ConnectApprovalDeps = { finish: finishBridgeConnect, loadTargets: loadRemoteTargets, saveTargets: saveRemoteTargets, reconcileLinks: loadRemoteLinks },
): Promise<{ ok: boolean; reason?: string }> {
  const msg = typeof message === 'object' && message !== null ? message as Record<string, unknown> : {};
  if (msg.type !== BRIDGE_CONNECT_APPROVAL || typeof sender.tab?.id !== 'number' || sender.frameId !== 0 || typeof sender.url !== 'string') return { ok: false, reason: 'This approval did not come from the Connect page.' };
  const tabId = sender.tab.id;
  // storage.session has no compare-and-swap. Claim synchronously before the
  // first await so concurrent deliveries in this worker cannot both observe
  // and consume the same pending request.
  if (approvalsInFlight.has(tabId)) return { ok: false, reason: 'This Connect approval is invalid or expired.' };
  approvalsInFlight.add(tabId);
  try {
    const area = runtime().storage?.session;
    const identity = state.extIdentity;
    if (!area || !identity) return { ok: false, reason: 'The Connect request expired. Start again.' };
    const pending = await readPending(area);
    const key = String(tabId);
    const request = pending[key];
    if (!request || !validConnectApproval(msg, sender, request, now)) {
      return { ok: false, reason: 'This Connect approval is invalid or expired.' };
    }
    delete pending[key];
    await area.set({ [PENDING_BRIDGE_CONNECT_KEY]: pending }); // persist one-shot consumption before network I/O
    const approval = msg.approval as string; // validConnectApproval checked the exact 128-bit encoding.
    const result = await deps.finish(identity, request.origin, request.requestId, request.nonce, approval);
    if (!result.ok) {
      await setConnectStatus(`Connect failed: ${result.reason}`);
      return { ok: false, reason: result.reason };
    }
    const targets = await deps.loadTargets();
    const credential = result.credential;
    if (targets.some((t) => t.tokenId === credential.tokenId || t.url === credential.bridgeUrl)) {
      await setConnectStatus('This browser already has that bridge configured.');
      return { ok: false, reason: 'This browser already has that bridge configured.' };
    }
    const id = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const next: RemoteTarget[] = [...targets, { id, url: credential.bridgeUrl, token: credential.token, tokenId: credential.tokenId, connectApproved: true, connectAccount: credential.account, label: credential.name, enabled: true }];
    await deps.saveTargets(next);
    try { await deps.reconcileLinks(); } catch (e) { console.error('[fetchproxy] remote bridge reconcile after Connect:', e); /* boot re-reads the vault */ }
    await setConnectStatus(`Connected to ${credential.account.displayName}`);
    return { ok: true };
  } finally {
    approvalsInFlight.delete(tabId);
  }
}
