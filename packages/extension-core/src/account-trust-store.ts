/** Vault-only trust records for account credentials and account-derived MCPs. */
import { vaultGet, vaultUpdate, vaultUpdateMany } from './vault.js';
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

type RecordMap<T> = Record<string, T>;

export const accountKey = (origin: string, accountId: string): string => `${origin}\0${accountId}`;

function records<T>(value: unknown): RecordMap<T> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordMap<T> : {};
}

function assertGeneration(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a finite nonnegative safe integer`);
  }
}

/** Account credentials never come from, or migrate out of, storage.local. */
export class AccountTrustStore {
  async get(origin: string, accountId: string): Promise<TrustedAccount | null> {
    await ensureVault();
    return records<TrustedAccount>(await vaultGet('trustedAccounts'))[accountKey(origin, accountId)] ?? null;
  }

  async put(account: TrustedAccount): Promise<void> {
    assertGeneration(account?.generation, 'generation');
    if (account.generationHighWater !== undefined) assertGeneration(account.generationHighWater, 'generationHighWater');
    if (account.generationHighWater !== undefined && account.generationHighWater < account.generation) {
      throw new Error('generationHighWater cannot be below generation (high-water invariant)');
    }
    await ensureVault();
    const key = accountKey(account.origin, account.accountId);
    let refused = false;
    await vaultUpdateMany(['trustedAccounts', 'accountGenerationHighWater'], (current) => {
      const stored = records<TrustedAccount>(current.trustedAccounts);
      const highWater = records<number>(current.accountGenerationHighWater);
      const mark = Math.max(highWater[key] ?? 0, stored[key]?.generationHighWater ?? 0, account.generationHighWater ?? 0);
      if (account.generation < mark) {
        refused = true;
        return { values: { trustedAccounts: current.trustedAccounts, accountGenerationHighWater: current.accountGenerationHighWater }, result: undefined };
      }
      const nextMark = Math.max(mark, account.generation);
      stored[key] = { ...account, generationHighWater: nextMark };
      highWater[key] = nextMark;
      return { values: { trustedAccounts: stored, accountGenerationHighWater: highWater }, result: undefined };
    });
    if (refused) throw new Error('generation is below the high-water mark');
  }

  async deleteByToken(tokenId: string): Promise<void> {
    await ensureVault();
    await vaultUpdateMany(['trustedAccounts', 'accountGenerationHighWater', 'accountDerivedMcps'], (current) => {
      const accounts = records<TrustedAccount>(current.trustedAccounts);
      const marks = records<number>(current.accountGenerationHighWater);
      const derived = records<AccountDerivedMcp>(current.accountDerivedMcps);
      const removed = new Set<string>();
      for (const [key, account] of Object.entries(accounts)) {
        if (account.tokenId !== tokenId) continue;
        removed.add(key);
        marks[key] = Math.max(marks[key] ?? 0, account.generationHighWater, account.generation);
        delete accounts[key];
      }
      for (const [hash, mcp] of Object.entries(derived)) {
        if (removed.has(accountKey(mcp.origin, mcp.accountId))) delete derived[hash];
      }
      return { values: { trustedAccounts: accounts, accountGenerationHighWater: marks, accountDerivedMcps: derived }, result: undefined };
    });
  }

  async deleteByAccount(origin: string, accountId: string): Promise<void> {
    await ensureVault();
    const key = accountKey(origin, accountId);
    await vaultUpdateMany(['trustedAccounts', 'accountGenerationHighWater', 'accountDerivedMcps'], (current) => {
      const accounts = records<TrustedAccount>(current.trustedAccounts);
      const marks = records<number>(current.accountGenerationHighWater);
      const derived = records<AccountDerivedMcp>(current.accountDerivedMcps);
      const existing = accounts[key];
      if (existing) marks[key] = Math.max(marks[key] ?? 0, existing.generationHighWater, existing.generation);
      delete accounts[key];
      for (const [hash, mcp] of Object.entries(derived)) {
        if (mcp.origin === origin && mcp.accountId === accountId) delete derived[hash];
      }
      return { values: { trustedAccounts: accounts, accountGenerationHighWater: marks, accountDerivedMcps: derived }, result: undefined };
    });
  }

  async bumpHighWater(origin: string, accountId: string, generation: number): Promise<number> {
    assertGeneration(generation, 'generation');
    await ensureVault();
    const key = accountKey(origin, accountId);
    let result = generation;
    await vaultUpdateMany(['trustedAccounts', 'accountGenerationHighWater'], (current) => {
      const stored = records<TrustedAccount>(current.trustedAccounts);
      const marks = records<number>(current.accountGenerationHighWater);
      const account = stored[key];
      result = Math.max(marks[key] ?? 0, account?.generationHighWater ?? 0, generation);
      marks[key] = result;
      if (account) stored[key] = { ...account, generationHighWater: result };
      return { values: { trustedAccounts: stored, accountGenerationHighWater: marks }, result: undefined };
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
