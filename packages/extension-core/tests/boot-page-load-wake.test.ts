import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { freshVault } from './helpers/vault.js';

/**
 * contextmint-bridge#32 through boot: a wake from a page on an approved site
 * runs the ContextMint hand-off (the `bridge-target` ask) again, once; one
 * from any other site runs nothing.
 */

const setHandoffTarget = vi.fn();
vi.mock('../src/background/socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/socket.js')>()),
  connect: vi.fn(),
  loadRemoteLinks: vi.fn(async () => {}),
  setHandoffTarget,
  onHandoffLinkState: vi.fn(),
  handoffLinkOpen: () => false,
  handoffLinkLive: () => false,
}));

function area() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string | string[]) => {
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(k) ? k : [k]) if (m.has(key)) out[key] = m.get(key);
      return out;
    },
    set: async (kv: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(kv)) m.set(k, v);
    },
    remove: async () => {},
    onChanged: { addListener: () => {} },
  };
}

type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;

async function bootSafari() {
  const listeners: Listener[] = [];
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: '1.0.0' }),
      onMessage: { addListener: (fn: Listener) => void listeners.push(fn) },
    },
    storage: { local: area(), session: area() },
    tabs: { query: async () => [] },
    action: {},
    alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  });
  const asks: unknown[] = [];
  const runtime = {
    sendNativeMessage(this: unknown, _app: string, msg: { type: string }) {
      if (msg.type === 'bridge-target') asks.push(msg);
      return Promise.resolve(msg.type === 'bridge-target' ? { error: 'not-set-up' } : { ok: true });
    },
  };
  vi.stubGlobal('browser', { runtime });
  const { TrustStore } = await import('../src/trust-store.js');
  vi.spyOn(TrustStore.prototype, 'approvedDomains').mockResolvedValue(['honeybook.com']);
  const { maybeBoot } = await import('../src/background/boot.js');
  maybeBoot();
  // Boot's own ask (the "at every wake" of the contract).
  await vi.waitUntil(() => asks.length >= 1, { timeout: 2000 });
  await new Promise((r) => setTimeout(r, 20));
  const deliver = (url: string, frameId = 0) => {
    for (const l of listeners)
      l({ type: 'page-load-wake' }, { tab: { id: 3, url }, frameId, url }, () => {});
  };
  return { asks, deliver };
}

const settle = () => new Promise((r) => setTimeout(r, 50));
let clock = 0;

beforeEach(() => {
  vi.resetModules();
  freshVault();
  setHandoffTarget.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('boot and the page-load wake', () => {
  it('a page load on an approved site runs the hand-off again, once', async () => {
    const { asks, deliver } = await bootSafari();
    expect(asks).toHaveLength(1);
    clock += 60_000; // past the retry window after boot's own ask
    deliver('https://www.honeybook.com/app');
    deliver('https://www.honeybook.com/app'); // a second load joins, never repeats
    await settle();
    expect(asks).toHaveLength(2);
  });

  it('a page load on a site nobody approved runs nothing', async () => {
    const { asks, deliver } = await bootSafari();
    clock += 60_000;
    deliver('https://unrelated.test/');
    await settle();
    expect(asks).toHaveLength(1);
  });

  it('a wake right after boot joins the lift boot just ran, never repeats it', async () => {
    const { asks, deliver } = await bootSafari();
    deliver('https://honeybook.com/');
    await settle();
    expect(asks).toHaveLength(1);
  });
});
