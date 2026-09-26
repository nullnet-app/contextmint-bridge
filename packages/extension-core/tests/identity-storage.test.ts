import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { generateEd25519, generateX25519, toB64, ecdhX25519 } from '@fetchproxy/protocol';
import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { probeIdentityStorageForm } from '../src/identity-storage.js';
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
 * Safari-safe identity storage. WebKit's IndexedDB silently stores an X25519
 * `CryptoKey` — and any object holding one — as `null` (macOS spike,
 * chrischall/fetchproxy
 * docs/superpowers/specs/2026-09-25-contextmint-bridge-chrome-safari-design.md).
 * The vault picks a storage form by PROBING what it can hold when it mints,
 * never by sniffing the user agent: `cryptokey` (Chrome, unchanged),
 * `wrapped` (X25519 as `wrapKey` output under a non-extractable AES-GCM key),
 * `pkcs8` (AES keys nulled too: plain PKCS#8 bytes, the documented fallback).
 */

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

/** The X25519 secret the loaded identity agrees with a fresh peer, from both ends. */
async function agrees(id: { x25519PrivateKey: CryptoKey; x25519Pub: Uint8Array }): Promise<void> {
  const peer = await generateX25519();
  const peerPub = await crypto.subtle.importKey(
    'raw',
    peer.publicKey as BufferSource,
    { name: 'X25519' },
    false,
    [],
  );
  const ours = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'X25519', public: peerPub }, id.x25519PrivateKey, 256),
  );
  expect(toB64(ours)).toBe(toB64(await ecdhX25519(peer.privateKey, id.x25519Pub)));
}

afterEach(() => {
  vi.restoreAllMocks();
  __forgetVaultRunsForTests();
});

describe('probeIdentityStorageForm — a feature check, never a user-agent sniff', () => {
  it.each(VAULTS)('$name vault → $form', async (vault) => {
    vault.make();
    expect(await probeIdentityStorageForm()).toBe(vault.form);
  });

  it.each(VAULTS)('$name vault: leaves no probe key behind', async (vault) => {
    const f = vault.make();
    await probeIdentityStorageForm();
    expect(await vaultKeys(f)).toEqual([]);
  });

  it('two concurrent probes (popup + background minting at once) both see cryptokey', async () => {
    // A single fixed probe key would race: one context's delete lands between
    // the other's put and get, which reads back undefined and silently
    // downgrades a Chrome install to wrapped/pkcs8.
    freshVault();
    const puts = storePut();
    const forms = await Promise.all([
      probeIdentityStorageForm(),
      probeIdentityStorageForm(),
      probeIdentityStorageForm(),
    ]);
    expect(forms).toEqual(['cryptokey', 'cryptokey', 'cryptokey']);
    // Whatever the scheduler happened to do this run, no two probes can
    // ever share a key.
    const keys = puts.mock.calls.map((c) => c[1]);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k).toMatch(/^storageProbe:[0-9a-f-]{36}$/);
  });

  it('a probe put that fails (quota) is an error from the load, not a silent pkcs8 downgrade', async () => {
    freshVault();
    installChromeLocal();
    const original = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (typeof key === 'string' && key.startsWith('storageProbe:')) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return original.call(this, value, key);
    });
    await expect(loadOrCreateExtensionIdentity()).rejects.toThrow();
    expect(await vaultGet('identity')).toBeUndefined();
  });
});

