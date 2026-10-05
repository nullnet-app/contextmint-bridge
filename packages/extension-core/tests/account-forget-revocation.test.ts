import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshVault } from './helpers/vault.js';
import { AccountTrustStore } from '../src/account-trust-store.js';
import { TrustStore } from '../src/trust-store.js';
import { SessionKeys } from '../src/session-keys.js';
import { state } from '../src/background/state.js';
import { bindMcpToLink, links, linkForMcp, unbindLink, type Link } from '../src/background/links.js';
import { mcpAccountDerivedDomains, mcpDomains, mcpIdentityHash } from '../src/background/session-scope.js';
import { forgetAccountInBackground, forgetMcpInBackground } from '../src/background/account-forget.js';
import { isAccountForgetInProgress } from '../src/background/account-invalidation.js';

function area() {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key: string | string[]) => Object.fromEntries((Array.isArray(key) ? key : [key]).filter(k => k in data).map(k => [k, data[k]])),
    set: async (value: Record<string, unknown>) => Object.assign(data, value),
    remove: async (key: string | string[]) => { for (const k of Array.isArray(key) ? key : [key]) delete data[k]; },
  };
}
function remote(id: string, tokenId = 'tok'): Link {
  return { id: `remote:${id}`, kind: 'remote', url: 'wss://gateway.example/bridge', protocols: [], label: id,
    ws: null, reconnectAttempt: 0, nextAttemptAt: 0, sessionNonce: null, accountAttestations: new Map(),
    closed: false, targetId: id, tokenId, refusal: null, lastImmediateRedialAt: 0 };
}

