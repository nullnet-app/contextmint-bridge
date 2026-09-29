import { describe, it, expect, vi, beforeAll } from 'vitest';

/** Retired C3a message names must have no service-worker route. */
type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;
const listeners: Listener[] = [];

function area() {
  const values = new Map<string, unknown>();
  return {
    get: async () => ({}),
    set: async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
    remove: async () => {},
    onChanged: { addListener: () => {} },
  };
}

beforeAll(async () => {
  const { freshVault } = await import('./helpers/vault.js');
  freshVault();
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: '3.1.0' }),
      onMessage: { addListener: (listener: Listener) => void listeners.push(listener) },
    },
    storage: { local: area(), session: area() },
    tabs: { query: async () => [] },
    action: {},
  });
  const { maybeBoot } = await import('../src/background/boot.js');
  maybeBoot();
  expect(listeners).toHaveLength(1);
});

describe('retired account-confirm message routes', () => {
  it('ignores begin and completion messages from extension contexts and tabs', () => {
    const sendResponse = vi.fn();
    for (const sender of [{ id: 'ext' }, { id: 'ext', tab: { id: 41 } }]) {
      for (const type of ['account-confirm-begin', 'account-confirm-completion']) {
        expect(listeners[0]!({ type, linkId: 'remote:b1', completion: 'secret' }, sender, sendResponse)).toBeUndefined();
      }
    }
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
