import { afterEach, describe, expect, it } from 'vitest';
import { decideAccountMcpCard } from '../src/background/server-hello.js';
import { links, type Link } from '../src/background/links.js';
import { buildHelloForAccountTest } from './helpers/hello-account.js';

afterEach(() => { links.clear(); });

describe('account MCP approval replay guard', () => {
  it('consumes but never replays a card after the link hello nonce changes', async () => {
    const hello = await buildHelloForAccountTest();
    const link: Link = {
      id: 'remote:target', kind: 'remote', url: 'wss://gateway.example', protocols: [], label: 'gateway',
      ws: { readyState: 1, send: () => { throw new Error('stale approval must not send ready'); } } as never,
      reconnectAttempt: 0, nextAttemptAt: 0, sessionNonce: new Uint8Array(32).fill(0xfe),
      accountAttestations: new Map(), closed: false, handoff: false, targetId: 'target', tokenId: 'token',
      refusal: null, lastImmediateRedialAt: 0,
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
});
