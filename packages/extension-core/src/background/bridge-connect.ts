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
import { AccountTrustStore, type TrustedAccount } from '../account-trust-store.js';

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
  /** The vault's account trust records. Defaults to {@link AccountTrustStore}. */
  listTrustedAccounts?: () => Promise<Record<string, TrustedAccount>>;
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

/**
 * Which account a configured target speaks for, as far as this browser can
 * tell — or null when it cannot (a hand-pasted URL + token never names one).
 *
 * A Connect-made target names it in `connectAccount` until its first account
 * key is trusted; `putApproved` then consumes that consent and the vault's
 * trust record (bound to the target's `tokenId`) is what still names it.
 */
function targetAccount(
  target: RemoteTarget,
  origin: string,
  trusted: Record<string, TrustedAccount>,
): { slug: string; displayName: string } | null {
  if (target.connectApproved && target.connectAccount) return target.connectAccount;
  if (!target.tokenId) return null;
  const record = Object.values(trusted).find((a) => a?.tokenId === target.tokenId && a.origin === origin);
  return record && typeof record.slug === 'string' && typeof record.displayName === 'string'
    ? { slug: record.slug, displayName: record.displayName }
    : null;
}

const REVOKED_SAME_URL =
  'Your previous credential for this bridge is now revoked. Remove the old bridge in the popup, then press Connect again.';
const otherAccountSameUrl = (displayName: string): string =>
  `This bridge is set up for another account (${displayName.slice(0, 40)}). Remove it in the popup, then press Connect again.`;

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
    // Snapshot BEFORE finish: finish revokes this browser's previous
    // credential for the account and the gateway closes it 4003, whereupon
    // socket.ts's deleteByToken deletes its trust record and strips its
    // connectApproved — racing the response. What the target was before this
    // Connect is what decides whether the new credential may replace it.
    const before = await deps.loadTargets();
    const trusted = await (deps.listTrustedAccounts ?? (() => new AccountTrustStore().listAccounts()))();
    const result = await deps.finish(identity, request.origin, request.requestId, request.nonce, approval);
    if (!result.ok) {
      await setConnectStatus(`Connect failed: ${result.reason}`);
      return { ok: false, reason: result.reason };
    }
    const targets = await deps.loadTargets();
    const credential = result.credential;
    if (targets.some((t) => t.tokenId === credential.tokenId)) {
      await setConnectStatus('This browser already has that bridge configured.');
      return { ok: false, reason: 'This browser already has that bridge configured.' };
    }
    const id = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const added: RemoteTarget = { id, url: credential.bridgeUrl, token: credential.token, tokenId: credential.tokenId, connectApproved: true, connectAccount: credential.account, label: credential.name, enabled: true };
    // One target per URL (normaliseRemoteTargets drops duplicates), so a
    // same-URL target cannot sit beside the new one. Finish has already
    // revoked this browser's previous credential for the account, so keeping
    // the old row leaves the browser dialling a dead token. Replace it only
    // when it is known to be the SAME account's: a row this browser cannot
    // attribute (pasted by hand) or another account's is the user's to remove.
    const clashIndex = targets.findIndex((t) => t.url === credential.bridgeUrl);
    let next: RemoteTarget[];
    if (clashIndex >= 0) {
      const clash = targets[clashIndex]!;
      const prior = before.find((t) => t.id === clash.id && t.token === clash.token && t.tokenId === clash.tokenId);
      const account = prior ? targetAccount(prior, request.origin, trusted) : null;
      if (account?.slug !== credential.account.slug) {
        const reason = account ? otherAccountSameUrl(account.displayName) : REVOKED_SAME_URL;
        await setConnectStatus(reason);
        return { ok: false, reason };
      }
      next = targets.map((t, i) => (i === clashIndex ? added : t));
    } else {
      next = [...targets, added];
    }
    await deps.saveTargets(next);
    try { await deps.reconcileLinks(); } catch (e) { console.error('[fetchproxy] remote bridge reconcile after Connect:', e); /* boot re-reads the vault */ }
    await setConnectStatus(`Connected to ${credential.account.displayName}`);
    return { ok: true };
  } finally {
    approvalsInFlight.delete(tabId);
  }
}
