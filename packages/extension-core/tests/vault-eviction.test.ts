import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateEd25519, generateX25519, toB64 } from '@fetchproxy/protocol';
import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import {
  dismissVaultLoss,
  ensureVaultAsOwner,
  loadVaultLoss,
  noteInstalled,
  VAULT_TRIPWIRE_KEY,
  __forgetVaultRunsForTests,
  __resetInstallSignalForTests,
} from '../src/vault-migration.js';
import { requestPersistentStorage } from '../src/vault.js';
import { freshVault, installChromeLocal, type LocalArea } from './helpers/vault.js';

/**
 * fleet-audit #1002: the vault is quota-managed IndexedDB. If the browser
 * evicts it, a new identity has to be minted (the bridge cannot work without
 * one) — but that is no longer SILENT: a tripwire outside IndexedDB says a
 * vault existed, and the loss is recorded for the popup to show. And the
 * vault asks the browser to keep its storage persistent in the first place.
 */

describe('vault eviction is detected, not silently re-minted', () => {
  let local: LocalArea;
  beforeEach(() => {
    freshVault();
    local = installChromeLocal();
    __forgetVaultRunsForTests();
  });
  afterEach(() => __resetInstallSignalForTests());

  it('initialising the vault leaves a tripwire in storage.local and reports no loss', async () => {
    await loadOrCreateExtensionIdentity();
    expect(typeof local.data[VAULT_TRIPWIRE_KEY]).toBe('number');
    expect(await loadVaultLoss()).toBeNull();
  });

  it('a fresh install (no tripwire) is not reported as a loss', async () => {
    await noteInstalled({ reason: 'install' });
    await loadOrCreateExtensionIdentity();
    expect(await loadVaultLoss()).toBeNull();
  });

  it('an evicted vault mints a new identity AND records the loss', async () => {
    const first = await loadOrCreateExtensionIdentity();
    freshVault(); // the browser evicted the extension's IndexedDB
    __forgetVaultRunsForTests(); // the next wake
    const after = await loadOrCreateExtensionIdentity();
    expect(toB64(after.ed25519Pub)).not.toBe(toB64(first.ed25519Pub));
    const loss = await loadVaultLoss();
    expect(loss).not.toBeNull();
    expect(typeof loss!.detectedAt).toBe('number');
  });

  it('the recorded loss survives later wakes until the user dismisses it', async () => {
    await loadOrCreateExtensionIdentity();
    freshVault();
    __forgetVaultRunsForTests();
    await loadOrCreateExtensionIdentity();
    __forgetVaultRunsForTests();
    await ensureVaultAsOwner();
    expect(await loadVaultLoss()).not.toBeNull();
    await dismissVaultLoss();
    expect(await loadVaultLoss()).toBeNull();
    __forgetVaultRunsForTests();
    await ensureVaultAsOwner();
    expect(await loadVaultLoss()).toBeNull();
  });

  it('an authorised legacy upgrade (pre-vault install, no tripwire) is not a loss', async () => {
    const x = await generateX25519();
    const ed = await generateEd25519();
    local.data['extensionIdentity'] = {
      x25519Priv: toB64(x.privateKey),
      x25519Pub: toB64(x.publicKey),
      ed25519Priv: toB64(ed.privateKey),
      ed25519Pub: toB64(ed.publicKey),
      createdAt: 1,
    };
    await noteInstalled({ reason: 'update', previousVersion: '1.0.0' });
    expect(toB64((await loadOrCreateExtensionIdentity()).ed25519Pub)).toBe(toB64(ed.publicKey));
    expect(await loadVaultLoss()).toBeNull();
  });

  it('the tripwire never authorises an import: a planted identity is still ignored', async () => {
    await loadOrCreateExtensionIdentity();
    const ed = await generateEd25519();
    const x = await generateX25519();
    local.data['extensionIdentity'] = {
      x25519Priv: toB64(x.privateKey),
      x25519Pub: toB64(x.publicKey),
      ed25519Priv: toB64(ed.privateKey),
      ed25519Pub: toB64(ed.publicKey),
      createdAt: 1,
    };
    freshVault();
    __forgetVaultRunsForTests();
    const after = await loadOrCreateExtensionIdentity();
    expect(toB64(after.ed25519Pub)).not.toBe(toB64(ed.publicKey));
  });
});

describe('the vault asks for persistent storage', () => {
  beforeEach(() => {
    freshVault();
    installChromeLocal();
    __forgetVaultRunsForTests();
  });
  afterEach(() => {
    __resetInstallSignalForTests();
    vi.unstubAllGlobals();
  });

  function stubStorage(storage: unknown): void {
    vi.stubGlobal('navigator', { ...(globalThis.navigator ?? {}), storage });
  }

  it('the background requests persistence when it initialises the vault', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persisted: vi.fn(async () => false), persist });
    await ensureVaultAsOwner();
    await vi.waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
  });

  it('requestPersistentStorage: already persistent → true, no second request', async () => {
    const persist = vi.fn(async () => true);
    stubStorage({ persisted: vi.fn(async () => true), persist });
    expect(await requestPersistentStorage()).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('requestPersistentStorage: reports what the browser granted', async () => {
    stubStorage({ persisted: vi.fn(async () => false), persist: vi.fn(async () => false) });
    expect(await requestPersistentStorage()).toBe(false);
  });

  it('requestPersistentStorage: no API (a Chrome service worker) → null, never throws', async () => {
    stubStorage({ persisted: vi.fn(async () => false) });
    expect(await requestPersistentStorage()).toBeNull();
    stubStorage(undefined);
    expect(await requestPersistentStorage()).toBeNull();
    stubStorage({
      persisted: vi.fn(async () => {
        throw new Error('nope');
      }),
      persist: vi.fn(async () => true),
    });
    expect(await requestPersistentStorage()).toBeNull();
  });
});
