import { describe, it, expect, beforeEach } from 'vitest';

import {
  BIND_UNSUPPORTED_RETRY_MS,
  MAX_BIND_RECORDS,
  credentialKey,
  isOriginUnsupported,
  loadBindState,
  recordBindState,
  recordOriginUnsupported,
} from '../src/bridge-bind-store.js';
import { vaultGet, vaultUpdate } from '../src/vault.js';
import { freshVault, installChromeLocal, mockLocalArea } from './helpers/vault.js';

/**
 * What the extension remembers about binding its bridge credentials (plan
 * task C2): which credentials are settled — bound to this extension, bound to
 * another, or refused — and which gateways predate binding. In the vault only:
 * a content script that could write "bound" could stop this browser binding a
 * credential, and one that could write "unsupported" could do the same for a
 * whole gateway (fleet-audit #252's reasoning).
 */

let local: ReturnType<typeof mockLocalArea>;

beforeEach(() => {
  freshVault();
  local = installChromeLocal();
});

describe('credentialKey', () => {
  it('is a hash — the credential itself is never a key in the vault', async () => {
    const key = await credentialKey('mcpb_secret');
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain('secret');
    expect(await credentialKey('mcpb_secret')).toBe(key);
    expect(await credentialKey('mcpb_other')).not.toBe(key);
  });
});

describe('bind state', () => {
  it('round-trips per credential and is absent until recorded', async () => {
    const a = await credentialKey('mcpb_a');
    const b = await credentialKey('mcpb_b');
    expect(await loadBindState(a)).toBeNull();
    await recordBindState(a, 'bound');
    await recordBindState(b, 'conflict');
    expect(await loadBindState(a)).toBe('bound');
    expect(await loadBindState(b)).toBe('conflict');
    await recordBindState(b, 'refused');
    expect(await loadBindState(b)).toBe('refused');
  });

  it('lives in the vault, and a planted storage.local value has no effect', async () => {
    const a = await credentialKey('mcpb_a');
    local.data['bridgeBindings'] = {
      credentials: { [a]: { state: 'bound', at: 1 } },
      unsupported: {},
    };
    expect(await loadBindState(a)).toBeNull();
    await recordBindState(a, 'conflict');
    expect(local.data['bridgeBindings']).toEqual({
      credentials: { [a]: { state: 'bound', at: 1 } },
      unsupported: {},
    });
    expect(await vaultGet('bridgeBindings')).toMatchObject({
      credentials: { [a]: { state: 'conflict' } },
    });
  });

  it('ignores a record this code would not have written', async () => {
    const a = await credentialKey('mcpb_a');
    await vaultUpdate('bridgeBindings', () => ({
      credentials: { [a]: { state: 'admitted', at: 1 }, 'not-a-hash': { state: 'bound', at: 1 } },
      unsupported: { 'https://gw.test': 'soon' },
    }));
    expect(await loadBindState(a)).toBeNull();
    expect(await isOriginUnsupported('https://gw.test', Date.now())).toBe(false);
  });

  it('is bounded: the oldest records go first', async () => {
    const keys: string[] = [];
    for (let i = 0; i < MAX_BIND_RECORDS + 3; i++) {
      const k = await credentialKey(`mcpb_${i}`);
      keys.push(k);
      await recordBindState(k, 'bound', 1000 + i);
    }
    expect(await loadBindState(keys[0]!)).toBeNull();
    expect(await loadBindState(keys[2]!)).toBeNull();
    expect(await loadBindState(keys[3]!)).toBe('bound');
    expect(await loadBindState(keys.at(-1)!)).toBe('bound');
  });
});

describe('unsupported gateways', () => {
  it('are remembered per origin, and asked again only after the retry window', async () => {
    const t0 = 1_000_000;
    expect(await isOriginUnsupported('https://gw.test', t0)).toBe(false);
    await recordOriginUnsupported('https://gw.test', t0);
    expect(await isOriginUnsupported('https://gw.test', t0 + 1)).toBe(true);
    expect(await isOriginUnsupported('https://other.test', t0 + 1)).toBe(false);
    expect(await isOriginUnsupported('https://gw.test', t0 + BIND_UNSUPPORTED_RETRY_MS - 1)).toBe(
      true,
    );
    expect(await isOriginUnsupported('https://gw.test', t0 + BIND_UNSUPPORTED_RETRY_MS)).toBe(
      false,
    );
  });

  it('a planted storage.local "unsupported" does not stop a bind', async () => {
    local.data['bridgeBindings'] = {
      credentials: {},
      unsupported: { 'https://gw.test': Date.now() },
    };
    expect(await isOriginUnsupported('https://gw.test', Date.now())).toBe(false);
  });
});
