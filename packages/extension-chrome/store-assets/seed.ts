/**
 * Browser entry, loaded by the generator's seeding page BEFORE the popup: it
 * writes a scene's trust records and remote bridges through the extension's
 * own vault code, so the popup reads them exactly as it reads a real
 * profile's. Bundled by `generate.ts` at run time; never part of the
 * extension.
 */
import { TrustStore, type TrustInput } from '../../extension-core/src/trust-store.js';
import { saveRemoteTargets } from '../../extension-core/src/vault-records.js';
import type { RemoteTarget } from '../../extension-core/src/remote-targets.js';
import { AccountTrustStore, type AccountDerivedMcp, type TrustedAccount } from '../../extension-core/src/account-trust-store.js';
import { vaultUpdate } from '../../extension-core/src/vault.js';
import { claimVaultOwnership } from '../../extension-core/src/vault-migration.js';

interface SeedWindow {
  __SEED__: {
    version: string;
    trusted: { identityHash: string; input: TrustInput }[];
    remoteTargets: RemoteTarget[];
    accounts: TrustedAccount[];
    derived: { identityHash: string; mcp: Omit<AccountDerivedMcp, 'firstSeenAt' | 'lastSeenAt'> }[];
    vaultLoss: { detectedAt: number } | null;
  };
  __seeded?: true;
  __seedError?: string;
}

const w = window as unknown as SeedWindow;

// This page stands in for the background, the vault's only initialiser
// (fleet-audit #1001): as a reader it would ask a background that is not
// there to mint the identity, and every scene would fail to seed.
claimVaultOwnership();

void (async () => {
  try {
    const { version, trusted, remoteTargets, accounts, derived, vaultLoss } = w.__SEED__;
    const store = new TrustStore(version);
    for (const t of trusted) await store.put(t.identityHash, t.input);
    await saveRemoteTargets(remoteTargets);
    const accountStore = new AccountTrustStore();
    for (const a of accounts) await accountStore.put(a);
    const now = Date.now();
    for (const d of derived) {
      await accountStore.putDerived(d.identityHash, { ...d.mcp, firstSeenAt: now, lastSeenAt: now });
    }
    if (vaultLoss) await vaultUpdate('vaultLoss', () => vaultLoss);
    w.__seeded = true;
  } catch (e) {
    w.__seedError = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
  }
})();
