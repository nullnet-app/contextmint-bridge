import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  accountAttestPayload, accountKeyId, ed25519Sign, fromB64, generateEd25519, scopeDigest, sha256, toB64, toHex,
} from '@fetchproxy/protocol';
import { freshVault } from './helpers/vault.js';
import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { TrustStore } from '../src/trust-store.js';
import { AccountTrustStore } from '../src/account-trust-store.js';
import { SessionKeys } from '../src/session-keys.js';
import { state } from '../src/background/state.js';
import { links, type Link } from '../src/background/links.js';
import { onServerHello } from '../src/background/server-hello.js';
import { decideAccountMcpCard } from '../src/background/server-hello.js';
import { buildHelloForAccountTest } from './helpers/hello-account.js';

class OpenSocket {
  static OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send(value: string): void { this.sent.push(value); }
}

function area(): { get: (key: string | string[]) => Promise<Record<string, unknown>>; set: (value: Record<string, unknown>) => Promise<void>; remove: (key: string | string[]) => Promise<void> } {
  const data: Record<string, unknown> = {};
  return {
    get: async (key) => {
      const keys = Array.isArray(key) ? key : [key];
      return Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    set: async (value) => { Object.assign(data, value); },
    remove: async (key) => { for (const k of Array.isArray(key) ? key : [key]) delete data[k]; },
  };
}

afterEach(() => {
  links.clear();
  state.trust = null; state.sessions = null; state.extIdentity = null;
});

describe('account MCP one-tap approval', () => {
  it('replays the exact approved hello and sends Ready without writing trustedMcps', async () => {
    freshVault();
    const local = area(); const session = area();
    vi.stubGlobal('WebSocket', OpenSocket);
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: () => {} },
      storage: { local, session },
      tabs: { query: async () => [], create: async ({ url }: { url: string }) => ({ id: 12, url }) },
    });
    const identity = await loadOrCreateExtensionIdentity();
    state.extIdentity = identity;
    state.trust = new TrustStore('1.0.0');
    state.sessions = new SessionKeys();
    const hello = await buildHelloForAccountTest();
    const accountKey = await generateEd25519();
    const kid = await accountKeyId(accountKey.publicKey);
    const identityHash = toHex(await sha256(fromB64(hello.identityX25519Pub)));
    const now = Math.floor(Date.now() / 1000);
    const attestation = {
      type: 'account-attest' as const, mcpId: hello.mcpId, accountId: 'acc_test', generation: 2,
      tokenId: 'token_test', kid, registrationId: 'reg_test', slug: 'zillow', identityHash,
      identityEd25519Pub: hello.identityEd25519Pub, scopeDigest: await scopeDigest(hello),
      consent: 'confirm' as const, notAfter: now + 300, sig: '',
    };
    attestation.sig = toB64(await ed25519Sign(accountKey.privateKey, accountAttestPayload({
      gatewayOrigin: 'https://gateway.example', accountId: attestation.accountId,
      generation: attestation.generation, tokenId: attestation.tokenId,
      registrationId: attestation.registrationId, slug: attestation.slug, identityHash,
      identityEd25519Pub: fromB64(hello.identityEd25519Pub), scopeDigest: attestation.scopeDigest,
      consent: attestation.consent, mcpId: hello.mcpId,
      mcpHelloNonce: fromB64(hello.sessionNonce), answersExtNonce: fromB64(hello.answersExtNonce),
      notAfter: attestation.notAfter,
    })));
    const kidPublicKey = toB64(accountKey.publicKey);
    await new AccountTrustStore().put({ origin: 'https://gateway.example', accountId: 'acc_test',
      slug: 'chris', displayName: 'Chris', tokenId: 'token_test', kid, publicKey: kidPublicKey,
      generation: 2, generationHighWater: 2, approvedAt: now * 1000 });
    const ws = new OpenSocket();
    const link: Link = { id: 'remote:target', kind: 'remote', url: 'wss://gateway.example/bridge',
      protocols: [], label: 'gateway', ws: ws as never, reconnectAttempt: 0, nextAttemptAt: 0,
      sessionNonce: fromB64(hello.answersExtNonce), accountAttestations: new Map([[hello.mcpId, attestation]]),
      closed: false, handoff: false, targetId: 'target', tokenId: 'token_test', refusal: null, lastImmediateRedialAt: 0 };
    links.set(link.id, link);
    const trustedMcpWrite = vi.spyOn(state.trust, 'put');

    await onServerHello(link, hello);
    expect(ws.sent).toHaveLength(0);
    const queued = await session.get('pendingAccountMcpCards');
    const cards = queued.pendingAccountMcpCards as Record<string, { key: string }>;
    const card = Object.values(cards)[0]!;
    expect(card.key).toBeTruthy();

    expect(await decideAccountMcpCard(card.key, true)).toBe(true);
    const sent = ws.sent.map((frame) => JSON.parse(frame) as { type: string; mcpId?: string });
    expect(sent.filter((frame) => frame.type === 'ready' && frame.mcpId === hello.mcpId)).toHaveLength(1);
    expect(state.sessions.get(hello.mcpId)).not.toBeNull();
    expect(trustedMcpWrite).not.toHaveBeenCalled();
    expect(await new AccountTrustStore().getDerived(identityHash)).toMatchObject({
      origin: 'https://gateway.example', accountId: 'acc_test', registrationId: 'reg_test',
      slug: 'zillow', scope: { domains: ['zillow.com'] }, approvedScope: { domains: ['zillow.com'] },
    });
  });
});
