import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { ed25519Verify, generateEd25519, generateX25519, toB64 } from '@fetchproxy/protocol';
import {
  loadOrCreateExtensionIdentity,
  signWithExtensionIdentity,
} from '../src/extension-identity.js';
import { noteInstalled, __forgetVaultRunsForTests } from '../src/vault-migration.js';
import { vaultGet, vaultUpdate } from '../src/vault.js';
import { loadRemoteTargets } from '../src/vault-records.js';
import {
  VAULTS,
  freshVault,
  installChromeLocal,
  webkitLikeVault,
  type LocalArea,
} from './helpers/vault.js';

/**
 * The identity keeps NO X25519 private key (owner decision, 2026-09-26).
 *
 * Protocol 4's session ECDH is ephemeral × ephemeral, so the long-term X25519
 * private key had no caller; the X25519 PUBLIC key is only an identity handle
 * (trust records pin it, pair codes hash it). Keeping the private half cost a
 * storage-form machine — WebKit's IndexedDB silently nulls an X25519
 * `CryptoKey` and any object holding one (macOS spike, chrischall/fetchproxy
 * docs/superpowers/specs/2026-09-25-contextmint-bridge-chrome-safari-design.md),
 * so Safari kept it wrapped (`wrapped`) or as bytes (`pkcs8`). Now the vault
 * holds the same four-field record in every browser, and a record written in
 * any of those older forms loses its private X25519 material on the next wake
 * while keeping the pub — so every pairing survives.
 */

const ID_FIELDS = ['createdAt', 'ed25519PrivateKey', 'ed25519Pub', 'x25519Pub'];
const LEGACY_FIELDS = ['form', 'x25519PrivateKey', 'x25519Wrapped', 'x25519Iv', 'x25519Pkcs8'];

/** Count object-store puts from here on (a WebKit-like vault's spy is reused, so clear it). */
function storePut(): { mock: { calls: unknown[][] } } {
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put');
  spy.mockClear();
  return spy;
}

