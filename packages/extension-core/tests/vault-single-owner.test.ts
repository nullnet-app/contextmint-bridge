import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { generateEd25519, generateX25519, toB64 } from '@fetchproxy/protocol';
import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import {
  armInstallSignal,
  ensureVault,
  ensureVaultAsOwner,
  noteInstalled,
  ENSURE_VAULT_MESSAGE,
  __forgetVaultRunsForTests,
  __resetInstallSignalForTests,
  __setVaultRoleForTests,
} from '../src/vault-migration.js';
import { vaultGet } from '../src/vault.js';
import { TrustStore } from '../src/trust-store.js';
import { loadRemoteTargets } from '../src/vault-records.js';
import { freshVault, installChromeLocal, type LocalArea } from './helpers/vault.js';

/**
 * fleet-audit #1001: only the background (service worker / Safari event page)
 * may create or migrate the vault. The popup is a separate context: Chrome
 * starts the new worker on an update and only then dispatches onInstalled, so
 * a popup opened in that gap used to find an empty vault, see no install
 * signal (only the worker arms one), mint a fresh identity and purge the
 * legacy one — every pairing gone. A popup now asks the background to
 * initialise and only ever reads.
 */

async function legacyIdentity(): Promise<{ stored: Record<string, unknown>; edPub: string }> {
  const x = await generateX25519();
  const ed = await generateEd25519();
  return {
    edPub: toB64(ed.publicKey),
    stored: {
      x25519Priv: toB64(x.privateKey),
      x25519Pub: toB64(x.publicKey),
      ed25519Priv: toB64(ed.privateKey),
      ed25519Pub: toB64(ed.publicKey),
      createdAt: 1,
    },
  };
}

const BRIDGE = { id: 'b1', url: 'wss://relay.example.com/bridge', token: 't', enabled: true };
const TRUST = {
  records: {
    abc: { identityHash: 'abc', serverName: 'paired-mcp', domains: ['example.com'] },
  },
};

/**
 * Wire `chrome.runtime.sendMessage` the way a real browser routes a popup's
 * message: to the background, whose handler runs the OWNER initialisation.
 * With `bootsWorker`, the first message is what starts the updated worker,
 * and its boot arms the install signal — so the popup's own run before that
 * has NO signal, exactly as in a real popup context.
 */
function routePopupMessagesToBackground({ bootsWorker = false } = {}): ReturnType<typeof vi.fn> {
  let booted = !bootsWorker;
  const send = vi.fn(async (msg: unknown) => {
    if ((msg as { type?: unknown })?.type !== ENSURE_VAULT_MESSAGE) return undefined;
    if (!booted) {
      booted = true;
      armInstallSignal(10_000);
    }
    await ensureVaultAsOwner();
    return { ok: true };
  });
  (globalThis as unknown as { chrome: { runtime?: unknown } }).chrome.runtime = {
    sendMessage: send,
  };
  return send;
}

