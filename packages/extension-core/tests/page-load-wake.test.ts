import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PAGE_LOAD_WAKE,
  PAGE_LOAD_WAKE_FILE,
  PAGE_LOAD_WAKE_SCRIPT_ID,
  sendPageLoadWake,
  syncPageLoadWake,
} from '../src/page-load-wake.js';
import {
  WAKE_RETRY_MS,
  createWakeLift,
  isApprovedPageLoadWake,
} from '../src/background/page-load-wake.js';

// contextmint-bridge#32: a page load on a site the person already approved
// wakes the background (Safari's event page sleeps otherwise), so opening the
// site brings the bridge's links back up. Unapproved sites carry no wake
// script at all, and the background re-checks the sender anyway.

describe('sendPageLoadWake (the content side)', () => {
  it('sends exactly one wake from the top frame', () => {
    const win: { top?: unknown } = {};
    win.top = win;
    const send = vi.fn();
    expect(sendPageLoadWake(win, send)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: PAGE_LOAD_WAKE });
  });

  it('sends nothing from a subframe', () => {
    const send = vi.fn();
    expect(sendPageLoadWake({ top: {} }, send)).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('swallows a rejected or throwing send (no background to hear it)', async () => {
    const win: { top?: unknown } = {};
    win.top = win;
    expect(sendPageLoadWake(win, () => Promise.reject(new Error('no receiver')))).toBe(true);
    expect(
      sendPageLoadWake(win, () => {
        throw new Error('context invalidated');
      }),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
  });
});

interface Registered {
  id: string;
  js?: string[];
  matches?: string[];
  runAt?: string;
  world?: string;
  allFrames?: boolean;
  persistAcrossSessions?: boolean;
}

function installFakeScripting(initial: Registered[] = []) {
  let registered = initial.map((r) => ({ ...r }));
  const calls: string[] = [];
  (globalThis as { chrome?: unknown }).chrome = {
    scripting: {
      getRegisteredContentScripts: async (f?: { ids?: string[] }) =>
        registered.filter((r) => !f?.ids || f.ids.includes(r.id)).map((r) => ({ ...r })),
      registerContentScripts: async (xs: Registered[]) => {
        calls.push('register');
        for (const x of xs) {
          if (registered.some((r) => r.id === x.id))
            throw new Error(`Duplicate script ID '${x.id}'`);
          registered.push({ ...x });
        }
      },
      updateContentScripts: async (xs: Registered[]) => {
        calls.push('update');
        for (const x of xs)
          Object.assign(
            registered.find((r) => r.id === x.id)!,
            x,
          );
      },
      unregisterContentScripts: async (f?: { ids?: string[] }) => {
        calls.push('unregister');
        registered = registered.filter((r) => f?.ids && !f.ids.includes(r.id));
      },
    },
  };
  return { registered: () => registered, calls };
}

describe('syncPageLoadWake (where the wake script runs)', () => {
  const saved = (globalThis as { chrome?: unknown }).chrome;
  beforeEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });
  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = saved;
  });

  it('registers an isolated-world, top-frame, document_idle script on approved hosts only', async () => {
    const fake = installFakeScripting();
    await syncPageLoadWake(['honeybook.com']);
    expect(fake.registered()).toEqual([
      {
        id: PAGE_LOAD_WAKE_SCRIPT_ID,
        js: [PAGE_LOAD_WAKE_FILE],
        matches: ['*://*.honeybook.com/*'],
        runAt: 'document_idle',
        allFrames: false,
        persistAcrossSessions: true,
      },
    ]);
    // No `world` key: ISOLATED is the default, and it can call runtime APIs.
    expect(fake.registered()[0]).not.toHaveProperty('world');
    expect(PAGE_LOAD_WAKE_FILE).toBe('page-load-wake.js');
  });

  it('registers nothing while no MCP is approved', async () => {
    const fake = installFakeScripting();
    await syncPageLoadWake([]);
    expect(fake.registered()).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('follows approvals and revokes in place', async () => {
    const fake = installFakeScripting([
      {
        id: PAGE_LOAD_WAKE_SCRIPT_ID,
        js: [PAGE_LOAD_WAKE_FILE],
        matches: ['*://*.a.com/*'],
        runAt: 'document_idle',
      },
    ]);
    await syncPageLoadWake(['a.com']);
    expect(fake.calls).toEqual([]);
    await syncPageLoadWake(['b.com']);
    expect(fake.registered()[0]!.matches).toEqual(['*://*.b.com/*']);
    await syncPageLoadWake([]);
    expect(fake.registered()).toEqual([]);
    expect(fake.calls).toEqual(['update', 'unregister']);
  });

  it('no-ops without the dynamic scripting API rather than throwing', async () => {
    (globalThis as { chrome?: unknown }).chrome = { scripting: {} };
    await expect(syncPageLoadWake(['a.com'])).resolves.toBeUndefined();
  });
});

