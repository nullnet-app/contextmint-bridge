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
import { links, unbindLink, type Link } from '../src/background/links.js';
import { onServerHello } from '../src/background/server-hello.js';
import { decideAccountMcpCard } from '../src/background/server-hello.js';
import { mcpAccountDerivedDomains, mcpCapabilities, mcpCookieKeys, mcpDomains, mcpIdentityHash } from '../src/background/session-scope.js';
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
  for (const link of links.values()) unbindLink(link);
  links.clear();
  state.trust = null; state.sessions = null; state.extIdentity = null;
  mcpDomains.clear(); mcpCapabilities.clear(); mcpCookieKeys.clear(); mcpAccountDerivedDomains.clear();
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

  it('applies an allowed account scope expansion to the live session and remembers the expanded grant', async () => {
    freshVault();
    const local = area(); const session = area();
    vi.stubGlobal('WebSocket', OpenSocket);
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: () => {} },
      storage: { local, session },
      tabs: { query: async () => [], create: async ({ url }: { url: string }) => ({ id: 12, url }) },
      scripting: { executeScript: async () => [] },
    });
    const identity = await loadOrCreateExtensionIdentity();
    state.extIdentity = identity;
    state.trust = new TrustStore('1.0.0');
    state.sessions = new SessionKeys();
    const hello = { ...(await buildHelloForAccountTest()), capabilities: ['fetch', 'read_cookies'] as never,
      cookieKeys: ['session_id'] };
    const accountKey = await generateEd25519();
    const kid = await accountKeyId(accountKey.publicKey);
    const identityHash = toHex(await sha256(fromB64(hello.identityX25519Pub)));
    const now = Math.floor(Date.now() / 1000);
    const attestation = {
      type: 'account-attest' as const, mcpId: hello.mcpId, accountId: 'acc_test', generation: 2,
      tokenId: 'token_test', kid, registrationId: 'reg_test', slug: 'zillow', identityHash,
      identityEd25519Pub: hello.identityEd25519Pub, scopeDigest: await scopeDigest(hello),
      consent: 'silent' as const, notAfter: now + 300, sig: '',
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
    await new AccountTrustStore().put({ origin: 'https://gateway.example', accountId: 'acc_test', slug: 'chris',
      displayName: 'Chris', tokenId: 'token_test', kid, publicKey: toB64(accountKey.publicKey), generation: 2,
      generationHighWater: 2, approvedAt: now * 1000 });
    const narrow = { domains: ['zillow.com'], capabilities: ['fetch'], cookieKeys: [], localStorageKeys: [],
      sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [],
      graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [] };
    await new AccountTrustStore().putDerived(identityHash, { origin: 'https://gateway.example', accountId: 'acc_test',
      registrationId: 'reg_test', slug: 'zillow', scope: narrow, approvedScope: narrow,
      firstSeenAt: now * 1000, lastSeenAt: now * 1000 });
    const ws = new OpenSocket();
    const link: Link = { id: 'remote:expand', kind: 'remote', url: 'wss://gateway.example/bridge',
      protocols: [], label: 'gateway', ws: ws as never, reconnectAttempt: 0, nextAttemptAt: 0,
      sessionNonce: fromB64(hello.answersExtNonce), accountAttestations: new Map([[hello.mcpId, attestation]]),
      closed: false, handoff: false, targetId: 'expand', tokenId: 'token_test', refusal: null, lastImmediateRedialAt: 0 };
    links.set(link.id, link);

    await onServerHello(link, hello);
    expect(state.sessions.get(hello.mcpId)).not.toBeNull();
    expect(mcpCapabilities.get(hello.mcpId)).toEqual(['fetch']);
    expect(mcpCookieKeys.get(hello.mcpId)).toEqual([]);
    const queued = await session.get('pendingAccountMcpCards');
    const cards = queued.pendingAccountMcpCards as Record<string, { key: string; kind: string }>;
    const card = Object.values(cards).find((candidate) => candidate.kind === 'scope-update')!;
    expect(card).toBeTruthy();

    expect(await decideAccountMcpCard(card.key, true)).toBe(true);
    expect(mcpCapabilities.get(hello.mcpId)).toEqual(['fetch', 'read_cookies']);
    expect(mcpCookieKeys.get(hello.mcpId)).toEqual(['session_id']);
    expect(mcpDomains.get(hello.mcpId)).toEqual(['zillow.com']);
    expect(await new AccountTrustStore().getDerived(identityHash)).toMatchObject({
      approvedScope: { domains: ['zillow.com'], capabilities: ['fetch', 'read_cookies'], cookieKeys: ['session_id'] },
    });
  });

  it('applies an approved account scope expansion to the already attached live session', async () => {
    freshVault();
    const local = area(); const session = area();
    vi.stubGlobal('WebSocket', OpenSocket);
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: () => {} },
      storage: { local, session },
      tabs: { query: async () => [], create: async ({ url }: { url: string }) => ({ id: 12, url }) },
      scripting: { executeScript: async () => [] },
    });
    const identity = await loadOrCreateExtensionIdentity();
    state.extIdentity = identity;
    state.trust = new TrustStore('1.0.0');
    state.sessions = new SessionKeys();
    const hello = { ...(await buildHelloForAccountTest()), capabilities: ['fetch', 'read_cookies'] as never,
      cookieKeys: ['session_id'] };
    const accountKey = await generateEd25519();
    const kid = await accountKeyId(accountKey.publicKey);
    const identityHash = toHex(await sha256(fromB64(hello.identityX25519Pub)));
    const now = Math.floor(Date.now() / 1000);
    const attestation = {
      type: 'account-attest' as const, mcpId: hello.mcpId, accountId: 'acc_test', generation: 2,
      tokenId: 'token_test', kid, registrationId: 'reg_test', slug: 'zillow', identityHash,
      identityEd25519Pub: hello.identityEd25519Pub, scopeDigest: await scopeDigest(hello),
      consent: 'silent' as const, notAfter: now + 300, sig: '',
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
    await new AccountTrustStore().put({ origin: 'https://gateway.example', accountId: 'acc_test', slug: 'chris',
      displayName: 'Chris', tokenId: 'token_test', kid, publicKey: toB64(accountKey.publicKey), generation: 2,
      generationHighWater: 2, approvedAt: now * 1000 });
    const narrow = { domains: ['zillow.com'], capabilities: ['fetch'], cookieKeys: [], localStorageKeys: [],
      sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [],
      graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [] };
    await new AccountTrustStore().putDerived(identityHash, { origin: 'https://gateway.example', accountId: 'acc_test',
      registrationId: 'reg_test', slug: 'zillow', scope: narrow, approvedScope: narrow,
      firstSeenAt: now * 1000, lastSeenAt: now * 1000 });
    const ws = new OpenSocket();
    const link: Link = { id: 'remote:target', kind: 'remote', url: 'wss://gateway.example/bridge',
      protocols: [], label: 'gateway', ws: ws as never, reconnectAttempt: 0, nextAttemptAt: 0,
      sessionNonce: fromB64(hello.answersExtNonce), accountAttestations: new Map([[hello.mcpId, attestation]]),
      closed: false, handoff: false, targetId: 'target', tokenId: 'token_test', refusal: null, lastImmediateRedialAt: 0 };
    links.set(link.id, link);

    await onServerHello(link, hello);
    expect(state.sessions.get(hello.mcpId)).not.toBeNull();
    expect(mcpCapabilities.get(hello.mcpId)).toEqual(['fetch']);
    expect(mcpCookieKeys.get(hello.mcpId)).toEqual([]);
    expect(mcpDomains.get(hello.mcpId)).toEqual(['zillow.com']);
    const queued = await session.get('pendingAccountMcpCards');
    const cards = queued.pendingAccountMcpCards as Record<string, { key: string; kind: string }>;
    const card = Object.values(cards).find((candidate) => candidate.kind === 'scope-update')!;
    expect(card).toBeTruthy();

    // The old link can remain open after its mcpId is unbound and rebound to
    // another live link. A stale scope-update must not bless or mutate the
    // replacement session that happens to reuse that mcpId.
    const originalPutDerived = AccountTrustStore.prototype.putDerived;
    let markWriteStarted!: () => void;
    let releaseWrite!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    vi.spyOn(AccountTrustStore.prototype, 'putDerived').mockImplementation(async function (this: AccountTrustStore, hash, derived) {
      await originalPutDerived.call(this, hash, derived);
      if (hash === identityHash) {
        markWriteStarted();
        await writeGate;
      }
    });
    const decision = decideAccountMcpCard(card.key, true);
    await writeStarted;
    unbindLink(link);
    const helloB = await buildHelloForAccountTest();
    const accountKeyB = await generateEd25519();
    const kidB = await accountKeyId(accountKeyB.publicKey);
    const identityHashB = toHex(await sha256(fromB64(helloB.identityX25519Pub)));
    const attestationB = {
      type: 'account-attest' as const, mcpId: helloB.mcpId, accountId: 'acc_other', generation: 1,
      tokenId: 'token_other', kid: kidB, registrationId: 'reg_other', slug: 'zillow', identityHash: identityHashB,
      identityEd25519Pub: helloB.identityEd25519Pub, scopeDigest: await scopeDigest(helloB),
      consent: 'silent' as const, notAfter: now + 300, sig: '',
    };
    attestationB.sig = toB64(await ed25519Sign(accountKeyB.privateKey, accountAttestPayload({
      gatewayOrigin: 'https://gateway.example', accountId: attestationB.accountId,
      generation: attestationB.generation, tokenId: attestationB.tokenId,
      registrationId: attestationB.registrationId, slug: attestationB.slug, identityHash: identityHashB,
      identityEd25519Pub: fromB64(helloB.identityEd25519Pub), scopeDigest: attestationB.scopeDigest,
      consent: attestationB.consent, mcpId: helloB.mcpId,
      mcpHelloNonce: fromB64(helloB.sessionNonce), answersExtNonce: fromB64(helloB.answersExtNonce),
      notAfter: attestationB.notAfter,
    })));
    await new AccountTrustStore().put({ origin: 'https://gateway.example', accountId: 'acc_other', slug: 'chris',
      displayName: 'Chris', tokenId: 'token_other', kid: kidB, publicKey: toB64(accountKeyB.publicKey),
      generation: 1, generationHighWater: 1, approvedAt: now * 1000 });
    const linkB: Link = { id: 'remote:target-b', kind: 'remote', url: 'wss://gateway.example/bridge',
      protocols: [], label: 'gateway B', ws: new OpenSocket() as never, reconnectAttempt: 0, nextAttemptAt: 0,
      sessionNonce: fromB64(helloB.answersExtNonce), accountAttestations: new Map([[helloB.mcpId, attestationB]]),
      closed: false, handoff: false, targetId: 'target-b', tokenId: 'token_other', refusal: null, lastImmediateRedialAt: 0 };
    links.set(linkB.id, linkB);
    await onServerHello(linkB, helloB);
    expect(state.sessions.get(helloB.mcpId)).not.toBeNull();
    expect(mcpIdentityHash.get(helloB.mcpId)).toBe(identityHashB);
    expect(mcpCapabilities.get(helloB.mcpId)).toEqual(['fetch']);

    releaseWrite();
    expect(await decision).toBe(false);
    expect(await new AccountTrustStore().getDerived(identityHash)).toMatchObject({
      approvedScope: { domains: ['zillow.com'], capabilities: ['fetch', 'read_cookies'], cookieKeys: ['session_id'] },
    });
    expect(mcpIdentityHash.get(helloB.mcpId)).toBe(identityHashB);
    expect(mcpCapabilities.get(helloB.mcpId)).toEqual(['fetch']);
    expect(mcpCookieKeys.get(helloB.mcpId)).toEqual([]);

  });
});
