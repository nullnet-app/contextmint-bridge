/**
 * How the extension identity (`identity-keys.ts`) is kept in the vault
 * (`vault.ts`) — which is NOT the same in every browser.
 *
 * The vault's promise is that the private keys are non-extractable
 * `CryptoKey`s at rest, persisted by structured clone. WebKit breaks that for
 * X25519 only: its IndexedDB silently stores an X25519 `CryptoKey` — and any
 * object that contains one — as `null`, with no error on `put` (measured on
 * macOS Safari 27: chrischall/fetchproxy
 * docs/superpowers/specs/2026-09-25-contextmint-bridge-chrome-safari-design.md,
 * *Spike results — macOS* and *Design note — Safari-safe X25519 identity
 * storage*). Ed25519 `CryptoKey`s and `Uint8Array`s round-trip. So the record
 * the vault holds (`StoredIdentity`) comes in three forms, differing only in
 * how the X25519 private key is kept:
 *
 * - `cryptokey` — the non-extractable `CryptoKey` itself. Chrome. A record
 *   written before forms existed has no `form` field and is this form; it is
 *   never rewritten.
 * - `wrapped`   — `wrapKey('pkcs8', …)` output under a non-extractable
 *   AES-GCM-256 key kept beside it in the vault (`identityWrappingKey`).
 *   Unwrapped to a non-extractable key on load. The raw key exists only
 *   transiently in memory while minting — the exposure Chrome has during
 *   generation. Safari, as measured.
 * - `pkcs8`     — the PKCS#8 bytes as a `Uint8Array`, imported non-extractable
 *   on load. Only for an IndexedDB that nulls AES keys too; it leaves the key
 *   extractable at rest (still in the extension-origin vault, which no website
 *   or content script can open), and every wake says so on the console.
 *
 * The form is chosen by PROBING the vault — round-trip a throwaway key and see
 * what comes back — never by sniffing the user agent, and only when minting:
 * a stored record's own `form` says how to load it, so an ordinary wake writes
 * nothing. The result is never persisted, so a browser that fixes the bug is
 * probed afresh at its next mint.
 *
 * Callers never see a form: they get an `ExtensionIdentity` whose private keys
 * are non-extractable, whatever the vault had to do.
 */

import {
  generateExtensionIdentity,
  identityIsConsistent,
  importLegacyIdentity,
  isExtensionIdentity,
  isNonExtractable,
  isPub,
  type ExtensionIdentity,
} from './identity-keys.js';
import { vaultGet, vaultUpdate, type VaultKey } from './vault.js';

export type IdentityStorageForm = 'cryptokey' | 'wrapped' | 'pkcs8';

interface StoredCommon {
  x25519Pub: Uint8Array;
  /** Non-extractable in every form: WebKit keeps Ed25519 keys. */
  ed25519PrivateKey: CryptoKey;
  ed25519Pub: Uint8Array;
  createdAt: number;
}

/** What the vault's `identity` key holds. Never an X25519 `CryptoKey` outside `cryptokey`. */
export type StoredIdentity =
  | (StoredCommon & { form?: 'cryptokey'; x25519PrivateKey: CryptoKey })
  | (StoredCommon & { form: 'wrapped'; x25519Wrapped: Uint8Array; x25519Iv: Uint8Array })
  | (StoredCommon & { form: 'pkcs8'; x25519Pkcs8: Uint8Array });

/** The vault entries one identity occupies — written together, in one transaction. */
export interface StoredIdentityEntries {
  identity: StoredIdentity;
  identityWrappingKey?: CryptoKey;
}

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

const AES_GCM_IV_BYTES = 12;

function isBytes(b: unknown, length?: number): b is Uint8Array {
  return (
    b instanceof Uint8Array && (length === undefined ? b.byteLength > 0 : b.byteLength === length)
  );
}

/** The vault's `identityWrappingKey`: a non-extractable AES-GCM secret key that can unwrap. */
function isWrappingKey(k: unknown): k is CryptoKey {
  return (
    k instanceof CryptoKey &&
    k.type === 'secret' &&
    k.extractable === false &&
    k.algorithm.name === 'AES-GCM' &&
    k.usages.includes('unwrapKey')
  );
}

/**
 * Shape check for a record read back out of the vault, in any form. `null`
 * — what WebKit leaves where an X25519 key was written — is not an identity.
 */
export function isStoredIdentity(x: unknown): x is StoredIdentity {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  const common =
    isNonExtractable(r.ed25519PrivateKey, 'Ed25519', 'sign') &&
    isPub(r.x25519Pub) &&
    isPub(r.ed25519Pub) &&
    typeof r.createdAt === 'number';
  if (!common) return false;
  switch (r.form) {
    case undefined:
    case 'cryptokey':
      return isExtensionIdentity(r);
    case 'wrapped':
      return isBytes(r.x25519Wrapped) && isBytes(r.x25519Iv, AES_GCM_IV_BYTES);
    case 'pkcs8':
      return isBytes(r.x25519Pkcs8);
    default:
      return false;
  }
}

/** Put `value` under a fresh probe key, read it back in a second transaction, delete it. */
async function roundTrips(value: CryptoKey, alg: string): Promise<boolean> {
  // Unique per probe: the popup and the background both mint on first
  // install, and with one fixed key one context's delete can land between
  // the other's put and get — reading back `undefined` would silently
  // downgrade a Chrome install to `wrapped`/`pkcs8`.
  const key: VaultKey = `storageProbe:${globalThis.crypto.randomUUID()}`;
  try {
    await vaultUpdate(key, () => value);
    const back = await vaultGet(key);
    return back instanceof CryptoKey && back.algorithm.name === alg;
  } finally {
    await vaultUpdate(key, () => undefined);
  }
}

