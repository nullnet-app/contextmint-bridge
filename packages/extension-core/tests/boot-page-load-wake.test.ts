import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { freshVault } from './helpers/vault.js';

/**
 * contextmint-bridge#32 through boot. What a page load on an approved site
 * buys is the wake itself: Safari's event page restarts and this boot dials
 * every link. The wake's own lift is only `connect()`, so once boot has run
 * it, a page load joins it and dials nothing more; a load from any other site
 * is never even judged past the sender. Nothing native is ever asked.
 */

const connect = vi.fn();
vi.mock('../src/background/socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/socket.js')>()),
  connect,
  loadRemoteLinks: vi.fn(async () => {}),
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

async function bootSafari(opts: { identityFails?: boolean } = {}) {
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
  // Safari offers native messaging; the extension must never use it.
  const sendNativeMessage = vi.fn(async () => ({}));
  vi.stubGlobal('browser', { runtime: { sendNativeMessage } });
  const { TrustStore } = await import('../src/trust-store.js');
  const approvedDomains = vi
    .spyOn(TrustStore.prototype, 'approvedDomains')
    .mockResolvedValue(['honeybook.com']);
  let failIdentity: (e: Error) => void = () => {};
  if (opts.identityFails) {
    vi.doMock('../src/extension-identity.js', () => ({
      loadOrCreateExtensionIdentity: () =>
        new Promise((_, reject) => {
          failIdentity = reject;
        }),
    }));
  }
  const { maybeBoot } = await import('../src/background/boot.js');
  maybeBoot();
  const deliver = (url: string, frameId = 0) => {
    for (const l of listeners)
      l({ type: 'page-load-wake' }, { tab: { id: 3, url }, frameId, url }, () => {});
  };
  if (!opts.identityFails) {
    // Boot's own dial, once the identity is loaded.
    await vi.waitUntil(() => connect.mock.calls.length >= 1, { timeout: 2000 });
    await new Promise((r) => setTimeout(r, 20));
  }
  return { sendNativeMessage, deliver, approvedDomains, failIdentity: (e: Error) => failIdentity(e) };
}

const settle = () => new Promise((r) => setTimeout(r, 50));
let clock = 0;

beforeEach(() => {
  vi.resetModules();
  freshVault();
  connect.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.doUnmock('../src/extension-identity.js');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('boot and the page-load wake', () => {
  it('a page load on an approved site joins the lift boot ran: no second dial, nothing native', async () => {
    const { sendNativeMessage, deliver, approvedDomains } = await bootSafari();
    const dials = connect.mock.calls.length;
    const domainReads = approvedDomains.mock.calls.length;
    clock += 60_000; // past the retry window after boot's own lift
    deliver('https://www.honeybook.com/app');
    deliver('https://www.honeybook.com/app');
    await settle();
    expect(approvedDomains.mock.calls.length).toBeGreaterThan(domainReads); // judged
    expect(connect).toHaveBeenCalledTimes(dials);
    expect(sendNativeMessage).not.toHaveBeenCalled();
  });

  it('a page load on a site nobody approved dials nothing', async () => {
    const { sendNativeMessage, deliver } = await bootSafari();
    const dials = connect.mock.calls.length;
    clock += 60_000;
    deliver('https://unrelated.test/');
    await settle();
    expect(connect).toHaveBeenCalledTimes(dials);
    expect(sendNativeMessage).not.toHaveBeenCalled();
  });

  it('when the identity boot fails, waiting wakes and later ones give up with one log line, and lift nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { sendNativeMessage, deliver, approvedDomains, failIdentity } = await bootSafari({
      identityFails: true,
    });
    await settle(); // boot's own reads (the MAIN-world bridge sync) are done
    const domainReads = approvedDomains.mock.calls.length;
    deliver('https://honeybook.com/'); // waiting on the identity when it fails
    deliver('https://www.honeybook.com/app');
    failIdentity(new Error('vault unavailable'));
    await settle();
    deliver('https://honeybook.com/'); // after the failure
    await settle();
    const wakeLines = errors.mock.calls.filter((c) => String(c[0]).includes('page-load wake'));
    expect(wakeLines).toHaveLength(1);
    expect(sendNativeMessage).not.toHaveBeenCalled();
    expect(approvedDomains).toHaveBeenCalledTimes(domainReads); // no wake got past the identity
    expect(connect).not.toHaveBeenCalled();
  });
});
