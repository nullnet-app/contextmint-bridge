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
import { bindMcpToLink, links, unbindLink, type Link } from '../src/background/links.js';
import { onServerHello } from '../src/background/server-hello.js';
import { decideAccountMcpCard } from '../src/background/server-hello.js';
import { forgetAccountInBackground } from '../src/background/account-forget.js';
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
  vi.restoreAllMocks();
  for (const link of links.values()) unbindLink(link);
  links.clear();
  state.trust = null; state.sessions = null; state.extIdentity = null;
  mcpDomains.clear(); mcpCapabilities.clear(); mcpCookieKeys.clear(); mcpAccountDerivedDomains.clear();
});

describe('account MCP one-tap approval', () => {
  it('does not let a hello paused after account lookup restore a forgotten account session or derived trust', async () => {
    freshVault();
    const local = area(); const session = area();
    vi.stubGlobal('WebSocket', OpenSocket);
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: vi.fn() },
      storage: { local, session }, tabs: { query: async () => [] } });
    state.extIdentity = await loadOrCreateExtensionIdentity();
    state.trust = new TrustStore('1.0.0'); state.sessions = new SessionKeys();
    const hello = await buildHelloForAccountTest();
    const key = await generateEd25519(); const kid = await accountKeyId(key.publicKey);
    const identityHash = toHex(await sha256(fromB64(hello.identityX25519Pub)));
    const now = Math.floor(Date.now() / 1000);
    const scope = { domains: hello.domains, capabilities: hello.capabilities ?? [], cookieKeys: hello.cookieKeys ?? [],
      localStorageKeys: hello.localStorageKeys ?? [], sessionStorageKeys: hello.sessionStorageKeys ?? [], captureHeaders: hello.captureHeaders ?? [],
      indexedDbScopes: hello.indexedDbScopes ?? [], domSelectors: hello.domSelectors ?? [], domListSelectors: hello.domListSelectors ?? [],
      graphqlOps: hello.graphqlOps ?? [], localStoragePointers: hello.localStoragePointers ?? [], sessionStoragePointers: hello.sessionStoragePointers ?? [] };
    const attestation = { type: 'account-attest' as const, mcpId: hello.mcpId, accountId: 'race-account', generation: 1,
      tokenId: 'race-token', kid, registrationId: 'race-reg', slug: 'acct', identityHash,
      identityEd25519Pub: hello.identityEd25519Pub, scopeDigest: await scopeDigest(hello), consent: 'silent' as const,
      notAfter: now + 300, sig: '' };
    attestation.sig = toB64(await ed25519Sign(key.privateKey, accountAttestPayload({
      gatewayOrigin: 'https://gateway.example', accountId: attestation.accountId, generation: 1, tokenId: attestation.tokenId,
      registrationId: attestation.registrationId, slug: attestation.slug, identityHash,
      identityEd25519Pub: fromB64(hello.identityEd25519Pub), scopeDigest: attestation.scopeDigest, consent: 'silent',
      mcpId: hello.mcpId, mcpHelloNonce: fromB64(hello.sessionNonce), answersExtNonce: fromB64(hello.answersExtNonce),
      notAfter: attestation.notAfter,
    })));
    const accounts = new AccountTrustStore();
    await accounts.put({ origin: 'https://gateway.example', accountId: attestation.accountId, slug: 'acct', displayName: 'Acct',
      tokenId: attestation.tokenId, kid, publicKey: toB64(key.publicKey), generation: 1, generationHighWater: 1, approvedAt: now * 1000 });
    await accounts.putDerived(identityHash, { origin: 'https://gateway.example', accountId: attestation.accountId,
      registrationId: attestation.registrationId, slug: attestation.slug, scope, approvedScope: scope,
      firstSeenAt: now * 1000, lastSeenAt: now * 1000 });
    const link: Link = { id: 'remote:race', kind: 'remote', url: 'wss://gateway.example/bridge', protocols: [], label: 'race',
      ws: new OpenSocket() as never, reconnectAttempt: 0, nextAttemptAt: 0, sessionNonce: fromB64(hello.answersExtNonce),
      accountAttestations: new Map([[hello.mcpId, attestation]]), closed: false, handoff: false, targetId: 'race',
      tokenId: attestation.tokenId, refusal: null, lastImmediateRedialAt: 0 };
    links.set(link.id, link);
    const originalGet = AccountTrustStore.prototype.get;
    let accountRead!: () => void; let resume!: () => void;
    const readDone = new Promise<void>((resolve) => { accountRead = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let paused = false;
    vi.spyOn(AccountTrustStore.prototype, 'get').mockImplementation(async function (this: AccountTrustStore, origin, accountId) {
      const record = await originalGet.call(this, origin, accountId);
      if (accountId === attestation.accountId && !paused) { paused = true; accountRead(); await gate; }
      return record;
    });
    const pendingHello = onServerHello(link, hello);
    await readDone;
    await forgetAccountInBackground('https://gateway.example', attestation.accountId, false);
    resume();
    await pendingHello;
    expect(state.sessions.get(hello.mcpId)).toBeNull();
    expect(mcpDomains.has(hello.mcpId)).toBe(false);
    expect(mcpAccountDerivedDomains.has(hello.mcpId)).toBe(false);
    expect(await accounts.getDerived(identityHash)).toBeNull();
    expect((link.ws as unknown as OpenSocket).sent.map((frame) => JSON.parse(frame).type)).not.toContain('ready');
  });

  it('does not attach or send ready when forget races a hand-paired hello provenance write', async () => {
    freshVault();
    const local = area(); const session = area();
    vi.stubGlobal('WebSocket', OpenSocket);
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: vi.fn() },
      storage: { local, session }, tabs: { query: async () => [] } });
    state.extIdentity = await loadOrCreateExtensionIdentity();
    const trust = new TrustStore('1.0.0'); state.trust = trust; state.sessions = new SessionKeys();
    const hello = await buildHelloForAccountTest();
    const identityHash = toHex(await sha256(fromB64(hello.identityX25519Pub)));
    const key = await generateEd25519(); const kid = await accountKeyId(key.publicKey); const now = Math.floor(Date.now() / 1000);
    const attestation = { type: 'account-attest' as const, mcpId: hello.mcpId, accountId: 'paired-race', generation: 1,
      tokenId: 'paired-token', kid, registrationId: 'paired-reg', slug: 'acct', identityHash,
      identityEd25519Pub: hello.identityEd25519Pub, scopeDigest: await scopeDigest(hello), consent: 'silent' as const,
      notAfter: now + 300, sig: '' };
    attestation.sig = toB64(await ed25519Sign(key.privateKey, accountAttestPayload({
      gatewayOrigin: 'https://gateway.example', accountId: attestation.accountId, generation: 1, tokenId: attestation.tokenId,
      registrationId: attestation.registrationId, slug: attestation.slug, identityHash,
      identityEd25519Pub: fromB64(hello.identityEd25519Pub), scopeDigest: attestation.scopeDigest, consent: 'silent',
      mcpId: hello.mcpId, mcpHelloNonce: fromB64(hello.sessionNonce), answersExtNonce: fromB64(hello.answersExtNonce),
      notAfter: attestation.notAfter,
    })));
    await new AccountTrustStore().put({ origin: 'https://gateway.example', accountId: attestation.accountId, slug: 'acct', displayName: 'Acct',
      tokenId: attestation.tokenId, kid, publicKey: toB64(key.publicKey), generation: 1, generationHighWater: 1, approvedAt: now * 1000 });
    await trust.put(identityHash, { serverName: hello.serverName, identityX25519Pub: hello.identityX25519Pub,
      identityEd25519Pub: hello.identityEd25519Pub, domains: hello.domains, capabilities: hello.capabilities ?? [],
      extensionIdentityX25519Pub: toB64(state.extIdentity!.x25519Pub),
      extensionIdentityEd25519Pub: toB64(state.extIdentity!.ed25519Pub) });
    const link: Link = { id: 'remote:paired-race', kind: 'remote', url: 'wss://gateway.example/bridge', protocols: [], label: 'paired-race',
      ws: new OpenSocket() as never, reconnectAttempt: 0, nextAttemptAt: 0, sessionNonce: fromB64(hello.answersExtNonce),
      accountAttestations: new Map([[hello.mcpId, attestation]]), closed: false, handoff: false, targetId: 'paired-race',
      tokenId: attestation.tokenId, refusal: null, lastImmediateRedialAt: 0 };
    links.set(link.id, link);
    const original = trust.setAttestedBy.bind(trust);
    let writeDone!: () => void; let resume!: () => void;
    const written = new Promise<void>((resolve) => { writeDone = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    vi.spyOn(trust, 'setAttestedBy').mockImplementation(async (...args) => {
      const result = await original(...args); writeDone(); await gate; return result;
    });
    const pendingHello = onServerHello(link, hello);
    await Promise.race([written, pendingHello.then(() => { throw new Error('hello completed without a provenance write'); })]);
    await forgetAccountInBackground('https://gateway.example', attestation.accountId, true);
    resume();
    await pendingHello;
    expect(state.sessions.get(hello.mcpId)).toBeNull();
    expect(mcpDomains.has(hello.mcpId)).toBe(false);
    expect((link.ws as unknown as OpenSocket).sent.map((frame) => JSON.parse(frame).type)).not.toContain('ready');
  });

  it('does not let a pending account approval restore derived trust after forget', async () => {
    freshVault();
    const local = area(); const session = area();
    vi.stubGlobal('WebSocket', OpenSocket);
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: vi.fn() },
      storage: { local, session }, tabs: { query: async () => [] } });
    state.sessions = new SessionKeys();
    const hello = await buildHelloForAccountTest();
    const identityHash = toHex(await sha256(fromB64(hello.identityX25519Pub)));
    const now = Math.floor(Date.now() / 1000);
    const attestation = { type: 'account-attest' as const, mcpId: hello.mcpId, accountId: 'approval-race', generation: 4,
      tokenId: 'approval-token', kid: 'kid', registrationId: 'approval-reg', slug: 'acct', identityHash,
      identityEd25519Pub: hello.identityEd25519Pub, scopeDigest: '0'.repeat(64), consent: 'confirm' as const,
      notAfter: now + 300, sig: '' };
    await new AccountTrustStore().put({ origin: 'https://gateway.example', accountId: attestation.accountId, slug: 'acct', displayName: 'Acct',
      tokenId: attestation.tokenId, kid: attestation.kid, publicKey: 'unused', generation: 4, generationHighWater: 4, approvedAt: now * 1000 });
    const link: Link = { id: 'remote:approval-race', kind: 'remote', url: 'wss://gateway.example/bridge', protocols: [], label: 'approval-race',
      ws: new OpenSocket() as never, reconnectAttempt: 0, nextAttemptAt: 0, sessionNonce: fromB64(hello.answersExtNonce),
      accountAttestations: new Map([[hello.mcpId, attestation]]), closed: false, handoff: false, targetId: 'approval-race',
      tokenId: attestation.tokenId, refusal: null, lastImmediateRedialAt: 0 };
    links.set(link.id, link); bindMcpToLink(hello.mcpId, link);
    const scope = { domains: hello.domains, capabilities: hello.capabilities ?? [], cookieKeys: [], localStorageKeys: [],
      sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [], graphqlOps: [],
      localStoragePointers: [], sessionStoragePointers: [] };
    const card = { kind: 'confirm', key: 'approval-card', linkId: link.id, tokenId: link.tokenId, origin: 'https://gateway.example',
      identityHash, hello, attestation, scope, accountId: attestation.accountId, accountSlug: 'acct', registrationSlug: 'acct',
      serverName: hello.serverName, consent: 'confirm' };
    await session.set({ pendingAccountMcpCards: { 'approval-card': card } });
    const originalPut = AccountTrustStore.prototype.putDerived;
    let writeStarted!: () => void; let resumeWrite!: () => void;
    const started = new Promise<void>((resolve) => { writeStarted = resolve; });
    const gate = new Promise<void>((resolve) => { resumeWrite = resolve; });
    vi.spyOn(AccountTrustStore.prototype, 'putDerived').mockImplementation(async function (this: AccountTrustStore, hash, record) {
      writeStarted(); await gate; await originalPut.call(this, hash, record);
    });
    const decision = decideAccountMcpCard('approval-card', true);
    await started;
    await forgetAccountInBackground('https://gateway.example', attestation.accountId, false);
    resumeWrite();
    expect(await decision).toBe(false);
    expect(await new AccountTrustStore().getDerived(identityHash)).toBeNull();
    expect((await session.get('accountMcpSessionApprovals')).accountMcpSessionApprovals).toBeUndefined();
    expect(state.sessions?.get(hello.mcpId)).toBeNull();
  });

  it('does not let a pending confirm-each approval restore session approval after forget', async () => {
    freshVault();
    const local = area(); const backing = area();
    let approvalWrite!: () => void; let resumeWrite!: () => void;
    const started = new Promise<void>((resolve) => { approvalWrite = resolve; });
    const gate = new Promise<void>((resolve) => { resumeWrite = resolve; });
    const session = { ...backing, set: async (value: Record<string, unknown>) => {
      if ('accountMcpSessionApprovals' in value) { approvalWrite(); await gate; }
      await backing.set(value);
    } };
    vi.stubGlobal('WebSocket', OpenSocket);
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: vi.fn() },
      storage: { local, session }, tabs: { query: async () => [] } });
    const hello = await buildHelloForAccountTest();
    const identityHash = toHex(await sha256(fromB64(hello.identityX25519Pub)));
    const now = Math.floor(Date.now() / 1000);
    const attestation = { type: 'account-attest' as const, mcpId: hello.mcpId, accountId: 'session-approval-race', generation: 5,
      tokenId: 'session-approval-token', kid: 'kid', registrationId: 'session-approval-reg', slug: 'acct', identityHash,
      identityEd25519Pub: hello.identityEd25519Pub, scopeDigest: '0'.repeat(64), consent: 'confirm-each' as const,
      notAfter: now + 300, sig: '' };
    await new AccountTrustStore().put({ origin: 'https://gateway.example', accountId: attestation.accountId, slug: 'acct', displayName: 'Acct',
      tokenId: attestation.tokenId, kid: attestation.kid, publicKey: 'unused', generation: 5, generationHighWater: 5, approvedAt: now * 1000 });
    const link: Link = { id: 'remote:session-approval-race', kind: 'remote', url: 'wss://gateway.example/bridge', protocols: [], label: 'session-approval-race',
      ws: new OpenSocket() as never, reconnectAttempt: 0, nextAttemptAt: 0, sessionNonce: fromB64(hello.answersExtNonce),
      accountAttestations: new Map([[hello.mcpId, attestation]]), closed: false, handoff: false, targetId: 'session-approval-race',
      tokenId: attestation.tokenId, refusal: null, lastImmediateRedialAt: 0 };
    links.set(link.id, link); bindMcpToLink(hello.mcpId, link);
    const scope = { domains: hello.domains, capabilities: hello.capabilities ?? [], cookieKeys: [], localStorageKeys: [],
      sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [], graphqlOps: [],
      localStoragePointers: [], sessionStoragePointers: [] };
    const card = { kind: 'confirm', key: 'session-approval-card', linkId: link.id, tokenId: link.tokenId, origin: 'https://gateway.example',
      identityHash, hello, attestation, scope, accountId: attestation.accountId, accountSlug: 'acct', registrationSlug: 'acct',
      serverName: hello.serverName, consent: 'confirm-each' };
    await session.set({ pendingAccountMcpCards: { 'session-approval-card': card } });
    const decision = decideAccountMcpCard('session-approval-card', true);
    await started;
    await forgetAccountInBackground('https://gateway.example', attestation.accountId, false);
    resumeWrite();
    expect(await decision).toBe(false);
    expect((await session.get('accountMcpSessionApprovals')).accountMcpSessionApprovals).toBeUndefined();
  });

  it('allows a silent digest-mismatch card, remembers its scope, and attaches a later subset', async () => {
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
    const hello = { ...(await buildHelloForAccountTest()), domains: ['zillow.com', 'shop.zillow.com'] };
    const accountKey = await generateEd25519();
    const kid = await accountKeyId(accountKey.publicKey);
    const identityHash = toHex(await sha256(fromB64(hello.identityX25519Pub)));
    const now = Math.floor(Date.now() / 1000);
    const attestation = {
      type: 'account-attest' as const, mcpId: hello.mcpId, accountId: 'acc_test', generation: 2,
      tokenId: 'token_test', kid, registrationId: 'reg_test', slug: 'zillow', identityHash,
      identityEd25519Pub: hello.identityEd25519Pub, scopeDigest: '0'.repeat(64),
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
      slug: 'zillow', scope: { domains: ['zillow.com', 'shop.zillow.com'] },
      approvedScope: { domains: ['zillow.com', 'shop.zillow.com'] },
    });

    // A fresh hello for the same identity declares a strict subset. Its newly
    // signed digest is valid, and the explicit card decision should now make
    // it attach without prompting again.
    const subsetHello = { ...hello, domains: ['zillow.com'] };
    const subsetDigest = await scopeDigest(subsetHello);
    const subsetAttestation = { ...attestation, scopeDigest: subsetDigest, sig: '' };
    subsetAttestation.sig = toB64(await ed25519Sign(accountKey.privateKey, accountAttestPayload({
      gatewayOrigin: 'https://gateway.example', accountId: subsetAttestation.accountId,
      generation: subsetAttestation.generation, tokenId: subsetAttestation.tokenId,
      registrationId: subsetAttestation.registrationId, slug: subsetAttestation.slug, identityHash,
      identityEd25519Pub: fromB64(subsetHello.identityEd25519Pub), scopeDigest: subsetDigest,
      consent: 'silent', mcpId: subsetHello.mcpId, mcpHelloNonce: fromB64(subsetHello.sessionNonce),
      answersExtNonce: fromB64(subsetHello.answersExtNonce), notAfter: subsetAttestation.notAfter,
    })));
    link.accountAttestations = new Map([[subsetHello.mcpId, subsetAttestation]]);
    ws.sent.length = 0;
    await onServerHello(link, subsetHello);
    expect((await session.get('pendingAccountMcpCards')).pendingAccountMcpCards).toBeUndefined();
    expect(ws.sent.map((frame) => JSON.parse(frame) as { type: string }).some((frame) => frame.type === 'ready')).toBe(true);
    expect(mcpDomains.get(subsetHello.mcpId)).toEqual(['zillow.com']);

    // confirm-each deliberately ignores the persistent approval. Allowing its
    // card adds a session approval, but must not change the stored grant.
    const eachAttestation = { ...subsetAttestation, consent: 'confirm-each' as const, sig: '' };
    eachAttestation.sig = toB64(await ed25519Sign(accountKey.privateKey, accountAttestPayload({
      gatewayOrigin: 'https://gateway.example', accountId: eachAttestation.accountId,
      generation: eachAttestation.generation, tokenId: eachAttestation.tokenId,
      registrationId: eachAttestation.registrationId, slug: eachAttestation.slug, identityHash,
      identityEd25519Pub: fromB64(subsetHello.identityEd25519Pub), scopeDigest: eachAttestation.scopeDigest,
      consent: eachAttestation.consent, mcpId: subsetHello.mcpId,
      mcpHelloNonce: fromB64(subsetHello.sessionNonce), answersExtNonce: fromB64(subsetHello.answersExtNonce),
      notAfter: eachAttestation.notAfter,
    })));
    link.accountAttestations = new Map([[subsetHello.mcpId, eachAttestation]]);
    await onServerHello(link, subsetHello);
    const eachCards = (await session.get('pendingAccountMcpCards')).pendingAccountMcpCards as Record<string, { key: string }>;
    expect(Object.keys(eachCards)).toHaveLength(1);
    expect(await decideAccountMcpCard(Object.values(eachCards)[0]!.key, true)).toBe(true);
    expect(await new AccountTrustStore().getDerived(identityHash)).toMatchObject({
      approvedScope: { domains: ['zillow.com', 'shop.zillow.com'], capabilities: ['fetch'] },
    });
    expect((await session.get('accountMcpSessionApprovals')).accountMcpSessionApprovals)
      .toHaveProperty(identityHash);
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
