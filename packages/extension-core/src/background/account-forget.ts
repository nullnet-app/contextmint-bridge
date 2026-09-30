import { AccountTrustStore } from '../account-trust-store.js';
import { TrustStore, type TrustRecord } from '../trust-store.js';
import { state } from './state.js';
import { linkForMcp, unbindMcp } from './links.js';
import {
  broadcastConnectionsChanged, clearSessionScopeFor, mcpIdentityHash,
} from './session-scope.js';
import { syncMainWorldBridgeForActiveTrust } from './main-world-bridge-sync.js';
import { invalidateAccountHellos } from './account-invalidation.js';

declare const chrome: { storage?: { session?: { get(k: string): Promise<Record<string, unknown>>; set(v: Record<string, unknown>): Promise<void>; remove(k: string): Promise<void> } } };
const SESSION_APPROVALS = 'accountMcpSessionApprovals';
const PENDING_CARDS = 'pendingAccountMcpCards';

type SessionApproval = { origin?: string; accountId?: string; tokenId?: string };
type PendingCard = { origin?: string; accountId?: string; tokenId?: string; identityHash?: string };

async function clearSessionAuthority(matches: (entry: { hash: string; value: SessionApproval | PendingCard }) => boolean): Promise<void> {
  const area = chrome.storage?.session;
  if (!area) return;
  const [approvalData, cardData] = await Promise.all([area.get(SESSION_APPROVALS), area.get(PENDING_CARDS)]);
  const approvals = approvalData[SESSION_APPROVALS] && typeof approvalData[SESSION_APPROVALS] === 'object'
    ? { ...(approvalData[SESSION_APPROVALS] as Record<string, SessionApproval>) } : {};
  const cards = cardData[PENDING_CARDS] && typeof cardData[PENDING_CARDS] === 'object'
    ? { ...(cardData[PENDING_CARDS] as Record<string, PendingCard>) } : {};
  let approvalsChanged = false;
  let cardsChanged = false;
  for (const [hash, value] of Object.entries(approvals)) if (matches({ hash, value })) { delete approvals[hash]; approvalsChanged = true; }
  for (const [key, value] of Object.entries(cards)) if (matches({ hash: value.identityHash ?? key, value })) { delete cards[key]; cardsChanged = true; }
  const writes: Promise<void>[] = [];
  if (approvalsChanged) writes.push(Object.keys(approvals).length ? area.set({ [SESSION_APPROVALS]: approvals }) : area.remove(SESSION_APPROVALS));
  if (cardsChanged) writes.push(Object.keys(cards).length ? area.set({ [PENDING_CARDS]: cards }) : area.remove(PENDING_CARDS));
  await Promise.all(writes);
}

function revokeLiveIdentityHashes(identityHashes: Set<string>): void {
  for (const [mcpId, hash] of [...mcpIdentityHash]) {
    if (!identityHashes.has(hash)) continue;
    const link = linkForMcp(mcpId);
    if (link) unbindMcp(mcpId, link);
    state.sessions?.remove(mcpId);
    clearSessionScopeFor(mcpId);
  }
}

async function syncRevocation(): Promise<void> {
  try {
    if (state.trust) await syncMainWorldBridgeForActiveTrust(state.trust);
  } finally {
    broadcastConnectionsChanged();
  }
}

/** Explicitly forget an account and immediately revoke all of its live authority. */
export async function forgetAccountInBackground(origin: string, accountId: string, alsoForgetMcps: boolean): Promise<void> {
  invalidateAccountHellos(origin, accountId);
  const accounts = new AccountTrustStore();
  const trust = state.trust ?? new TrustStore('0.0.0');
  const [account, derived, trusted] = await Promise.all([
    accounts.get(origin, accountId), accounts.listDerived(), alsoForgetMcps ? trust.list() : Promise.resolve({} as Record<string, TrustRecord>),
  ]);
  const hashes = new Set(Object.entries(derived)
    .filter(([, record]) => record.origin === origin && record.accountId === accountId)
    .map(([hash]) => hash));
  const pairedHashes = Object.entries(trusted)
    .filter(([, record]) => record.attestedBy?.origin === origin && record.attestedBy.accountId === accountId)
    .map(([hash]) => hash);
  if (alsoForgetMcps) for (const hash of pairedHashes) hashes.add(hash);

  // Remove durable authority first so a hello started after this point cannot
  // use the forgotten account. The generation high-water tombstone survives.
  await accounts.deleteByAccount(origin, accountId);
  if (alsoForgetMcps) await Promise.all(pairedHashes.map((hash) => trust.remove(hash)));

  // Revoke current sessions, then clean session-storage authority. These
  // operations yield, so re-snapshot durable identities and live sessions
  // afterwards before the final MAIN-world reconciliation.
  revokeLiveIdentityHashes(hashes);
  await clearSessionAuthority(({ value }) => value.origin === origin && value.accountId === accountId &&
    (!account || !value.tokenId || value.tokenId === account.tokenId));
  const remainingDerived = await accounts.listDerived();
  const remainingHashes = new Set([...hashes, ...Object.entries(remainingDerived)
    .filter(([, record]) => record.origin === origin && record.accountId === accountId)
    .map(([hash]) => hash)]);
  for (const hash of pairedHashes) if (alsoForgetMcps) remainingHashes.add(hash);
  revokeLiveIdentityHashes(remainingHashes);
  await clearSessionAuthority(({ value }) => value.origin === origin && value.accountId === accountId &&
    (!account || !value.tokenId || value.tokenId === account.tokenId));
  await syncRevocation();
}

/** Explicitly forget one MCP identity and revoke every currently attached instance. */
export async function forgetMcpInBackground(identityHash: string): Promise<void> {
  if (typeof identityHash !== 'string' || !identityHash || identityHash.length > 256) return;
  const accounts = new AccountTrustStore();
  const trust = state.trust ?? new TrustStore('0.0.0');
  // Remove persistent grants before awaiting session storage, then repeat the
  // live teardown after that await to catch a hello that was already in flight.
  revokeLiveIdentityHashes(new Set([identityHash]));
  await Promise.all([accounts.deleteDerived(identityHash), trust.remove(identityHash)]);
  await clearSessionAuthority(({ hash, value }) => hash === identityHash || ('identityHash' in value && value.identityHash === identityHash));
  revokeLiveIdentityHashes(new Set([identityHash]));
  // Account high-water marks are deliberately untouched when one MCP is forgotten.
  await syncRevocation();
}
