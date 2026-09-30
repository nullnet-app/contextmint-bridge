import { describe, expect, it } from 'vitest';
import { clearAccountAttestations, storeAccountAttestation, takeAccountAttestation, type Link } from '../src/background/links.js';
import type { AccountAttestFrame } from '@fetchproxy/protocol';

function link(id: string, tokenId: string): Link {
  return { id, kind: 'remote', url: 'wss://gateway.example', protocols: [], label: id,
    ws: null, reconnectAttempt: 0, nextAttemptAt: 0, sessionNonce: null,
    accountAttestations: new Map(), closed: false, handoff: false, targetId: id,
    tokenId, refusal: null, lastImmediateRedialAt: 0 };
}
const frame = (mcpId: string, tokenId = 'token'): AccountAttestFrame => ({
  type: 'account-attest', mcpId, accountId: 'account', generation: 1, tokenId,
  kid: '0000000000000000', registrationId: 'registration', slug: 'server',
  identityHash: '0'.repeat(64), identityEd25519Pub: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  scopeDigest: '0'.repeat(64), consent: 'silent', notAfter: 10, sig: 'A'.repeat(88),
});

describe('link-bound account attestations', () => {
  it('does not share across links and consumes each attestation once', () => {
    const a = link('a', 'token'); const b = link('b', 'token');
    const attestation = frame('server:1.0.0:0123456789abcdef');
    expect(storeAccountAttestation(a, attestation)).toBe(true);
    expect(takeAccountAttestation(b, attestation.mcpId)).toBeUndefined();
    expect(takeAccountAttestation(a, attestation.mcpId)).toBe(attestation);
    expect(takeAccountAttestation(a, attestation.mcpId)).toBeUndefined();
  });

  it('requires the link credential token and clears on its next extension hello', () => {
    const a = link('a', 'token');
    expect(storeAccountAttestation(a, frame('server:1.0.0:0123456789abcdef', 'other'))).toBe(false);
    const attestation = frame('server:1.0.0:0123456789abcdef');
    storeAccountAttestation(a, attestation);
    clearAccountAttestations(a);
    expect(takeAccountAttestation(a, attestation.mcpId)).toBeUndefined();
  });
});
