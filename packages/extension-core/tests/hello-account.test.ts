import { describe, expect, it, vi } from 'vitest';
import {
  accountAttestPayload, accountKeyId, ed25519Sign, ed25519Verify, fromB64, generateEd25519,
  scopeDigest, toB64, toHex, sha256,
  type HelloFrameFromServer,
} from '@fetchproxy/protocol';
import { handleServerHello } from '../src/background/hello.js';
import { buildHelloForAccountTest } from './helpers/hello-account.js';

const NOW = 1_800_000_000;
async function signedAttestation(hello: Awaited<ReturnType<typeof buildHelloForAccountTest>>, changes: Partial<{
  consent: 'silent' | 'confirm' | 'confirm-each'; scopeDigest: string; notAfter: number;
  mcpHelloNonce: Uint8Array; answersExtNonce: Uint8Array;
}> = {}) {
  const key = await generateEd25519();
  const kid = await accountKeyId(key.publicKey);
  const hash = toHex(await sha256(fromB64(hello.identityX25519Pub)));
  const attestation = {
    type: 'account-attest' as const, mcpId: hello.mcpId, accountId: 'acc_test', generation: 2,
    tokenId: 'brt_test', kid, registrationId: 'reg_test', slug: 'zillow', identityHash: hash,
    identityEd25519Pub: hello.identityEd25519Pub, scopeDigest: changes.scopeDigest ?? await scopeDigest(hello),
    consent: changes.consent ?? 'silent', notAfter: changes.notAfter ?? NOW + 300, sig: '',
  };
  attestation.sig = toB64(await ed25519Sign(key.privateKey, accountAttestPayload({
    gatewayOrigin: 'https://gateway.example', accountId: attestation.accountId,
    generation: attestation.generation, tokenId: attestation.tokenId,
    registrationId: attestation.registrationId, slug: attestation.slug,
    identityHash: hash, identityEd25519Pub: fromB64(hello.identityEd25519Pub),
    scopeDigest: attestation.scopeDigest, consent: attestation.consent,
    mcpId: hello.mcpId, mcpHelloNonce: changes.mcpHelloNonce ?? fromB64(hello.sessionNonce),
    answersExtNonce: changes.answersExtNonce ?? new Uint8Array(32).fill(0xcd), notAfter: attestation.notAfter,
  })));
  return { attestation, signingKey: key.privateKey, account: {
    origin: 'https://gateway.example', tokenId: 'brt_test', record: {
      origin: 'https://gateway.example', accountId: 'acc_test', slug: 'chris', displayName: 'Chris',
      tokenId: 'brt_test', kid, publicKey: toB64(key.publicKey), generation: 2, generationHighWater: 2, approvedAt: 0,
    },
  } };
}

