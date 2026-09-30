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
  async getHighWater(origin: string, accountId: string): Promise<number> {
    await ensureVault();
    const key = accountKey(origin, accountId);
    const marks = records<number>(await vaultGet('accountGenerationHighWater'));
    const stored = records<TrustedAccount>(await vaultGet('trustedAccounts'));
    return Math.max(marks[key] ?? 0, stored[key]?.generationHighWater ?? 0);
  }

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

  /** Write account trust and consume a target's Connect-click consent atomically. */
  async putApproved(account: TrustedAccount, targetId: string, requireConnectApproval = false): Promise<boolean> {
    assertGeneration(account?.generation, 'generation');
    if (account.generationHighWater !== undefined) assertGeneration(account.generationHighWater, 'generationHighWater');
    await ensureVault();
    const key = accountKey(account.origin, account.accountId);
    let refused = false;
    let connected = false;
    await vaultUpdateMany(['trustedAccounts', 'accountGenerationHighWater', 'remoteBridges'], (current) => {
      const stored = records<TrustedAccount>(current.trustedAccounts);
      const highWater = records<number>(current.accountGenerationHighWater);
      const targets = Array.isArray(current.remoteBridges) ? [...current.remoteBridges] : [];
      const targetIndex = targets.findIndex((value) => {
        if (!value || typeof value !== 'object') return false;
        const row = value as Record<string, unknown>;
        if (row.id !== targetId || row.tokenId !== account.tokenId) return false;
        try {
          const url = new URL(String(row.url));
          const origin = url.protocol === 'wss:' ? `https://${url.host}` : url.protocol === 'ws:' ? `http://${url.host}` : '';
          return origin === account.origin;
        } catch { return false; }
      });
      const target = targetIndex >= 0 ? targets[targetIndex] as Record<string, unknown> : undefined;
      if (requireConnectApproval && (!target || target.connectApproved !== true ||
        !target.connectAccount || typeof target.connectAccount !== 'object' ||
        (target.connectAccount as Record<string, unknown>).slug !== account.slug ||
        (target.connectAccount as Record<string, unknown>).displayName !== account.displayName)) {
        refused = true;
        return { values: { trustedAccounts: current.trustedAccounts, accountGenerationHighWater: current.accountGenerationHighWater, remoteBridges: current.remoteBridges }, result: undefined };
      }
      const mark = Math.max(highWater[key] ?? 0, stored[key]?.generationHighWater ?? 0);
      if (account.generation < mark) {
        refused = true;
        return { values: { trustedAccounts: current.trustedAccounts, accountGenerationHighWater: current.accountGenerationHighWater, remoteBridges: current.remoteBridges }, result: undefined };
      }
      stored[key] = { ...account, generationHighWater: Math.max(mark, account.generation) };
      highWater[key] = Math.max(mark, account.generation);
      if (target) {
        const nextTarget = { ...target };
        delete nextTarget.connectApproved;
        delete nextTarget.connectAccount;
        targets[targetIndex] = nextTarget;
      }
      connected = true;
      return { values: { trustedAccounts: stored, accountGenerationHighWater: highWater, remoteBridges: targets }, result: undefined };
    });
    if (refused) return false;
    return connected;
  }

  async deleteByToken(tokenId: string): Promise<void> {
    await ensureVault();
    await vaultUpdateMany(['trustedAccounts', 'accountGenerationHighWater', 'accountDerivedMcps', 'remoteBridges'], (current) => {
      const accounts = records<TrustedAccount>(current.trustedAccounts);
      const marks = records<number>(current.accountGenerationHighWater);
      const derived = records<AccountDerivedMcp>(current.accountDerivedMcps);
      const targets = Array.isArray(current.remoteBridges) ? [...current.remoteBridges] : [];
      const removed = new Set<string>();
      const tokens = new Set<string>([tokenId]);
      for (const [key, account] of Object.entries(accounts)) {
        if (account.tokenId !== tokenId) continue;
        removed.add(key);
        tokens.add(account.tokenId);
        marks[key] = Math.max(marks[key] ?? 0, account.generationHighWater, account.generation);
        delete accounts[key];
      }
      for (const [hash, mcp] of Object.entries(derived)) {
        if (removed.has(accountKey(mcp.origin, mcp.accountId))) delete derived[hash];
      }
      const nextTargets = targets.map((value) => {
        if (!value || typeof value !== 'object') return value;
        const target = value as Record<string, unknown>;
        if (!tokens.has(String(target.tokenId)) || target.connectApproved !== true) return value;
        const next = { ...target }; delete next.connectApproved; delete next.connectAccount; return next;
      });
      return { values: { trustedAccounts: accounts, accountGenerationHighWater: marks, accountDerivedMcps: derived, remoteBridges: nextTargets }, result: undefined };
    });
  }

  async deleteByAccount(origin: string, accountId: string): Promise<void> {
    await ensureVault();
    const key = accountKey(origin, accountId);
    await vaultUpdateMany(['trustedAccounts', 'accountGenerationHighWater', 'accountDerivedMcps', 'remoteBridges'], (current) => {
      const accounts = records<TrustedAccount>(current.trustedAccounts);
      const marks = records<number>(current.accountGenerationHighWater);
      const derived = records<AccountDerivedMcp>(current.accountDerivedMcps);
      const targets = Array.isArray(current.remoteBridges) ? [...current.remoteBridges] : [];
      const existing = accounts[key];
      if (existing) marks[key] = Math.max(marks[key] ?? 0, existing.generationHighWater, existing.generation);
      delete accounts[key];
      for (const [hash, mcp] of Object.entries(derived)) {
        if (mcp.origin === origin && mcp.accountId === accountId) delete derived[hash];
      }
      const nextTargets = existing ? targets.map((value) => {
        if (!value || typeof value !== 'object') return value;
        const target = value as Record<string, unknown>;
        if (target.tokenId !== existing.tokenId || target.connectApproved !== true) return value;
        const next = { ...target }; delete next.connectApproved; delete next.connectAccount; return next;
      }) : targets;
      return { values: { trustedAccounts: accounts, accountGenerationHighWater: marks, accountDerivedMcps: derived, remoteBridges: nextTargets }, result: undefined };
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