describe.each(VAULTS)('the identity in a $name vault', (vault) => {
  let local: LocalArea;
  let f: IDBFactory;
  beforeEach(() => {
    f = vault.make();
    local = installChromeLocal();
  });

  it('loads non-extractable X25519 and Ed25519 keys, and the X25519 key agrees', async () => {
    const id = await loadOrCreateExtensionIdentity();
    expect(id.x25519PrivateKey.extractable).toBe(false);
    expect(id.ed25519PrivateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', id.x25519PrivateKey)).rejects.toThrow();
    await expect(crypto.subtle.exportKey('pkcs8', id.ed25519PrivateKey)).rejects.toThrow();
    await agrees(id);
  });

  it('comes back the same after a wake (a fresh vault run on the same profile)', async () => {
    const first = await loadOrCreateExtensionIdentity();
    __forgetVaultRunsForTests();
    const again = await loadOrCreateExtensionIdentity();
    expect(toB64(again.x25519Pub)).toBe(toB64(first.x25519Pub));
    expect(toB64(again.ed25519Pub)).toBe(toB64(first.ed25519Pub));
    expect(again.createdAt).toBe(first.createdAt);
    await agrees(again);
  });

  it('a wake that finds the stored identity probes nothing and writes nothing', async () => {
    await loadOrCreateExtensionIdentity();
    __forgetVaultRunsForTests();
    const puts = storePut();
    await loadOrCreateExtensionIdentity();
    expect(puts.mock.calls).toEqual([]);
    expect((await vaultKeys(f)).some((k) => String(k).startsWith('storageProbe:'))).toBe(false);
  });

  it('two contexts minting at once (separate vault runs) agree on ONE identity', async () => {
    const a = loadOrCreateExtensionIdentity();
    __forgetVaultRunsForTests(); // the popup's own run, beside the background's
    const b = loadOrCreateExtensionIdentity();
    const [ia, ib] = await Promise.all([a, b]);
    expect(toB64(ia.x25519Pub)).toBe(toB64(ib.x25519Pub));
    expect(toB64(ia.ed25519Pub)).toBe(toB64(ib.ed25519Pub));
    await agrees(ia);
    await agrees(ib);
  });

  it('stores the probed form and writes nothing to chrome.storage.local', async () => {
    await loadOrCreateExtensionIdentity();
    const stored = (await vaultGet('identity')) as Record<string, unknown>;
    expect(stored.form).toBe(vault.form);
    expect(local.data).toEqual({});
  });

  it('a legacy storage.local import lands in the probed form and keeps the keys', async () => {
    const legacy = await legacyStored();
    local.data['extensionIdentity'] = legacy.stored;
    await noteInstalled({ reason: 'update', previousVersion: '3.2.0' });
    const id = await loadOrCreateExtensionIdentity();
    expect(toB64(id.ed25519Pub)).toBe(legacy.edPub);
    expect(toB64(id.x25519Pub)).toBe(toB64(legacy.xPub));
    expect(id.createdAt).toBe(7);
    await agrees(id);
    expect(((await vaultGet('identity')) as Record<string, unknown>).form).toBe(vault.form);
    expect(local.data).toEqual({});
  });
});

describe('what a Safari vault holds at rest', () => {
  beforeEach(() => installChromeLocal());

  it('wrapped: no X25519 CryptoKey and no PKCS#8 plaintext; the wrapping key is non-extractable AES-GCM', async () => {
    webkitLikeVault();
    let raw: Uint8Array | null = null;
    const wrap = crypto.subtle.wrapKey.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'wrapKey').mockImplementation(async (format, key, wk, alg) => {
      // Capture the raw private key the vault must never hold in the clear.
      raw = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key)).slice(-32);
      return wrap(format, key, wk, alg);
    });
    await loadOrCreateExtensionIdentity();
    expect(raw).not.toBeNull();
    const stored = (await vaultGet('identity')) as Record<string, unknown>;
    expect(stored.form).toBe('wrapped');
    expect(
      Object.values(stored).some((v) => v instanceof CryptoKey && v.algorithm.name === 'X25519'),
    ).toBe(false);
    expect(containsBytes(stored, raw!)).toBe(false);
    const wk = await vaultGet('identityWrappingKey');
    expect(wk).toBeInstanceOf(CryptoKey);
    expect((wk as CryptoKey).algorithm.name).toBe('AES-GCM');
    expect((wk as CryptoKey).extractable).toBe(false);
  });

  it('wrapped: an imported legacy key is not stored in the clear either', async () => {
    webkitLikeVault();
    const local = installChromeLocal();
    const legacy = await legacyStored();
    local.data['extensionIdentity'] = legacy.stored;
    await noteInstalled({ reason: 'update', previousVersion: '3.2.0' });
    await loadOrCreateExtensionIdentity();
    const stored = await vaultGet('identity');
    expect((stored as Record<string, unknown>).form).toBe('wrapped');
    expect(containsBytes(stored, legacy.xPriv)).toBe(false);
  });

  it('pkcs8: the record says so, and a wake warns that the at-rest key is extractable', async () => {
    webkitLikeVault({ nullAes: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadOrCreateExtensionIdentity();
    const stored = (await vaultGet('identity')) as Record<string, unknown>;
    expect(stored.form).toBe('pkcs8');
    expect(stored.x25519Pkcs8).toBeInstanceOf(Uint8Array);
    expect(await vaultGet('identityWrappingKey')).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/extractable/));
  });

  it('cryptokey (Chrome): the record holds the non-extractable X25519 key itself, no wrapping key', async () => {
    freshVault();
    await loadOrCreateExtensionIdentity();
    const stored = (await vaultGet('identity')) as Record<string, unknown>;
    expect(stored.x25519PrivateKey).toBeInstanceOf(CryptoKey);
    expect(await vaultGet('identityWrappingKey')).toBeUndefined();
  });
});