describe('account attestation verification in the hello decision', () => {
  it('labels an existing trusted MCP only when the same account key attests the exact hello', async () => {
    const hello = await buildHelloForAccountTest();
    const { attestation, account } = await signedAttestation(hello);
    const nowSeconds = NOW;
    const trustRecord = {
      serverName: hello.serverName, domains: hello.domains, capabilities: ['fetch'],
      cookieKeys: [], localStorageKeys: [], sessionStorageKeys: [], captureHeaders: [],
      indexedDbScopes: [], domSelectors: [], domListSelectors: [], graphqlOps: [],
      localStoragePointers: [], sessionStoragePointers: [],
      identityX25519Pub: hello.identityX25519Pub, identityEd25519Pub: hello.identityEd25519Pub,
      extensionIdentityX25519Pub: toB64(new Uint8Array(32).fill(0xab)),
    } as never;
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => trustRecord) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds,
      account,
      attestation,
    });
    expect(result.kind).toBe('auto-trust');
    if (result.kind === 'auto-trust') expect(result.attestedBy).toEqual({
      accountId: 'acc_test', slug: 'chris', origin: 'https://gateway.example',
    });
  });

  it('keeps a narrower trustedMcps grant authoritative despite a valid account attestation', async () => {
    const base = await buildHelloForAccountTest();
    const hello = { ...base, capabilities: ['fetch', 'read_cookies'] as never, cookieKeys: ['session_id'] };
    const { account, attestation } = await signedAttestation(hello);
    const trustRecord = {
      serverName: hello.serverName, domains: hello.domains, capabilities: ['fetch'],
      cookieKeys: [], localStorageKeys: [], sessionStorageKeys: [], captureHeaders: [],
      indexedDbScopes: [], domSelectors: [], domListSelectors: [], graphqlOps: [],
      localStoragePointers: [], sessionStoragePointers: [],
      identityX25519Pub: hello.identityX25519Pub, identityEd25519Pub: hello.identityEd25519Pub,
      extensionIdentityX25519Pub: toB64(new Uint8Array(32).fill(0xab)),
    } as never;
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => trustRecord) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account, attestation,
    });
    expect(result.kind).toBe('auto-trust');
    if (result.kind === 'auto-trust') {
      expect(result.attestedBy).toEqual({ accountId: 'acc_test', slug: 'chris', origin: 'https://gateway.example' });
      expect(result.capabilities).toEqual(['fetch']);
      expect(result.cookieKeys).toEqual([]);
      expect(result.pendingScopeUpdate?.declaredCapabilities).toEqual(['fetch', 'read_cookies']);
    }
  });

  it('silently attaches a valid silent attestation with the declared scope', async () => {
    const hello = await buildHelloForAccountTest();
    const { account, attestation } = await signedAttestation(hello);
    const putTrustedMcp = vi.fn();
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null), put: putTrustedMcp } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account, attestation, accountDerived: null,
    });
    expect(result.kind).toBe('account-silent');
    expect(putTrustedMcp).not.toHaveBeenCalled();
    if (result.kind === 'account-silent') {
      expect(result.domains).toEqual(['zillow.com']);
      expect(result.capabilities).toEqual(['fetch']);
      expect(result.accountDerivedUpdate?.firstSeen).toBe(true);
      expect(result.sessionKey).toBeInstanceOf(Uint8Array);
    }
  });

  it('fails the attestation when it was correctly signed for a different MCP hello nonce', async () => {
    const hello = await buildHelloForAccountTest();
    const { account, attestation } = await signedAttestation(hello, {
      mcpHelloNonce: new Uint8Array(32).fill(0x44),
    });
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account, attestation,
    });
    expect(result.kind).toBe('needs-pair');
    if (result.kind === 'needs-pair') expect(result.vouched).toBe(false);
  });

  it('does not replay a correctly signed attestation from a different live link nonce', async () => {
    const hello = await buildHelloForAccountTest();
    const { account, attestation } = await signedAttestation(hello, {
      answersExtNonce: new Uint8Array(32).fill(0x55),
    });
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      // The current live link's nonce differs from the nonce the gateway
      // signed into this otherwise valid attestation.
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account, attestation,
    });
    expect(result.kind).toBe('needs-pair');
    if (result.kind === 'needs-pair') expect(result.vouched).toBe(false);
  });

  it('uses ordinary person pairing when no account attestation accompanies the hello', async () => {
    const hello = await buildHelloForAccountTest();
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
    });
    expect(result.kind).toBe('needs-pair');
    if (result.kind === 'needs-pair') {
      expect(result.vouched).toBeUndefined();
      expect(result.pairCode).toMatch(/^\d{4}-\d{4}$/);
    }
  });

  it('uses a no-code account confirmation for digest mismatch and high-risk domains', async () => {
    const hello = await buildHelloForAccountTest();
    const mismatch = await signedAttestation(hello, { scopeDigest: '0'.repeat(64) });
    const deps = { trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account: mismatch.account, attestation: mismatch.attestation };
    expect((await handleServerHello(hello, deps)).kind).toBe('account-confirm');

    const riskyHello = { ...hello, domains: ['bank.example'] };
    const risky = await signedAttestation(riskyHello);
    expect((await handleServerHello(riskyHello, { ...deps, account: risky.account, attestation: risky.attestation })).kind).toBe('account-confirm');
  });

  it('asks every session for confirm-each even when a persistent approved scope exists', async () => {
    const hello = await buildHelloForAccountTest();
    const { account, attestation } = await signedAttestation(hello, { consent: 'confirm-each' });
    const scope = { domains: hello.domains, capabilities: ['fetch'], cookieKeys: [], localStorageKeys: [],
      sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [],
      graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [] };
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account, attestation, accountDerived: { origin: account.origin, accountId: 'acc_test', registrationId: 'reg_test',
        slug: 'zillow', scope, approvedScope: scope, firstSeenAt: 0, lastSeenAt: 0 },
    });
    expect(result.kind).toBe('account-confirm');
    const approvedThisSession = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account, attestation, accountDerived: { origin: account.origin, accountId: 'acc_test', registrationId: 'reg_test',
        slug: 'zillow', scope, approvedScope: scope, firstSeenAt: 0, lastSeenAt: 0 },
      sessionApprovedScope: scope,
    });
    expect(approvedThisSession.kind).toBe('account-silent');
  });

  it('digests declared scope before capability availability is subtracted', async () => {
    const hello = { ...(await buildHelloForAccountTest()), capabilities: ['fetch', 'read_cookies'] as never };
    const { account, attestation } = await signedAttestation(hello);
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account, attestation, unavailableCapabilities: new Set(['read_cookies']),
    });
    expect(result.kind).toBe('account-silent');
    if (result.kind === 'account-silent') expect(result.capabilities).toEqual(['fetch']);
  });

  it('does not reuse another account identity’s derived approval', async () => {
    const hello = await buildHelloForAccountTest();
    const { account, attestation } = await signedAttestation(hello, { consent: 'confirm' });
    const scope = { domains: hello.domains, capabilities: ['fetch'], cookieKeys: [], localStorageKeys: [],
      sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [],
      graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [] };
    const accountADerived = { origin: 'https://other-account.example', accountId: 'acc_account_a',
      registrationId: 'reg_account_a', slug: 'alpha', scope, approvedScope: scope, firstSeenAt: 1, lastSeenAt: 1 };
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account, attestation, accountDerived: accountADerived,
    });
    expect(result.kind).toBe('account-confirm');
  });

  it('keeps a remembered narrower approval as the grant and offers account scope growth', async () => {
    const base = await buildHelloForAccountTest();
    const hello = { ...base, capabilities: ['fetch', 'read_cookies'] as never, cookieKeys: ['session_id'] };
    const { account, attestation } = await signedAttestation(hello, { consent: 'confirm' });
    const approved = { domains: ['zillow.com'], capabilities: ['fetch'], cookieKeys: [], localStorageKeys: [],
      sessionStorageKeys: [], captureHeaders: [], indexedDbScopes: [], domSelectors: [], domListSelectors: [],
      graphqlOps: [], localStoragePointers: [], sessionStoragePointers: [] };
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account, attestation, accountDerived: { origin: account.origin, accountId: 'acc_test', registrationId: 'reg_test',
        slug: 'zillow', scope: approved, approvedScope: approved, firstSeenAt: 1, lastSeenAt: 1 },
    });
    expect(result.kind).toBe('account-silent');
    if (result.kind === 'account-silent') {
      expect(result.capabilities).toEqual(['fetch']);
      expect(result.cookieKeys).toEqual([]);
      expect(result.pendingAccountScopeUpdate?.declared.cookieKeys).toEqual(['session_id']);
    }
  });

  it('fails closed when any signed identity, credential, nonce, origin, generation, or expiry binding changes', async () => {
    const hello = await buildHelloForAccountTest();
    const base = await signedAttestation(hello);
    const mutations: Array<{ label: string; mutate: (att: typeof base.attestation, account: typeof base.account, hello: HelloFrameFromServer) => void; resign: boolean }> = [
      { label: 'mcpId binding', mutate: (att) => { att.mcpId = 'else:1.0.0:0123456789abcdef'; }, resign: true },
      { label: 'accountId binding', mutate: (att) => { att.accountId = 'other'; }, resign: true },
      { label: 'generation binding', mutate: (att) => { att.generation++; }, resign: true },
      { label: 'tokenId binding', mutate: (att) => { att.tokenId = 'other'; }, resign: true },
      { label: 'key id binding', mutate: (att) => { att.kid = '0000000000000000'; }, resign: true },
      { label: 'identity hash binding', mutate: (att) => { att.identityHash = '0'.repeat(64); }, resign: true },
      { label: 'identity Ed25519 key binding', mutate: (att) => { att.identityEd25519Pub = toB64(new Uint8Array(32)); }, resign: true },
      { label: 'expiry bound', mutate: (att) => { att.notAfter = NOW - 1; }, resign: true },
      { label: 'trusted account origin binding', mutate: (_att, account) => { account.origin = 'https://other.example'; }, resign: true },
    ];
    for (const { label, mutate, resign } of mutations) {
      const attestation = structuredClone(base.attestation);
      const account = structuredClone(base.account);
      const helloCopy = structuredClone(hello);
      mutate(attestation, account, helloCopy);
      if (resign) {
        attestation.sig = toB64(await ed25519Sign(base.signingKey, accountAttestPayload({
          gatewayOrigin: account.origin, accountId: attestation.accountId,
          generation: attestation.generation, tokenId: attestation.tokenId,
          registrationId: attestation.registrationId, slug: attestation.slug,
          identityHash: attestation.identityHash,
          // The signed payload binds the actual hello identity key; a mismatch
          // in the frame's parallel field must still fail its explicit compare.
          identityEd25519Pub: fromB64(helloCopy.identityEd25519Pub),
          scopeDigest: attestation.scopeDigest, consent: attestation.consent,
          // Likewise the verifier supplies the trusted hello id and nonces.
          mcpId: helloCopy.mcpId, mcpHelloNonce: fromB64(helloCopy.sessionNonce),
          answersExtNonce: new Uint8Array(32).fill(0xcd), notAfter: attestation.notAfter,
        })));
        expect(await ed25519Verify(fromB64(account.record.publicKey), accountAttestPayload({
          gatewayOrigin: account.origin, accountId: attestation.accountId,
          generation: attestation.generation, tokenId: attestation.tokenId,
          registrationId: attestation.registrationId, slug: attestation.slug,
          identityHash: attestation.identityHash,
          identityEd25519Pub: fromB64(helloCopy.identityEd25519Pub),
          scopeDigest: attestation.scopeDigest, consent: attestation.consent,
          mcpId: helloCopy.mcpId, mcpHelloNonce: fromB64(helloCopy.sessionNonce),
          answersExtNonce: new Uint8Array(32).fill(0xcd), notAfter: attestation.notAfter,
        }), fromB64(attestation.sig)), `${label}: mutated signed payload should verify`).toBe(true);
      }
      const result = await handleServerHello(helloCopy, {
        trust: { get: vi.fn(async () => null) } as never,
        extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
        extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
        account, attestation,
      });
      expect(result.kind, `${label}: ${JSON.stringify(attestation)}`).toBe('needs-pair');
    }
  });

  it('routes a validly re-signed scope digest mismatch to explicit confirmation', async () => {
    const hello = await buildHelloForAccountTest();
    const base = await signedAttestation(hello);
    const attestation = { ...base.attestation, scopeDigest: '0'.repeat(64) };
    attestation.sig = toB64(await ed25519Sign(base.signingKey, accountAttestPayload({
      gatewayOrigin: base.account.origin, accountId: attestation.accountId,
      generation: attestation.generation, tokenId: attestation.tokenId,
      registrationId: attestation.registrationId, slug: attestation.slug,
      identityHash: attestation.identityHash,
      identityEd25519Pub: fromB64(hello.identityEd25519Pub), scopeDigest: attestation.scopeDigest,
      consent: attestation.consent, mcpId: hello.mcpId,
      mcpHelloNonce: fromB64(hello.sessionNonce), answersExtNonce: new Uint8Array(32).fill(0xcd),
      notAfter: attestation.notAfter,
    })));
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd), nowSeconds: NOW,
      account: base.account, attestation,
    });
    expect(result.kind).toBe('account-confirm');
  });

  it('does not label when a signed attestation names another mcpId', async () => {
    const hello = await buildHelloForAccountTest();
    const result = await handleServerHello(hello, {
      trust: { get: vi.fn(async () => null) } as never,
      extensionIdentityX25519Pub: new Uint8Array(32).fill(0xab),
      extensionSessionNonce: new Uint8Array(32).fill(0xcd),
      account: { origin: 'https://gateway.example', tokenId: 'brt_test', record: {
        origin: 'https://gateway.example', accountId: 'acc_test', slug: 'chris', displayName: 'Chris',
        tokenId: 'brt_test', kid: '0000000000000000', publicKey: toB64(new Uint8Array(32)),
        generation: 2, generationHighWater: 2, approvedAt: 0,
      } },
      attestation: { type: 'account-attest', mcpId: 'different', accountId: 'acc_test', generation: 2,
        tokenId: 'brt_test', kid: '0000000000000000', registrationId: 'reg_test', slug: 'zillow',
        identityHash: '0'.repeat(64), identityEd25519Pub: toB64(new Uint8Array(32)),
        scopeDigest: '0'.repeat(64), consent: 'silent', notAfter: 1, sig: toB64(new Uint8Array(64)) },
    });
    expect(result.kind).toBe('needs-pair');
  });
});
