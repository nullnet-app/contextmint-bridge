import type { TrustStore } from '../trust-store.js';
import { syncMainWorldBridgeFromTrust } from '../main-world-bridge.js';
import { mcpAccountDerivedDomains } from './session-scope.js';

export const SYNC_MAIN_WORLD_BRIDGE = 'sync-main-world-bridge';

/** Reconcile page scripts against durable trust and attached account grants. */
export function syncMainWorldBridgeForActiveTrust(
  trust: Pick<TrustStore, 'approvedDomains'>,
  opts: { injectIntoOpenTabs?: boolean } = {},
): Promise<void> {
  return syncMainWorldBridgeFromTrust(trust, {
    ...opts,
    additionalDomains: [...mcpAccountDerivedDomains.values()].flat(),
  });
}

/** Domains for update-time content-script re-registration. */
export async function approvedAndAttachedDomains(
  trust: Pick<TrustStore, 'approvedDomains'>,
): Promise<string[]> {
  return [...new Set([...(await trust.approvedDomains()), ...[...mcpAccountDerivedDomains.values()].flat()])];
}
