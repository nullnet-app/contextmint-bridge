/**
 * The extension's long-term identity: an Ed25519 signing key held as a
 * NON-EXTRACTABLE WebCrypto key (fleet-audit #253), and an X25519 public key
 * that is only a handle.
 *
 * Before the vault the private halves were raw bytes, base64-encoded in
 * `chrome.storage.local["extensionIdentity"]` — readable by the content
 * script on every site, so one renderer compromise could lift them and pose
 * as this extension to every paired MCP (T-fake-extension). Now:
 *
 * - the Ed25519 private key is created (or imported, once, from the legacy
 *   record) with `extractable: false`. WebCrypto will sign with it, but no API
 *   will hand its bytes back, not even to extension code;
 * - it is persisted by structured clone into the extension-origin IndexedDB
 *   (`vault.ts`), which content scripts cannot open. WebKit's IndexedDB keeps
 *   Ed25519 `CryptoKey`s (it nulls X25519 ones), so this holds in every
 *   browser the bridge ships to.
 *
 * There is NO X25519 private key. Since protocol 4 the session ECDH is
 * ephemeral × ephemeral, and the long-term X25519 pub is only an identity
 * handle (trust records pin it, pair codes hash it), so the private half had
 * no caller. It is discarded the moment the pub is exported; a legacy record
 * that carries one has it checked against its pub and then dropped, and a
 * vault record from an earlier version loses it on the next wake
 * (`identity-storage.ts`). The pub itself never changes, so every pairing
 * survives.
 */

import { fromB64 } from '@fetchproxy/protocol';

export interface ExtensionIdentity {
  /** The identity handle. Its private half is never kept. */
  x25519Pub: Uint8Array;
  /** Non-extractable Ed25519 private key (`sign`). */
  ed25519PrivateKey: CryptoKey;
  ed25519Pub: Uint8Array;
  createdAt: number;
}

const subtle = (): SubtleCrypto => globalThis.crypto.subtle;

// Minimal PKCS#8 envelopes around a raw 32-byte private key (RFC 8410).
const X25519_PKCS8_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
];
const ED25519_PKCS8_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

function pkcs8(prefix: number[], raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix, 0);
  out.set(raw, prefix.length);
  return out;
}

export function isNonExtractable(k: unknown, alg: string, usage: KeyUsage): k is CryptoKey {
  return (
    typeof CryptoKey !== 'undefined' &&
    k instanceof CryptoKey &&
    k.type === 'private' &&
    k.extractable === false &&
    k.algorithm.name === alg &&
    k.usages.includes(usage)
  );
}

export function isPub(b: unknown): b is Uint8Array {
  return b instanceof Uint8Array && b.byteLength === 32;
}

/** Shape check for the identity, in memory and as the vault holds it. */
export function isExtensionIdentity(x: unknown): x is ExtensionIdentity {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  return (
    isNonExtractable(r.ed25519PrivateKey, 'Ed25519', 'sign') &&
    isPub(r.x25519Pub) &&
    isPub(r.ed25519Pub) &&
    typeof r.createdAt === 'number'
  );
}

/** Mint a fresh identity. The X25519 private key exists only until its pub is exported. */
export async function generateExtensionIdentity(): Promise<ExtensionIdentity> {
  const x = (await subtle().generateKey({ name: 'X25519' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const ed = (await subtle().generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    x25519Pub: new Uint8Array(await subtle().exportKey('raw', x.publicKey)),
    ed25519PrivateKey: ed.privateKey,
    ed25519Pub: new Uint8Array(await subtle().exportKey('raw', ed.publicKey)),
    createdAt: Date.now(),
  };
}

/** Sign `msg` with the identity's Ed25519 key (64-byte signature). */
export async function signWithExtensionIdentity(
  id: ExtensionIdentity,
  msg: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await subtle().sign({ name: 'Ed25519' }, id.ed25519PrivateKey, msg as BufferSource),
  );
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let d = 0;
  for (let i = 0; i < a.byteLength; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

function decode32(v: unknown): Uint8Array | null {
  if (typeof v !== 'string') return null;
  try {
    const b = fromB64(v);
    return b.byteLength === 32 ? b : null;
  } catch {
    return null;
  }
}

/**
 * Import a pre-#253 `storage.local["extensionIdentity"]` record as a
 * non-extractable identity, so an upgrade keeps the SAME keys and nobody has
 * to re-pair. Returns null for anything malformed or self-inconsistent — a
 * record whose private halves do not produce its public halves is not this
 * extension's identity, whoever wrote it. The X25519 private half is used for
 * that check only, then dropped.
 *
 * The raw bytes are zeroed once imported. (JavaScript cannot promise the
 * base64 strings they came from are gone from memory; they are deleted from
 * storage by the caller, which is what matters.)
 */
export async function importLegacyIdentity(stored: unknown): Promise<ExtensionIdentity | null> {
  if (!stored || typeof stored !== 'object') return null;
  const r = stored as Record<string, unknown>;
  const xPriv = decode32(r.x25519Priv);
  const xPub = decode32(r.x25519Pub);
  const edPriv = decode32(r.ed25519Priv);
  const edPub = decode32(r.ed25519Pub);
  if (!xPriv || !xPub || !edPriv || !edPub || typeof r.createdAt !== 'number') return null;
  const xEnv = pkcs8(X25519_PKCS8_PREFIX, xPriv);
  const edEnv = pkcs8(ED25519_PKCS8_PREFIX, edPriv);
  try {
    const x25519PrivateKey = await subtle().importKey(
      'pkcs8',
      xEnv as BufferSource,
      { name: 'X25519' },
      false,
      ['deriveBits'],
    );
    const ed25519PrivateKey = await subtle().importKey(
      'pkcs8',
      edEnv as BufferSource,
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    const id: ExtensionIdentity = {
      x25519Pub: xPub,
      ed25519PrivateKey,
      ed25519Pub: edPub,
      createdAt: r.createdAt,
    };
    const consistent =
      (await ed25519Matches(ed25519PrivateKey, edPub)) &&
      (await x25519Matches(x25519PrivateKey, xPub));
    return consistent ? id : null;
  } catch {
    return null;
  } finally {
    xPriv.fill(0);
    edPriv.fill(0);
    xEnv.fill(0);
    edEnv.fill(0);
  }
}

/** Does `priv` sign what `pub` verifies? Proven without exporting it. */
async function ed25519Matches(priv: CryptoKey, pub: Uint8Array): Promise<boolean> {
  const probe = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const sig = new Uint8Array(await subtle().sign({ name: 'Ed25519' }, priv, probe as BufferSource));
  const edPub = await subtle().importKey('raw', pub as BufferSource, { name: 'Ed25519' }, false, [
    'verify',
  ]);
  return subtle().verify({ name: 'Ed25519' }, edPub, sig as BufferSource, probe as BufferSource);
}

/**
 * Is `priv` the private half of `pub`? Proven without exporting it, by
 * agreeing a secret with a throwaway key from both ends.
 */
async function x25519Matches(priv: CryptoKey, pub: Uint8Array): Promise<boolean> {
  const eph = (await subtle().generateKey({ name: 'X25519' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const xPub = await subtle().importKey('raw', pub as BufferSource, { name: 'X25519' }, false, []);
  const ours = new Uint8Array(
    await subtle().deriveBits({ name: 'X25519', public: eph.publicKey }, priv, 256),
  );
  const theirs = new Uint8Array(
    await subtle().deriveBits({ name: 'X25519', public: xPub }, eph.privateKey, 256),
  );
  return bytesEqual(ours, theirs);
}