describe('the popup never initialises the vault (#1001)', () => {
  let local: LocalArea;
  beforeEach(() => {
    freshVault();
    local = installChromeLocal();
    __forgetVaultRunsForTests();
  });
  afterEach(() => {
    __resetInstallSignalForTests();
    __setVaultRoleForTests('owner');
    vi.restoreAllMocks();
  });

  it('a popup opened after an update but BEFORE onInstalled keeps the legacy identity and every pairing', async () => {
    const legacy = await legacyIdentity();
    local.data['extensionIdentity'] = legacy.stored;
    local.data['trustedMcps'] = TRUST;
    local.data['remoteBridges'] = [BRIDGE];
    // The extension was just updated and Chrome has not dispatched
    // onInstalled yet. The popup opens now: its context has no install
    // signal (only the worker arms one), and its message is what wakes the
    // updated worker.
    routePopupMessagesToBackground({ bootsWorker: true });
    __setVaultRoleForTests('reader');
    const popup = loadOrCreateExtensionIdentity();

    await new Promise((r) => setTimeout(r, 30));
    // Nothing minted, nothing purged while the background is still deciding.
    expect(await vaultGet('identity')).toBeUndefined();
    expect(local.data['extensionIdentity']).toEqual(legacy.stored);
    expect(local.data['trustedMcps']).toEqual(TRUST);

    await noteInstalled({ reason: 'update', previousVersion: '1.4.0' });
    const id = await popup;
    expect(toB64(id.ed25519Pub)).toBe(legacy.edPub);
    expect(Object.keys(await new TrustStore('1.4.1').list())).toEqual(['abc']);
    expect(await loadRemoteTargets()).toEqual([BRIDGE]);
  });

  it('a popup on an empty vault with no background to answer fails — it does not mint or purge', async () => {
    const legacy = await legacyIdentity();
    local.data['extensionIdentity'] = legacy.stored;
    (globalThis as unknown as { chrome: { runtime?: unknown } }).chrome.runtime = {
      sendMessage: vi.fn(async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }),
    };
    __setVaultRoleForTests('reader');
    await expect(ensureVault()).rejects.toThrow(/background/);
    expect(await vaultGet('identity')).toBeUndefined();
    expect(local.data['extensionIdentity']).toEqual(legacy.stored);
  });

  it('a popup whose background answers without initialising fails rather than minting', async () => {
    (globalThis as unknown as { chrome: { runtime?: unknown } }).chrome.runtime = {
      sendMessage: vi.fn(async () => ({ ok: true })),
    };
    __setVaultRoleForTests('reader');
    await expect(ensureVault()).rejects.toThrow(/background/);
    expect(await vaultGet('identity')).toBeUndefined();
  });

  it('a failed popup run is not memoised: the next call retries and succeeds', async () => {
    const send = vi.fn(async () => {
      throw new Error('no receiver');
    });
    (globalThis as unknown as { chrome: { runtime?: unknown } }).chrome.runtime = {
      sendMessage: send,
    };
    __setVaultRoleForTests('reader');
    await expect(ensureVault()).rejects.toThrow();
    routePopupMessagesToBackground();
    await expect(ensureVault()).resolves.toBeUndefined();
    expect(await vaultGet('identity')).toBeDefined();
  });

  it('a popup on an initialised vault reads it without asking the background and writes nothing', async () => {
    const first = await loadOrCreateExtensionIdentity(); // owner (the worker)
    __forgetVaultRunsForTests();
    local.data['extensionIdentity'] = (await legacyIdentity()).stored; // leftover/planted
    const send = routePopupMessagesToBackground();
    __setVaultRoleForTests('reader');
    const id = await loadOrCreateExtensionIdentity();
    expect(toB64(id.ed25519Pub)).toBe(toB64(first.ed25519Pub));
    expect(send).not.toHaveBeenCalled();
    // Housekeeping (the purge) is the background's job, not the popup's.
    expect('extensionIdentity' in local.data).toBe(true);
  });
});

describe('vault initialisation is idempotent under concurrent callers', () => {
  let local: LocalArea;
  beforeEach(() => {
    freshVault();
    local = installChromeLocal();
    __forgetVaultRunsForTests();
  });
  afterEach(() => {
    __resetInstallSignalForTests();
    __setVaultRoleForTests('owner');
    vi.restoreAllMocks();
  });

  it('many popup readers racing the worker all see the ONE migrated identity', async () => {
    const legacy = await legacyIdentity();
    local.data['extensionIdentity'] = legacy.stored;
    local.data['trustedMcps'] = TRUST;
    armInstallSignal(10_000);
    routePopupMessagesToBackground();
    __setVaultRoleForTests('reader');
    const readers = Array.from({ length: 5 }, () => loadOrCreateExtensionIdentity());
    __setVaultRoleForTests('owner');
    const worker = loadOrCreateExtensionIdentity();
    await noteInstalled({ reason: 'update', previousVersion: '1.4.0' });
    const ids = await Promise.all([worker, ...readers]);
    for (const id of ids) expect(toB64(id.ed25519Pub)).toBe(legacy.edPub);
    expect(Object.keys(await new TrustStore('1.4.1').list())).toEqual(['abc']);
  });

  it('two owner runs (e.g. a worker restarted mid-import) converge on one identity', async () => {
    const legacy = await legacyIdentity();
    local.data['extensionIdentity'] = legacy.stored;
    await noteInstalled({ reason: 'update', previousVersion: '1.4.0' });
    const a = ensureVaultAsOwner();
    __forgetVaultRunsForTests(); // a second, independent context
    const b = ensureVaultAsOwner();
    await Promise.all([a, b]);
    const id = await loadOrCreateExtensionIdentity();
    expect(toB64(id.ed25519Pub)).toBe(legacy.edPub);
    // And a third run later changes nothing.
    __forgetVaultRunsForTests();
    await ensureVaultAsOwner();
    expect(toB64((await loadOrCreateExtensionIdentity()).ed25519Pub)).toBe(legacy.edPub);
  });

  it('the legacy identity is NOT purged when the vault write fails', async () => {
    const legacy = await legacyIdentity();
    local.data['extensionIdentity'] = legacy.stored;
    local.data['trustedMcps'] = TRUST;
    await noteInstalled({ reason: 'update', previousVersion: '1.4.0' });
    const proto = IDBObjectStore.prototype as unknown as {
      put: (this: IDBObjectStore, value: unknown, key?: IDBValidKey) => IDBRequest;
    };
    vi.spyOn(proto, 'put').mockImplementation(() => {
      throw new DOMException('disk full', 'QuotaExceededError');
    });
    await expect(ensureVaultAsOwner()).rejects.toThrow();
    expect(local.data['extensionIdentity']).toEqual(legacy.stored);
    expect(local.data['trustedMcps']).toEqual(TRUST);
  });
});