afterEach(() => {
  for (const link of links.values()) unbindLink(link);
  links.clear();
  state.trust = null; state.sessions = null; state.extIdentity = null;
  mcpDomains.clear(); mcpAccountDerivedDomains.clear(); mcpIdentityHash.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('background-owned account revocation', () => {
  it('holds the account forget barrier through awaited storage cleanup', async () => {
    freshVault();
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() }, storage: { session: area(), local: area() }, tabs: { query: async () => [] } });
    state.trust = new TrustStore('1.0.0'); state.sessions = new SessionKeys();
    const accounts = new AccountTrustStore();
    await accounts.put({ origin: 'https://gateway.example', accountId: 'barrier-acct', slug: 'a', displayName: 'A',
      tokenId: 'tok', kid: 'k', publicKey: 'p', generation: 1, generationHighWater: 1, approvedAt: 1 });
    let entered!: () => void; let release!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalGet = AccountTrustStore.prototype.get;
    vi.spyOn(AccountTrustStore.prototype, 'get').mockImplementation(async function (this: AccountTrustStore, origin, accountId) {
      if (accountId === 'barrier-acct') { entered(); await gate; }
      return originalGet.call(this, origin, accountId);
    });

    const forgetting = forgetAccountInBackground('https://gateway.example', 'barrier-acct', false);
    await enteredRead;
    expect(isAccountForgetInProgress('https://gateway.example', 'barrier-acct')).toBe(true);
    release();
    await forgetting;
    expect(isAccountForgetInProgress('https://gateway.example', 'barrier-acct')).toBe(false);
  });

  it('clears confirm-each approvals and revokes attached account-derived session domains on account forget', async () => {
    freshVault();
    const session = area();
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() }, storage: { session, local: area() }, tabs: { query: async () => [] } });
    const accounts = new AccountTrustStore();
    const trust = new TrustStore('1.0.0');
    state.trust = trust; state.sessions = new SessionKeys();
    await accounts.put({ origin: 'https://gateway.example', accountId: 'acct', slug: 'acct', displayName: 'A', tokenId: 'tok', kid: 'k', publicKey: 'p', generation: 3, generationHighWater: 3, approvedAt: 1 });
    const hash = 'identity-hash';
    await accounts.putDerived(hash, { origin: 'https://gateway.example', accountId: 'acct', registrationId: 'reg', slug: 'acct', scope: { domains: ['example.com'], capabilities: ['fetch'], cookieKeys: [], localStorageKeys: [], sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [], graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [] }, firstSeenAt: 1, lastSeenAt: 1 });
    await session.set({ accountMcpSessionApprovals: { [hash]: { origin: 'https://gateway.example', accountId: 'acct', tokenId: 'tok', generation: 3, scope: { domains: ['example.com'] } }, unrelated: { origin: 'https://other', accountId: 'other', tokenId: 'else', generation: 1, scope: {} } } });
    const link = remote('one'); links.set(link.id, link); bindMcpToLink('mcp-one', link);
    state.sessions.set('mcp-one', new Uint8Array(32)); mcpIdentityHash.set('mcp-one', hash);
    mcpDomains.set('mcp-one', ['example.com']); mcpAccountDerivedDomains.set('mcp-one', ['example.com']);

    await forgetAccountInBackground('https://gateway.example', 'acct', false);

    expect(state.sessions.get('mcp-one')).toBeNull();
    expect(linkForMcp('mcp-one')).toBeNull();
    expect(mcpDomains.has('mcp-one')).toBe(false);
    expect(mcpAccountDerivedDomains.has('mcp-one')).toBe(false);
    expect((await session.get('accountMcpSessionApprovals')).accountMcpSessionApprovals).toEqual({ unrelated: expect.any(Object) });
    expect(await accounts.getHighWater('https://gateway.example', 'acct')).toBe(3);
  });

  it('forget-this-MCP deletes persistent records and revokes its live session', async () => {
    freshVault();
    const session = area();
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() }, storage: { session, local: area() }, tabs: { query: async () => [] } });
    const accounts = new AccountTrustStore(); const trust = new TrustStore('1.0.0');
    state.trust = trust; state.sessions = new SessionKeys();
    const hash = 'mcp-hash';
    await accounts.putDerived(hash, { origin: 'https://gateway.example', accountId: 'acct', registrationId: 'r', slug: 'a', scope: { domains: ['a.example'], capabilities: ['fetch'], cookieKeys: [], localStorageKeys: [], sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [], graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [] }, firstSeenAt: 1, lastSeenAt: 1 });
    await trust.put(hash, { serverName: 'a', identityX25519Pub: 'x', identityEd25519Pub: 'y', domains: ['a.example'], capabilities: ['fetch'] });
    const link = remote('two'); links.set(link.id, link); bindMcpToLink('mcp-two', link);
    state.sessions.set('mcp-two', new Uint8Array(32)); mcpIdentityHash.set('mcp-two', hash);
    mcpDomains.set('mcp-two', ['a.example']); mcpAccountDerivedDomains.set('mcp-two', ['a.example']);

    await forgetMcpInBackground(hash);

    expect(state.sessions.get('mcp-two')).toBeNull(); expect(linkForMcp('mcp-two')).toBeNull();
    expect(mcpAccountDerivedDomains.has('mcp-two')).toBe(false);
    expect(await accounts.getDerived(hash)).toBeNull(); expect(await trust.get(hash)).toBeNull();
  });

  it('optionally removes and revokes only hand-paired MCPs vouched by the forgotten account', async () => {
    freshVault();
    const session = area();
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() }, storage: { session, local: area() }, tabs: { query: async () => [] } });
    const accounts = new AccountTrustStore(); const trust = new TrustStore('1.0.0');
    state.trust = trust; state.sessions = new SessionKeys();
    const record = { serverName: 'a', identityX25519Pub: 'x', identityEd25519Pub: 'y', domains: ['a.example'], capabilities: ['fetch'] };
    await trust.put('vouched-hash', { ...record, attestedBy: { accountId: 'acct', slug: 'acct', origin: 'https://gateway.example' } });
    await trust.put('other-hash', record);
    const vouched = remote('vouched'); const other = remote('other'); links.set(vouched.id, vouched); links.set(other.id, other);
    bindMcpToLink('vouched-id', vouched); bindMcpToLink('other-id', other);
    state.sessions.set('vouched-id', new Uint8Array(32)); state.sessions.set('other-id', new Uint8Array(32));
    mcpIdentityHash.set('vouched-id', 'vouched-hash'); mcpIdentityHash.set('other-id', 'other-hash');
    mcpDomains.set('vouched-id', ['a.example']); mcpDomains.set('other-id', ['a.example']);

    await forgetAccountInBackground('https://gateway.example', 'acct', true);

    expect(state.sessions.get('vouched-id')).toBeNull(); expect(linkForMcp('vouched-id')).toBeNull();
    expect(state.sessions.get('other-id')).not.toBeNull(); expect(linkForMcp('other-id')).toBe(other);
    expect(await trust.get('vouched-hash')).toBeNull(); expect(await trust.get('other-hash')).not.toBeNull();
  });

  it('preserves hand-paired MCP trust when the optional checkbox is off', async () => {
    freshVault();
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() }, storage: { session: area(), local: area() }, tabs: { query: async () => [] } });
    const trust = new TrustStore('1.0.0'); state.trust = trust; state.sessions = new SessionKeys();
    await trust.put('vouched-hash', { serverName: 'a', identityX25519Pub: 'x', identityEd25519Pub: 'y', domains: ['a.example'], capabilities: ['fetch'], attestedBy: { accountId: 'acct', slug: 'acct', origin: 'https://gateway.example' } });
    await forgetAccountInBackground('https://gateway.example', 'acct', false);
    expect(await trust.get('vouched-hash')).not.toBeNull();
  });

  it('re-snapshots sessions after awaited storage cleanup to catch an attach racing forget', async () => {
    freshVault();
    const backing = area();
    let entered!: () => void; let release!: () => void;
    const enteredGet = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const session = { ...backing, get: async (key: string | string[]) => {
      const keys = Array.isArray(key) ? key : [key];
      if (keys.includes('accountMcpSessionApprovals')) { entered(); await gate; }
      return backing.get(key);
    } };
    vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn() }, storage: { session, local: area() }, tabs: { query: async () => [] } });
    const accounts = new AccountTrustStore(); state.trust = new TrustStore('1.0.0'); state.sessions = new SessionKeys();
    await accounts.put({ origin: 'https://gateway.example', accountId: 'acct', slug: 'a', displayName: 'A', tokenId: 'tok', kid: 'k', publicKey: 'p', generation: 1, generationHighWater: 1, approvedAt: 1 });
    await accounts.putDerived('racing-hash', { origin: 'https://gateway.example', accountId: 'acct', registrationId: 'r', slug: 'a', scope: { domains: ['a.example'], capabilities: ['fetch'], cookieKeys: [], localStorageKeys: [], sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [], graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [] }, firstSeenAt: 1, lastSeenAt: 1 });
    const pending = forgetAccountInBackground('https://gateway.example', 'acct', false);
    await Promise.race([enteredGet, pending.then(() => { throw new Error('forget completed before session cleanup'); })]);
    const link = remote('racer'); links.set(link.id, link); bindMcpToLink('racer-id', link);
    state.sessions.set('racer-id', new Uint8Array(32)); mcpIdentityHash.set('racer-id', 'racing-hash');
    mcpDomains.set('racer-id', ['a.example']); mcpAccountDerivedDomains.set('racer-id', ['a.example']);
    release();
    await pending;
    expect(state.sessions.get('racer-id')).toBeNull(); expect(linkForMcp('racer-id')).toBeNull();
    expect(mcpAccountDerivedDomains.has('racer-id')).toBe(false);
  });
});