/** Every key in the vault's `kv` store. */
async function vaultKeys(f: IDBFactory): Promise<IDBValidKey[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = f.open('fetchproxy-vault');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** Does `needle` appear as a contiguous run anywhere in the bytes of `hay`? */
function containsBytes(hay: unknown, needle: Uint8Array, seen = new Set<object>()): boolean {
  if (typeof hay !== 'object' || hay === null) return false;
  if (hay instanceof Uint8Array) {
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  }
  if (seen.has(hay)) return false;
  seen.add(hay);
  return Object.values(hay).some((v) => containsBytes(v, needle, seen));
}

/** Does `v` hold an X25519 `CryptoKey` anywhere? */
function holdsX25519Key(v: unknown, seen = new Set<object>()): boolean {
  if (typeof v !== 'object' || v === null) return false;
  if (v instanceof CryptoKey) return v.algorithm.name === 'X25519';
  if (ArrayBuffer.isView(v) || seen.has(v)) return false;
  seen.add(v);
  return Object.values(v).some((x) => holdsX25519Key(x, seen));
}

async function legacyStored(): Promise<{
  stored: Record<string, unknown>;
  xPriv: Uint8Array;
  xPub: Uint8Array;
  edPub: string;
}> {
  const x = await generateX25519();
  const ed = await generateEd25519();
  return {
    xPriv: x.privateKey.slice(),
    xPub: x.publicKey,
    edPub: toB64(ed.publicKey),
    stored: {
      x25519Priv: toB64(x.privateKey),
      x25519Pub: toB64(x.publicKey),
      ed25519Priv: toB64(ed.privateKey),
      ed25519Pub: toB64(ed.publicKey),
      createdAt: 7,
    },
  };
}

/** The Ed25519 key signs, and the signature verifies under the stored pub. */
async function signs(id: { ed25519PrivateKey: CryptoKey; ed25519Pub: Uint8Array }): Promise<void> {
  const msg = new TextEncoder().encode('ready');
  expect(
    await ed25519Verify(id.ed25519Pub, msg, await signWithExtensionIdentity(id as never, msg)),
  ).toBe(true);
}

afterEach(() => {
  vi.restoreAllMocks();
  __forgetVaultRunsForTests();
});

describe.each(VAULTS)('a fresh identity in a $name vault', (vault) => {
  let local: LocalArea;
  let f: IDBFactory;
  beforeEach(() => {
    f = vault.make();
    local = installChromeLocal();
  });

  it('has no X25519 private key: an X25519 pub, a non-extractable Ed25519 key, createdAt', async () => {
    const id = await loadOrCreateExtensionIdentity();
    expect(Object.keys(id).sort()).toEqual(ID_FIELDS);
    expect(id.x25519Pub.byteLength).toBe(32);
    expect(id.ed25519PrivateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', id.ed25519PrivateKey)).rejects.toThrow();
    await signs(id);
  });

  it('the vault holds the same four fields — no X25519 key, no wrapping key, no probe', async () => {
    const puts = storePut();
    await loadOrCreateExtensionIdentity();
    const stored = (await vaultGet('identity')) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(ID_FIELDS);
    expect(holdsX25519Key(stored)).toBe(false);
    expect((await vaultKeys(f)).sort()).toEqual(['identity', 'legacyStoresMigrated']);
    // No storage probe: nothing is ever put anywhere but the identity's own keys.
    for (const [, key] of puts.mock.calls) expect(String(key)).not.toMatch(/^storageProbe:/);
  });

  it('comes back the same after a wake (a fresh vault run on the same profile)', async () => {
    const first = await loadOrCreateExtensionIdentity();
    __forgetVaultRunsForTests();
    const again = await loadOrCreateExtensionIdentity();
    expect(toB64(again.x25519Pub)).toBe(toB64(first.x25519Pub));
    expect(toB64(again.ed25519Pub)).toBe(toB64(first.ed25519Pub));
    expect(again.createdAt).toBe(first.createdAt);
    await signs(again);
  });

  it('a wake that finds the stored identity writes nothing', async () => {
    await loadOrCreateExtensionIdentity();
    __forgetVaultRunsForTests();
    const puts = storePut();
    await loadOrCreateExtensionIdentity();
    expect(puts.mock.calls).toEqual([]);
  });

  it('two contexts minting at once (separate vault runs) agree on ONE identity', async () => {
    const a = loadOrCreateExtensionIdentity();
    __forgetVaultRunsForTests(); // the popup's own run, beside the background's
    const b = loadOrCreateExtensionIdentity();
    const [ia, ib] = await Promise.all([a, b]);
    expect(toB64(ia.x25519Pub)).toBe(toB64(ib.x25519Pub));
    expect(toB64(ia.ed25519Pub)).toBe(toB64(ib.ed25519Pub));
  });

  it('writes nothing to chrome.storage.local', async () => {
    await loadOrCreateExtensionIdentity();
    expect(local.data).toEqual({});
  });

  it('a legacy storage.local import keeps both pubs and drops the X25519 private bytes', async () => {
    const legacy = await legacyStored();
    local.data['extensionIdentity'] = legacy.stored;
    await noteInstalled({ reason: 'update', previousVersion: '3.2.0' });
    const id = await loadOrCreateExtensionIdentity();
    expect(toB64(id.ed25519Pub)).toBe(legacy.edPub);
    expect(toB64(id.x25519Pub)).toBe(toB64(legacy.xPub));
    expect(id.createdAt).toBe(7);
    expect(Object.keys(id).sort()).toEqual(ID_FIELDS);
    const stored = await vaultGet('identity');
    expect(Object.keys(stored as object).sort()).toEqual(ID_FIELDS);
    expect(containsBytes(stored, legacy.xPriv)).toBe(false);
    expect(local.data).toEqual({});
  });
});

/**
 * The three forms an earlier version could have left in the vault (#11), each
 * built the way that version built it.
 */
async function earlierRecord(form: 'none' | 'cryptokey' | 'wrapped' | 'pkcs8'): Promise<{
  record: Record<string, unknown>;
  wrappingKey?: CryptoKey;
  xPriv: Uint8Array;
}> {
  const x = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const ed = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', x.privateKey));
  const common = {
    x25519Pub: new Uint8Array(await crypto.subtle.exportKey('raw', x.publicKey)),
    ed25519PrivateKey: ed.privateKey,
    ed25519Pub: new Uint8Array(await crypto.subtle.exportKey('raw', ed.publicKey)),
    createdAt: 99,
  };
  const xPriv = pkcs8.slice(-32);
  switch (form) {
    case 'none':
    case 'cryptokey': {
      const nonExtractable = await crypto.subtle.importKey(
        'pkcs8',
        pkcs8 as BufferSource,
        { name: 'X25519' },
        false,
        ['deriveBits'],
      );
      const record = { x25519PrivateKey: nonExtractable, ...common };
      return { record: form === 'none' ? record : { form, ...record }, xPriv };
    }
    case 'wrapped': {
      const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'wrapKey',
        'unwrapKey',
      ]);
      const x25519Iv = crypto.getRandomValues(new Uint8Array(12));
      const x25519Wrapped = new Uint8Array(
        await crypto.subtle.wrapKey('pkcs8', x.privateKey, wrappingKey, {
          name: 'AES-GCM',
          iv: x25519Iv,
        }),
      );
      return { record: { form, x25519Wrapped, x25519Iv, ...common }, wrappingKey, xPriv };
    }
    case 'pkcs8':
      return { record: { form, x25519Pkcs8: pkcs8, ...common }, xPriv };
  }
}

