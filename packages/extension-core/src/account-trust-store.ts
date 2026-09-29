/** Vault-only trust records for account credentials and account-derived MCPs. */
import { vaultGet, vaultUpdate } from './vault.js';
import { ensureVault } from './vault-migration.js';

export interface TrustedAccount {
  origin: string;
  accountId: string;
  slug: string;
  displayName: string;
  tokenId: string;
  kid: string;
  publicKey: string;
  generation: number;
  generationHighWater: number;
  approvedAt: number;
}

export interface AccountDerivedMcp {
  origin: string;
  accountId: string;
  registrationId: string;
  slug: string;
  scope: string[];
  approvedScope?: string[];
  firstSeenAt: number;
  lastSeenAt: number;
  alwaysAsk?: boolean;
}

type Accounts = Record<string, TrustedAccount>;
type Derived = Record<string, AccountDerivedMcp>;

export const accountKey = (origin: string, accountId: string): string => `${origin}\0${accountId}`;

function records<T>(value: unknown): Record<string, T> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, T> : {};
}

/** Account credentials never come from, or migrate out of, storage.local. */
export class AccountTrustStore {
  async get(origin: string, accountId: string): Promise<TrustedAccount | null> {
    await ensureVault();
    const stored = records<TrustedAccount>(await vaultGet('trustedAccounts'));
    return stored[accountKey(origin, accountId)] ?? null;
  }

  async put(account: TrustedAccount): Promise<void> {
    await ensureVault();
    const key = accountKey(account.origin, account.accountId);
    let refused = false;
    await vaultUpdate('trustedAccounts', (value) => {
      const stored = records<TrustedAccount>(value);
      const previous = stored[key];
      const highWater = Math.max(previous?.generationHighWater ?? 0, account.generationHighWater ?? 0);
      if (account.generation < highWater) { refused = true; return stored; }
      stored[key] = { ...account, generationHighWater: Math.max(highWater, account.generation) };
      return stored;
    });
    if (refused) throw new Error('generation is below the high-water mark');
  }

  async deleteByToken(tokenId: string): Promise<void> {
    await ensureVault();
    await vaultUpdate('trustedAccounts', (value) => {
      const stored = records<TrustedAccount>(value);
      for (const [key, account] of Object.entries(stored)) if (account.tokenId === tokenId) delete stored[key];
      return stored;
    });
  }

  async deleteByAccount(origin: string, accountId: string): Promise<void> {
    await ensureVault();
    const key = accountKey(origin, accountId);
    await vaultUpdate('trustedAccounts', (value) => { const stored = records<TrustedAccount>(value); delete stored[key]; return stored; });
    await vaultUpdate('accountDerivedMcps', (value) => {
      const stored = records<AccountDerivedMcp>(value);
      for (const [hash, mcp] of Object.entries(stored)) if (mcp.origin === origin && mcp.accountId === accountId) delete stored[hash];
      return stored;
    });
  }

  async bumpHighWater(origin: string, accountId: string, generation: number): Promise<number> {
    await ensureVault();
    const key = accountKey(origin, accountId);
    let result = generation;
    await vaultUpdate('trustedAccounts', (value) => {
      const stored = records<TrustedAccount>(value);
      const account = stored[key];
      if (!account) throw new Error('trusted account not found');
      result = Math.max(account.generationHighWater, generation);
      stored[key] = { ...account, generationHighWater: result };
      return stored;
    });
    return result;
  }

  async getDerived(identityHash: string): Promise<AccountDerivedMcp | null> {
    await ensureVault();
    return records<AccountDerivedMcp>(await vaultGet('accountDerivedMcps'))[identityHash] ?? null;
  }

  async putDerived(identityHash: string, mcp: AccountDerivedMcp): Promise<void> {
    await ensureVault();
    await vaultUpdate('accountDerivedMcps', (value) => ({ ...records<AccountDerivedMcp>(value), [identityHash]: mcp }));
  }
}