describe('vaults written before this fix', () => {
  let local: LocalArea;
  beforeEach(() => {
    local = installChromeLocal();
  });

  it.each(VAULTS)(
    '$name: a null identity (a Safari build before the fix) is re-minted and the remote bridges kept',
    async (vault) => {
      vault.make();
      const bridge = { id: 'b1', url: 'wss://relay.example.com/bridge', token: 't', enabled: true };
      await vaultUpdate('identity', () => null);
      await vaultUpdate('remoteBridges', () => [bridge]);
      const id = await loadOrCreateExtensionIdentity();
      await agrees(id);
      expect(((await vaultGet('identity')) as Record<string, unknown>).form).toBe(vault.form);
      expect(await loadRemoteTargets()).toEqual([bridge]);
      expect(local.data).toEqual({});
    },
  );

  it('a Chrome record with no `form` field loads unchanged and is NOT rewritten', async () => {
    freshVault();
    const x = (await crypto.subtle.generateKey({ name: 'X25519' }, false, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const ed = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const record = {
      x25519PrivateKey: x.privateKey,
      x25519Pub: new Uint8Array(await crypto.subtle.exportKey('raw', x.publicKey)),
      ed25519PrivateKey: ed.privateKey,
      ed25519Pub: new Uint8Array(await crypto.subtle.exportKey('raw', ed.publicKey)),
      createdAt: 99,
    };
    await vaultUpdate('identity', () => record);
    await vaultUpdate('legacyStoresMigrated', () => true);
    const puts = storePut();
    const id = await loadOrCreateExtensionIdentity();
    expect(toB64(id.x25519Pub)).toBe(toB64(record.x25519Pub));
    expect(id.createdAt).toBe(99);
    await agrees(id);
    expect(puts.mock.calls).toEqual([]);
    expect('form' in ((await vaultGet('identity')) as object)).toBe(false);
  });

  it('a tampered wrapped record is not returned, and is NOT silently replaced by a new identity', async () => {
    // Minting over a record that exists would orphan every pairing without
    // saying so. The load fails loudly instead.
    webkitLikeVault();
    const first = await loadOrCreateExtensionIdentity();
    await vaultUpdate('identity', (cur) => {
      const r = { ...(cur as Record<string, unknown>) };
      const w = (r.x25519Wrapped as Uint8Array).slice();
      w[0] = w[0]! ^ 0xff;
      r.x25519Wrapped = w;
      return r;
    });
    __forgetVaultRunsForTests();
    await expect(loadOrCreateExtensionIdentity()).rejects.toThrow(/missing from the vault/);
    const stored = (await vaultGet('identity')) as Record<string, unknown>;
    expect(toB64(stored.x25519Pub as Uint8Array)).toBe(toB64(first.x25519Pub));
  });

  it('a wrapped record whose public key was swapped fails the consistency check', async () => {
    webkitLikeVault();
    await loadOrCreateExtensionIdentity();
    const other = await generateX25519();
    await vaultUpdate('identity', (cur) => ({
      ...(cur as Record<string, unknown>),
      x25519Pub: other.publicKey,
    }));
    __forgetVaultRunsForTests();
    await expect(loadOrCreateExtensionIdentity()).rejects.toThrow(/missing from the vault/);
  });

  it('a pkcs8 record whose public key was swapped fails the consistency check', async () => {
    webkitLikeVault({ nullAes: true });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await loadOrCreateExtensionIdentity();
    const other = await generateX25519();
    await vaultUpdate('identity', (cur) => ({
      ...(cur as Record<string, unknown>),
      x25519Pub: other.publicKey,
    }));
    __forgetVaultRunsForTests();
    await expect(loadOrCreateExtensionIdentity()).rejects.toThrow(/missing from the vault/);
  });
});
