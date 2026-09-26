/**
 * Test helpers for the extension's IndexedDB vault (`src/vault.ts`).
 *
 * The vault is the extension-origin IndexedDB, which content scripts cannot
 * open. Under vitest there is no IndexedDB, so each test installs a FRESH
 * in-memory one from `fake-indexeddb` — a brand-new factory is a brand-new
 * profile, which is what the old per-test `chrome.storage.local` mocks gave.
 *
 * `mockLocalArea()` is the other half of the threat model these tests encode:
 * it is `chrome.storage.local`, the area a compromised renderer's content
 * script CAN read and write. Tests hand its `data` object to the "attacker"
 * and assert what that does and does not buy.
 */
import { vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';

export function freshVault(): IDBFactory {
  const f = new IDBFactory();
  (globalThis as { indexedDB?: IDBFactory }).indexedDB = f;
  return f;
}

/** Does `v` — or anything reachable inside it — hold a CryptoKey of an algorithm in `algs`? */
function holdsKeyOf(v: unknown, algs: ReadonlySet<string>, seen = new Set<object>()): boolean {
  if (typeof v !== 'object' || v === null) return false;
  if (v instanceof CryptoKey) return algs.has(v.algorithm.name);
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  if (seen.has(v)) return false;
  seen.add(v);
  const values = v instanceof Map ? [...v.keys(), ...v.values()] : Object.values(v);
  return values.some((x) => holdsKeyOf(x, algs, seen));
}

/** Databases opened through a `webkitLikeVault()` factory — the only ones it degrades. */
const webkitDbs = new WeakMap<IDBDatabase, ReadonlySet<string>>();

/**
 * A `freshVault()` that stores values the way WebKit's IndexedDB does
 * (macOS Safari 27, measured in the spike — chrischall/fetchproxy
 * docs/superpowers/specs/2026-09-25-contextmint-bridge-chrome-safari-design.md,
 * *Spike results — macOS*): a `put` of an X25519 `CryptoKey`, or of any value
 * that contains one, silently stores `null`. No error. Ed25519 keys and
 * `Uint8Array`s round-trip. `nullAes` extends the nulling to AES-GCM keys —
 * the "even a wrapping key cannot be kept" fallback.
 *
 * Only databases opened through THIS factory are degraded, so a test can hold
 * a plain vault and a WebKit-like one side by side. The `put` patch lives on
 * the fake-indexeddb object-store prototype; call `vi.restoreAllMocks()` in
 * `afterEach` to take it off.
 */
export function webkitLikeVault({ nullAes = false }: { nullAes?: boolean } = {}): IDBFactory {
  const f = freshVault();
  const algs = new Set(nullAes ? ['X25519', 'AES-GCM'] : ['X25519']);
  const open = f.open.bind(f);
  f.open = (name: string, version?: number) => {
    const req = open(name, version);
    req.addEventListener('success', () => webkitDbs.set(req.result, algs));
    return req;
  };
  const proto = IDBObjectStore.prototype as unknown as {
    put: (this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest;
  };
  if (!vi.isMockFunction(proto.put)) {
    const original = proto.put;
    vi.spyOn(proto, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      const nulled = webkitDbs.get(this.transaction.db);
      return original.call(this, nulled && holdsKeyOf(value, nulled) ? null : value, key);
    });
  }
  return f;
}

export interface LocalArea {
  data: Record<string, unknown>;
  get: (k: string | string[]) => Promise<Record<string, unknown>>;
  set: (kv: Record<string, unknown>) => Promise<void>;
  remove: (k: string | string[]) => Promise<void>;
}

export function mockLocalArea(data: Record<string, unknown> = {}): LocalArea {
  return {
    data,
    get: async (k) => {
      const ks = Array.isArray(k) ? k : [k];
      const out: Record<string, unknown> = {};
      for (const x of ks) if (x in data) out[x] = data[x];
      return out;
    },
    set: async (kv) => {
      Object.assign(data, kv);
    },
    remove: async (k) => {
      for (const x of Array.isArray(k) ? k : [k]) delete data[x];
    },
  };
}

/**
 * Install `chrome.storage.local` as the given area, plus a fresh
 * `chrome.storage.session` (trusted contexts only in a real browser — the
 * area the upgrade authorisation lives in; see `chromeSession()`).
 */
export function installChromeLocal(area: LocalArea = mockLocalArea()): LocalArea {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: { local: area, session: mockLocalArea() },
  };
  return area;
}

/** The `chrome.storage.session` mock `installChromeLocal` installed. */
export function chromeSession(): LocalArea {
  return (globalThis as unknown as { chrome: { storage: { session: LocalArea } } }).chrome.storage
    .session;
}

/**
 * The three vaults the identity must survive, by the storage form each one
 * forces: Chrome's (X25519 keys persist), Safari's as measured (X25519 keys
 * nulled, AES keys persist), and a worse WebKit (AES keys nulled too).
 */
export const VAULTS = [
  { name: 'plain (Chrome)', form: 'cryptokey', make: () => freshVault() },
  { name: 'WebKit-like (Safari)', form: 'wrapped', make: () => webkitLikeVault() },
  {
    name: 'WebKit-like, AES nulled too',
    form: 'pkcs8',
    make: () => webkitLikeVault({ nullAes: true }),
  },
] as const;