describe('isApprovedPageLoadWake (the background gate)', () => {
  const approved = ['honeybook.com'];
  const wake = { type: PAGE_LOAD_WAKE };
  const top = (url: string) => ({ tab: { id: 7, url }, frameId: 0, url });

  it('accepts a top-frame wake from a tab on an approved host or its subdomain', () => {
    expect(isApprovedPageLoadWake(wake, top('https://honeybook.com/'), approved)).toBe(true);
    expect(isApprovedPageLoadWake(wake, top('https://www.honeybook.com/app/x'), approved)).toBe(
      true,
    );
  });

  it('ignores a wake from a site nobody approved', () => {
    expect(isApprovedPageLoadWake(wake, top('https://evil.test/'), approved)).toBe(false);
    expect(isApprovedPageLoadWake(wake, top('https://honeybook.com.evil.test/'), approved)).toBe(
      false,
    );
    expect(isApprovedPageLoadWake(wake, top('https://honeybook.com/'), [])).toBe(false);
  });

  it('judges the sender the browser reports, never the message', () => {
    const forged = { type: PAGE_LOAD_WAKE, url: 'https://honeybook.com/' };
    expect(isApprovedPageLoadWake(forged, top('https://evil.test/'), approved)).toBe(false);
  });

  it("judges the frame's own URL, not the tab's, when the browser reports both", () => {
    // The tab is on an approved host, but the frame that sent this is not.
    expect(
      isApprovedPageLoadWake(
        wake,
        { tab: { id: 7, url: 'https://honeybook.com/' }, frameId: 0, url: 'https://evil.test/' },
        approved,
      ),
    ).toBe(false);
    // And the reverse: the frame is on an approved host, the tab's URL is not.
    expect(
      isApprovedPageLoadWake(
        wake,
        { tab: { id: 7, url: 'https://evil.test/' }, frameId: 0, url: 'https://honeybook.com/' },
        approved,
      ),
    ).toBe(true);
  });

  it('ignores anything but a top-frame tab sender with a URL', () => {
    expect(isApprovedPageLoadWake(wake, { url: 'https://honeybook.com/' }, approved)).toBe(false); // no tab: an extension page
    expect(
      isApprovedPageLoadWake(
        wake,
        { tab: { id: 7 }, frameId: 3, url: 'https://honeybook.com/' },
        approved,
      ),
    ).toBe(false);
    expect(isApprovedPageLoadWake(wake, { tab: { id: 7 }, frameId: 0 }, approved)).toBe(false);
    expect(isApprovedPageLoadWake(wake, top('file:///honeybook.com/'), approved)).toBe(false);
  });

  it('ignores any other message', () => {
    expect(isApprovedPageLoadWake({ type: 'other' }, top('https://honeybook.com/'), approved)).toBe(
      false,
    );
    expect(isApprovedPageLoadWake(null, top('https://honeybook.com/'), approved)).toBe(false);
  });
});

describe('createWakeLift (idempotence)', () => {
  function harness(opts: { live?: boolean } = {}) {
    let now = 1_000_000;
    let live = opts.live ?? false;
    const releases: (() => void)[] = [];
    const lift = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const w = createWakeLift({ lift, linkLive: () => live, now: () => now });
    return {
      w,
      lift,
      release: () => releases.shift()?.(),
      advance: (ms: number) => void (now += ms),
      setLive: (v: boolean) => void (live = v),
    };
  }

  it('joins a lift already in flight instead of starting a second', async () => {
    const h = harness();
    const a = h.w.run();
    const b = h.w.run();
    expect(h.lift).toHaveBeenCalledTimes(1);
    h.release();
    await Promise.all([a, b]);
    expect(h.lift).toHaveBeenCalledTimes(1);
  });

  it('never repeats a lift that ran while its link is up', async () => {
    const h = harness();
    const a = h.w.run();
    h.release();
    await a;
    h.setLive(true);
    h.advance(WAKE_RETRY_MS * 10);
    await h.w.run();
    await h.w.run();
    expect(h.lift).toHaveBeenCalledTimes(1);
  });

  it('does not re-run within the retry window even if the link is not up yet', async () => {
    const h = harness();
    const a = h.w.run();
    h.release();
    await a;
    h.advance(WAKE_RETRY_MS - 1);
    await h.w.run();
    expect(h.lift).toHaveBeenCalledTimes(1);
  });

  it('runs again once the link is down and the retry window has passed', async () => {
    const h = harness();
    const a = h.w.run();
    h.release();
    await a;
    h.advance(WAKE_RETRY_MS);
    const b = h.w.run();
    expect(h.lift).toHaveBeenCalledTimes(2);
    h.release();
    await b;
  });

  it('a failed lift settles, and is not re-run inside the window', async () => {
    let now = 0;
    const lift = vi.fn(async () => {
      throw new Error('boom');
    });
    const w = createWakeLift({ lift, linkLive: () => false, now: () => now });
    await expect(w.run()).resolves.toBeUndefined();
    await w.run();
    expect(lift).toHaveBeenCalledTimes(1);
    now += WAKE_RETRY_MS;
    await w.run();
    expect(lift).toHaveBeenCalledTimes(2);
  });
});

describe('syncMainWorldBridgeFromTrust keeps the wake beside the MAIN-world bridge', () => {
  const saved = (globalThis as { chrome?: unknown }).chrome;
  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = saved;
  });

  it('registers both on the approved hosts, and removes both on the last revoke', async () => {
    const { syncMainWorldBridgeFromTrust, MAIN_BRIDGE_SCRIPT_ID } =
      await import('../src/main-world-bridge.js');
    const fake = installFakeScripting();
    let domains = ['honeybook.com'];
    const trust = { approvedDomains: async () => domains };
    await syncMainWorldBridgeFromTrust(trust);
    expect(
      fake
        .registered()
        .map((r) => [r.id, r.matches])
        .sort(),
    ).toEqual(
      [
        [MAIN_BRIDGE_SCRIPT_ID, ['*://*.honeybook.com/*']],
        [PAGE_LOAD_WAKE_SCRIPT_ID, ['*://*.honeybook.com/*']],
      ].sort(),
    );
    domains = [];
    await syncMainWorldBridgeFromTrust(trust);
    expect(fake.registered()).toEqual([]);
  });
});