/**
 * What can this vault hold? A failing `put` (quota, a closed database) throws
 * — it is not evidence of a nulling IndexedDB and must not quietly select
 * the weakest form.
 */
export async function probeIdentityStorageForm(): Promise<IdentityStorageForm> {
  const x = (await subtle().generateKey({ name: 'X25519' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  if (await roundTrips(x.privateKey, 'X25519')) return 'cryptokey';
  const aes = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'wrapKey',
    'unwrapKey',
  ]);
  return (await roundTrips(aes, 'AES-GCM')) ? 'wrapped' : 'pkcs8';
}

/**
 * Turn an identity into the vault entries for `form`. For `wrapped`/`pkcs8`
 * the X25519 key must be extractable (`IdentityKeyOptions`); it is sealed
 * here and then dropped — callers reload the identity from the record.
 */
async function seal(
  form: IdentityStorageForm,
  id: ExtensionIdentity,
): Promise<StoredIdentityEntries> {
  const { x25519PrivateKey, ...common } = id;
  switch (form) {
    case 'cryptokey':
      return { identity: { form: 'cryptokey', x25519PrivateKey, ...common } };
    case 'wrapped': {
      const identityWrappingKey = await subtle().generateKey(
        { name: 'AES-GCM', length: 256 },
        false,
        ['wrapKey', 'unwrapKey'],
      );
      const x25519Iv = globalThis.crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
      const x25519Wrapped = new Uint8Array(
        await subtle().wrapKey('pkcs8', x25519PrivateKey, identityWrappingKey, {
          name: 'AES-GCM',
          iv: x25519Iv as BufferSource,
        }),
      );
      return { identity: { form, x25519Wrapped, x25519Iv, ...common }, identityWrappingKey };
    }
    case 'pkcs8': {
      const x25519Pkcs8 = new Uint8Array(await subtle().exportKey('pkcs8', x25519PrivateKey));
      return { identity: { form, x25519Pkcs8, ...common } };
    }
  }
}

/** Mint a fresh identity as vault entries in `form`. */
export async function mintStoredIdentity(
  form: IdentityStorageForm,
): Promise<StoredIdentityEntries> {
  return seal(form, await generateExtensionIdentity({ x25519Extractable: form !== 'cryptokey' }));
}

/**
 * Import a pre-vault `storage.local` identity (`importLegacyIdentity`, which
 * validates it and zeroes the raw bytes) as vault entries in `form`. Every
 * writer of `identity` goes through `seal`: an X25519 `CryptoKey` written
 * straight into a WebKit vault would be nulled like any other.
 */
export async function legacyStoredIdentity(
  legacy: unknown,
  form: IdentityStorageForm,
): Promise<StoredIdentityEntries | null> {
  const id = await importLegacyIdentity(legacy, { x25519Extractable: form !== 'cryptokey' });
  return id ? seal(form, id) : null;
}

/**
 * The in-memory identity for a stored record, or null when the record is
 * not this extension's identity: malformed, missing its wrapping key, failing
 * to unwrap (tampered bytes), or holding an X25519 key that does not match
 * its public half. A `cryptokey` record is returned as-is, exactly as before
 * forms existed.
 */
export async function openStoredIdentity(
  stored: unknown,
  wrappingKey: unknown,
): Promise<ExtensionIdentity | null> {
  if (!isStoredIdentity(stored)) return null;
  const common = {
    x25519Pub: stored.x25519Pub,
    ed25519PrivateKey: stored.ed25519PrivateKey,
    ed25519Pub: stored.ed25519Pub,
    createdAt: stored.createdAt,
  };
  if (stored.form === undefined || stored.form === 'cryptokey') {
    return { x25519PrivateKey: stored.x25519PrivateKey, ...common };
  }
  let x25519PrivateKey: CryptoKey;
  try {
    if (stored.form === 'wrapped') {
      if (!isWrappingKey(wrappingKey)) return null;
      x25519PrivateKey = await subtle().unwrapKey(
        'pkcs8',
        stored.x25519Wrapped as BufferSource,
        wrappingKey,
        { name: 'AES-GCM', iv: stored.x25519Iv as BufferSource },
        { name: 'X25519' },
        false,
        ['deriveBits'],
      );
    } else {
      const { x25519Pkcs8 } = stored as Extract<StoredIdentity, { form: 'pkcs8' }>;
      try {
        x25519PrivateKey = await subtle().importKey(
          'pkcs8',
          x25519Pkcs8 as BufferSource,
          { name: 'X25519' },
          false,
          ['deriveBits'],
        );
      } finally {
        // Our copy, fresh out of IndexedDB — the record itself is untouched.
        x25519Pkcs8.fill(0);
      }
    }
  } catch {
    return null;
  }
  const id: ExtensionIdentity = { x25519PrivateKey, ...common };
  return (await identityIsConsistent(id)) ? id : null;
}

/** The storage form of a stored record (a record with no `form` predates forms: `cryptokey`). */
export function storedIdentityForm(stored: StoredIdentity): IdentityStorageForm {
  return stored.form ?? 'cryptokey';
}

/** Said once per wake (vault run) for a `pkcs8` vault, so the weakening is never silent. */
export function warnExtractableAtRest(): void {
  console.warn(
    '[fetchproxy] this browser cannot keep a non-extractable X25519 key (or a wrapping key) in ' +
      'IndexedDB: the identity key-exchange key is stored as extractable PKCS#8 bytes in the ' +
      "extension's vault.",
  );
}