const EARLIER_FORMS = [
  { form: 'none', name: 'Chrome, no `form` field', make: () => freshVault() },
  { form: 'cryptokey', name: 'Chrome, form cryptokey', make: () => freshVault() },
  { form: 'wrapped', name: 'Safari, form wrapped', make: () => webkitLikeVault() },
  {
    form: 'pkcs8',
    name: 'WebKit with AES nulled, form pkcs8',
    make: () => webkitLikeVault({ nullAes: true }),
  },
] as const;

describe.each(EARLIER_FORMS)('a vault written by an earlier version: $name', ({ form, make }) => {
  let f: IDBFactory;
  let earlier: Awaited<ReturnType<typeof earlierRecord>>;
  const trust = { records: { abc: { identityHash: 'abc', domains: ['x.example'] } } };
  beforeEach(async () => {
    f = make();
    installChromeLocal();
    earlier = await earlierRecord(form);
    await vaultUpdate('identity', () => earlier.record);
    if (earlier.wrappingKey) await vaultUpdate('identityWrappingKey', () => earlier.wrappingKey);
    await vaultUpdate('trustedMcps', () => trust);
    await vaultUpdate('legacyStoresMigrated', () => true);
  });

  it('keeps the SAME identity — both pubs, createdAt and the signing key — so pairings survive', async () => {
    const id = await loadOrCreateExtensionIdentity();
    expect(toB64(id.x25519Pub)).toBe(toB64(earlier.record.x25519Pub as Uint8Array));
    expect(toB64(id.ed25519Pub)).toBe(toB64(earlier.record.ed25519Pub as Uint8Array));
    expect(id.createdAt).toBe(99);
    expect(Object.keys(id).sort()).toEqual(ID_FIELDS);
    await signs(id);
    expect(await vaultGet('trustedMcps')).toEqual(trust);
  });

  it('discards the private X25519 material and the wrapping key from the vault', async () => {
    await loadOrCreateExtensionIdentity();
    const stored = (await vaultGet('identity')) as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(ID_FIELDS);
    for (const k of LEGACY_FIELDS) expect(k in stored).toBe(false);
    expect(holdsX25519Key(stored)).toBe(false);
    expect(containsBytes(stored, earlier.xPriv)).toBe(false);
    expect(await vaultGet('identityWrappingKey')).toBeUndefined();
    expect((await vaultKeys(f)).sort()).toEqual([
      'identity',
      'legacyStoresMigrated',
      'trustedMcps',
    ]);
  });

  it('migrates once: the wake after that writes nothing', async () => {
    await loadOrCreateExtensionIdentity();
    __forgetVaultRunsForTests();
    const puts = storePut();
    const again = await loadOrCreateExtensionIdentity();
    expect(puts.mock.calls).toEqual([]);
    expect(toB64(again.x25519Pub)).toBe(toB64(earlier.record.x25519Pub as Uint8Array));
  });
});

describe('earlier Safari records that could not be opened before', () => {
  beforeEach(() => installChromeLocal());

  it('a wrapped record with corrupted bytes is migrated without being unwrapped', async () => {
    // The private half is discarded unread, so its bytes no longer decide
    // whether the identity (and every pairing pinned to it) survives.
    webkitLikeVault();
    const earlier = await earlierRecord('wrapped');
    const w = (earlier.record.x25519Wrapped as Uint8Array).slice();
    w[0] = w[0]! ^ 0xff;
    await vaultUpdate('identity', () => ({ ...earlier.record, x25519Wrapped: w }));
    await vaultUpdate('legacyStoresMigrated', () => true);
    const id = await loadOrCreateExtensionIdentity();
    expect(toB64(id.x25519Pub)).toBe(toB64(earlier.record.x25519Pub as Uint8Array));
  });

  it('a wrapped record whose wrapping key is gone still keeps its identity', async () => {
    webkitLikeVault();
    const earlier = await earlierRecord('wrapped');
    await vaultUpdate('identity', () => earlier.record);
    await vaultUpdate('legacyStoresMigrated', () => true);
    const id = await loadOrCreateExtensionIdentity();
    expect(toB64(id.ed25519Pub)).toBe(toB64(earlier.record.ed25519Pub as Uint8Array));
  });
});

describe('a null identity (a Safari build before #11)', () => {
  it.each(VAULTS)('$name: is re-minted and the remote bridges kept', async (vault) => {
    vault.make();
    const local = installChromeLocal();
    const bridge = { id: 'b1', url: 'wss://relay.example.com/bridge', token: 't', enabled: true };
    await vaultUpdate('identity', () => null);
    await vaultUpdate('remoteBridges', () => [bridge]);
    const id = await loadOrCreateExtensionIdentity();
    await signs(id);
    expect(Object.keys((await vaultGet('identity')) as object).sort()).toEqual(ID_FIELDS);
    expect(await loadRemoteTargets()).toEqual([bridge]);
    expect(local.data).toEqual({});
  });
});
