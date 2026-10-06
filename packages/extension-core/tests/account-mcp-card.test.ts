import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideAccountMcpCard, onServerHello } from '../src/background/server-hello.js';
import { beginAccountForget, endAccountForget } from '../src/background/account-invalidation.js';
import { links, linkForMcp, type Link } from '../src/background/links.js';
import { buildHelloForAccountTest } from './helpers/hello-account.js';
import { freshVault } from './helpers/vault.js';
import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { TrustStore } from '../src/trust-store.js';
import { SessionKeys } from '../src/session-keys.js';
import { state } from '../src/background/state.js';

afterEach(() => { links.clear(); state.trust = null; state.sessions = null; state.extIdentity = null; vi.unstubAllGlobals(); });

describe('account MCP approval replay guard', () => {
  it('consumes but never replays a card after the link hello nonce changes', async () => {
    const hello = await buildHelloForAccountTest();
    const link: Link = {
      id: 'remote:target', kind: 'remote', url: 'wss://gateway.example', protocols: [], label: 'gateway',
      ws: { readyState: 1, send: () => { throw new Error('stale approval must not send ready'); } } as never,
      reconnectAttempt: 0, nextAttemptAt: 0, sessionNonce: new Uint8Array(32).fill(0xfe),
      accountAttestations: new Map(), closed: false, targetId: 'target', tokenId: 'token',
      refusal: null, notice: null, lastImmediateRedialAt: 0,
    };
    links.set(link.id, link);
    const cards: Record<string, unknown> = {
      'card-key': {
        kind: 'confirm', key: 'card-key', linkId: link.id, tokenId: 'token', origin: 'https://gateway.example',
        identityHash: '1'.repeat(64), hello,
        attestation: { type: 'account-attest', mcpId: hello.mcpId, accountId: 'acc', generation: 1,
          tokenId: 'token', kid: '0'.repeat(16), registrationId: 'reg', slug: 'server',
          identityHash: '1'.repeat(64), identityEd25519Pub: hello.identityEd25519Pub,
          scopeDigest: '0'.repeat(64), consent: 'confirm', notAfter: 1_900_000_000, sig: 'A'.repeat(88) },
        scope: { domains: ['example.com'], capabilities: ['fetch'], cookieKeys: [], localStorageKeys: [],
          sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [],
          graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [] },
        accountId: 'acc', accountSlug: 'alice', registrationSlug: 'server', serverName: 'server', consent: 'confirm',
      },
    };
    const data: Record<string, unknown> = { pendingAccountMcpCards: cards };
    (globalThis as { chrome?: unknown }).chrome = { storage: { session: {
      get: async (key: string) => ({ [key]: data[key] }),
      set: async (values: Record<string, unknown>) => Object.assign(data, values),
      remove: async (key: string) => { delete data[key]; },
    } } };
    expect(await decideAccountMcpCard('card-key', true)).toBe(false);
    expect(await decideAccountMcpCard('card-key', true)).toBe(false);
    expect(data.pendingAccountMcpCards).toBeUndefined();
  });

  it('does not approve a card while its account is being forgotten', async () => {
    const hello = await buildHelloForAccountTest();
    const link: Link = {
      id: 'remote:forgetting', kind: 'remote', url: 'wss://gateway.example', protocols: [], label: 'gateway',
      ws: { readyState: 1, send: () => { throw new Error('a forgotten card must not send ready'); } } as never,
      reconnectAttempt: 0, nextAttemptAt: 0, sessionNonce: new Uint8Array(32).fill(0xfe),
      accountAttestations: new Map(), closed: false, targetId: 'target', tokenId: 'token',
      refusal: null, notice: null, lastImmediateRedialAt: 0,
    };
    links.set(link.id, link);
    const card = {
      kind: 'confirm', key: 'card-key', linkId: link.id, tokenId: 'token', origin: 'https://gateway.example',
      identityHash: '1'.repeat(64), hello,
      attestation: { type: 'account-attest', mcpId: hello.mcpId, accountId: 'acc', generation: 1,
        tokenId: 'token', kid: '0'.repeat(16), registrationId: 'reg', slug: 'server', identityHash: '1'.repeat(64),
        identityEd25519Pub: hello.identityEd25519Pub, scopeDigest: '0'.repeat(64), consent: 'confirm',
        notAfter: 1_900_000_000, sig: 'A'.repeat(88) },
      scope: { domains: ['example.com'], capabilities: ['fetch'], cookieKeys: [], localStorageKeys: [],
        sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [],
        graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [] },
      accountId: 'acc', accountSlug: 'alice', registrationSlug: 'server', serverName: 'server', consent: 'confirm',
    };
    const data: Record<string, unknown> = { pendingAccountMcpCards: { 'card-key': card } };
    vi.stubGlobal('chrome', { storage: { session: {
      get: async (key: string) => ({ [key]: data[key] }),
      set: async (values: Record<string, unknown>) => Object.assign(data, values),
      remove: async (key: string) => { delete data[key]; },
    } } });
    beginAccountForget('https://gateway.example', 'acc');
    try {
      expect(await decideAccountMcpCard('card-key', true)).toBe(false);
      expect((data.pendingAccountMcpCards as Record<string, unknown>)['card-key']).toBeDefined();
    } finally {
      endAccountForget('https://gateway.example', 'acc');
    }
  });

  it('refuses a hello that starts while its account forget barrier is active', async () => {
    freshVault();
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: vi.fn() },
      storage: { local: {}, session: {} }, tabs: { query: async () => [] } });
    state.extIdentity = await loadOrCreateExtensionIdentity();
    state.trust = new TrustStore('1.0.0'); state.sessions = new SessionKeys();
    const hello = await buildHelloForAccountTest();
    const ws = { readyState: 1, sent: [] as string[], send(value: string) { this.sent.push(value); } };
    const link: Link = { id: 'remote:forgetting-hello', kind: 'remote', url: 'wss://gateway.example', protocols: [],
      label: 'gateway', ws: ws as never, reconnectAttempt: 0, nextAttemptAt: 0,
      sessionNonce: Uint8Array.from(atob(hello.answersExtNonce), (c) => c.charCodeAt(0)), accountAttestations: new Map(),
      closed: false, targetId: 'target', tokenId: 'token', refusal: null, notice: null, lastImmediateRedialAt: 0 };
    link.accountAttestations.set(hello.mcpId, { accountId: 'acc' } as never);
    links.set(link.id, link);
    beginAccountForget('https://gateway.example', 'acc');
    try {
      await onServerHello(link, hello);
      expect(state.sessions.get(hello.mcpId)).toBeNull();
      expect(linkForMcp(hello.mcpId)).toBeNull();
      expect(ws.sent.map((frame) => JSON.parse(frame).type)).not.toContain('ready');
    } finally {
      endAccountForget('https://gateway.example', 'acc');
    }
  });
});
