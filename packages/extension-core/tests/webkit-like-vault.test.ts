import { describe, it, expect, afterEach, vi } from 'vitest';
import { vaultGet, vaultUpdate } from '../src/vault.js';
import { freshVault, webkitLikeVault } from './helpers/vault.js';

/**
 * Self-test for the WebKit simulation every Safari identity test stands on:
 * if the helper stopped nulling, those tests would pass against the bug.
 */

async function roundTrip(value: unknown): Promise<unknown> {
  await vaultUpdate('identity', () => value);
  return vaultGet('identity');
}

const x25519 = async (): Promise<CryptoKey> =>
  ((await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair)
    .privateKey;
const ed25519 = async (): Promise<CryptoKey> =>
  ((await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign'])) as CryptoKeyPair)
    .privateKey;
const aes = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);

describe('webkitLikeVault — WebKit IndexedDB nulls X25519 CryptoKeys', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stores an X25519 key as null', async () => {
    webkitLikeVault();
    expect(await roundTrip(await x25519())).toBeNull();
  });

  it('stores an object that contains an X25519 key as null — the whole object', async () => {
    webkitLikeVault();
    expect(await roundTrip({ a: 1, nested: { k: await x25519() } })).toBeNull();
  });

  it('round-trips an Ed25519 key, a Uint8Array and an AES-GCM key', async () => {
    webkitLikeVault();
    const ed = await roundTrip(await ed25519());
    expect(ed).toBeInstanceOf(CryptoKey);
    expect((ed as CryptoKey).algorithm.name).toBe('Ed25519');
    expect(await roundTrip(new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]));
    expect(((await roundTrip(await aes())) as CryptoKey).algorithm.name).toBe('AES-GCM');
  });

  it('nullAes: an AES-GCM key is nulled too', async () => {
    webkitLikeVault({ nullAes: true });
    expect(await roundTrip(await aes())).toBeNull();
    expect(await roundTrip(await ed25519())).toBeInstanceOf(CryptoKey);
  });

  it('degrades only its own factory: a plain vault beside it keeps X25519 keys', async () => {
    webkitLikeVault();
    freshVault();
    expect(await roundTrip(await x25519())).toBeInstanceOf(CryptoKey);
  });
});
