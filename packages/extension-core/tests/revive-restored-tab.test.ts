/**
 * Reviving a matched tab that has no content script (live repro 2026-10-06).
 *
 * Quit Chrome, reopen it, and the restored www.compass.com tab is there by URL
 * but nothing answers in it: Chrome restores tabs unloaded (discarded) or
 * without ever giving them the manifest content script, so every bridged call
 * failed with `content_script_unreachable` until the person reloaded the tab
 * by hand. `sendToFirstResponsiveTab` now revives such a tab once before
 * giving up: an unloaded tab is reloaded (it has no page state to lose), a
 * live one gets the content script injected (never reloaded — that could lose
 * unsaved input). Only tabs that already matched the request are touched, at
 * most once per request, inside a bounded wait; where the browser lacks the
 * APIs (`tabs.reload` / `scripting`) behaviour is unchanged. Safari has both
 * but differs in every signal; `revive-restored-tab-safari.test.ts` covers it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { sendToFirstResponsiveTab } from '../src/background.js';
import { __resetColdOpenForTests } from '../src/lib/cold-open.js';
import {
  __resetReviveForTests,
  __setReviveTimingForTests,
  setReviveExtraContentScripts,
} from '../src/lib/revive-tab.js';

interface FakeTab {
  id?: number;
  url?: string;
  status?: string;
  discarded?: boolean;
}

interface Fake {
  tabs: FakeTab[];
  responsive: Set<number>;
  sends: number[];
  reloads: number[];
  injections: { tabId: number; files: string[]; world?: string }[];
}

function installFakeChrome(
  tabs: FakeTab[],
  opts: {
    noReload?: boolean;
    noScripting?: boolean;
    noGet?: boolean;
    /** Reloaded tabs never finish loading. */
    reloadHangs?: boolean;
    /** executeScript throws (restricted page). */
    injectFails?: boolean;
    /** executeScript lands but the tab still does not answer. */
    injectIneffective?: boolean;
  } = {},
): Fake {
  const fake: Fake = { tabs, responsive: new Set(), sends: [], reloads: [], injections: [] };
  const tabsApi: Record<string, unknown> = {
    query: async () => tabs.map((t) => ({ ...t })),
    sendMessage: async (tabId: number) => {
      fake.sends.push(tabId);
      if (!fake.responsive.has(tabId)) {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      return { ok: true, from: tabId };
    },
  };
  if (!opts.noGet) {
    tabsApi.get = async (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (!t) throw new Error('No tab with id');
      return { ...t };
    };
  }
  if (!opts.noReload) {
    tabsApi.reload = async (id: number) => {
      fake.reloads.push(id);
      const t = tabs.find((x) => x.id === id)!;
      t.discarded = false;
      t.status = 'loading';
      if (opts.reloadHangs) return;
      setTimeout(() => {
        t.status = 'complete';
        // The manifest content script arrives with the fresh load.
        fake.responsive.add(id);
      }, 20);
    };
  }
  const chrome: Record<string, unknown> = {
    runtime: {
      getManifest: () => ({
        version: '1.7.0',
        content_scripts: [
          {
            matches: ['<all_urls>'],
            js: ['content.js'],
            run_at: 'document_idle',
            world: 'ISOLATED',
          },
        ],
      }),
    },
    tabs: tabsApi,
  };
  if (!opts.noScripting) {
    chrome.scripting = {
      executeScript: async (i: { target: { tabId: number }; files: string[]; world?: string }) => {
        if (opts.injectFails) throw new Error('Cannot access contents of the page');
        fake.injections.push({ tabId: i.target.tabId, files: i.files, world: i.world });
        if (!opts.injectIneffective) fake.responsive.add(i.target.tabId);
        return [];
      },
    };
  }
  (globalThis as { chrome?: unknown }).chrome = chrome;
  return fake;
}

const COMPASS = 'https://www.compass.com/';
const matchCompass = (u: string): boolean => u.startsWith(COMPASS);
const send = () => sendToFirstResponsiveTab(matchCompass, () => ({ kind: 'noop' }), COMPASS);

/** The exact error today's code gives for one unreachable compass tab. */
async function baselineError(): Promise<string> {
  installFakeChrome([{ id: 1, url: COMPASS, status: 'complete' }], {
    noReload: true,
    noScripting: true,
  });
  const r = await send();
  if (r.kind !== 'no-tab') throw new Error('baseline did not miss');
  return r.error;
}

beforeEach(() => {
  __resetColdOpenForTests();
  __resetReviveForTests();
  __setReviveTimingForTests({ budgetMs: 300, pollMs: 5 });
});

afterEach(() => {
  __resetReviveForTests();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('reviving a matched tab with no content script', () => {
  it('reloads a discarded tab, waits for it to load, and retries the send', async () => {
    const fake = installFakeChrome([{ id: 7, url: COMPASS, status: 'unloaded', discarded: true }]);
    const r = await send();
    expect(r).toEqual({ kind: 'response', response: { ok: true, from: 7 }, tabUrl: COMPASS });
    expect(fake.reloads).toEqual([7]);
    expect(fake.injections).toEqual([]);
    expect(fake.sends).toEqual([7, 7]);
  });

  it("reloads a tab whose status is 'unloaded' even when discarded is not set", async () => {
    const fake = installFakeChrome([{ id: 8, url: COMPASS, status: 'unloaded' }]);
    const r = await send();
    expect(r.kind).toBe('response');
    expect(fake.reloads).toEqual([8]);
    expect(fake.injections).toEqual([]);
  });

  it('injects the content script into a live tab instead of reloading it', async () => {
    const fake = installFakeChrome([{ id: 9, url: COMPASS, status: 'complete', discarded: false }]);
    const r = await send();
    expect(r).toEqual({ kind: 'response', response: { ok: true, from: 9 }, tabUrl: COMPASS });
    expect(fake.reloads).toEqual([]);
    expect(fake.injections).toEqual([{ tabId: 9, files: ['content.js'], world: 'ISOLATED' }]);
    expect(fake.sends).toEqual([9, 9]);
  });

  it('never touches a tab that did not match the request', async () => {
    const fake = installFakeChrome([
      { id: 1, url: 'https://www.zillow.com/', status: 'unloaded', discarded: true },
      { id: 2, url: 'https://example.com/', status: 'complete' },
      { id: 3, url: COMPASS, status: 'complete' },
    ]);
    const r = await send();
    expect(r.kind).toBe('response');
    expect(fake.reloads).toEqual([]);
    expect(fake.injections.map((i) => i.tabId)).toEqual([3]);
    expect(fake.sends.every((id) => id === 3)).toBe(true);
  });

  it('does not revive anything when a matching tab already answers', async () => {
    const fake = installFakeChrome([
      { id: 1, url: COMPASS, status: 'unloaded', discarded: true },
      { id: 2, url: COMPASS, status: 'complete' },
    ]);
    fake.responsive.add(2);
    const r = await send();
    expect(r.kind === 'response' && r.response).toEqual({ ok: true, from: 2 });
    expect(fake.reloads).toEqual([]);
    expect(fake.injections).toEqual([]);
  });

  it('returns the original error unchanged when the injection fails', async () => {
    const expected = await baselineError();
    const fake = installFakeChrome([{ id: 1, url: COMPASS, status: 'complete' }], {
      injectFails: true,
    });
    const r = await send();
    expect(r).toEqual({ kind: 'no-tab', error: expected });
    // The reload advice and the #293 routing marker both survive.
    expect(expected).toContain('Reload that tab');
    expect(expected).toContain('has the fetchproxy content script loaded');
    expect(fake.reloads).toEqual([]);
  });

  it('revives at most once per tab per request, then returns the original error', async () => {
    const expected = await baselineError();
    const fake = installFakeChrome([{ id: 1, url: COMPASS, status: 'complete' }], {
      injectIneffective: true,
    });
    const r = await send();
    expect(r).toEqual({ kind: 'no-tab', error: expected });
    expect(fake.injections).toHaveLength(1);
    // The first pass and the single retry, nothing more.
    expect(fake.sends).toEqual([1, 1]);
  });

  it('gives up within the budget when a reloaded tab never finishes loading', async () => {
    const expected = await baselineError();
    const fake = installFakeChrome([{ id: 1, url: COMPASS, status: 'unloaded', discarded: true }], {
      reloadHangs: true,
    });
    const started = Date.now();
    const r = await send();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(r).toEqual({ kind: 'no-tab', error: expected });
    expect(fake.reloads).toEqual([1]);
  });

  it('leaves a tab that is still loading alone — its manifest script is on the way', async () => {
    const fake = installFakeChrome([{ id: 1, url: COMPASS, status: 'loading' }]);
    const r = await send();
    expect(r.kind).toBe('no-tab');
    expect(fake.reloads).toEqual([]);
    expect(fake.injections).toEqual([]);
  });

  it('injects into a live tab but cannot reload a discarded one when tabs.reload is missing', async () => {
    const expected = await baselineError();
    const fake = installFakeChrome(
      [
        { id: 1, url: COMPASS, status: 'unloaded', discarded: true },
        { id: 2, url: COMPASS, status: 'complete', discarded: false },
      ],
      { noReload: true },
    );
    const r = await send();
    expect(r).toEqual({ kind: 'response', response: { ok: true, from: 2 }, tabUrl: COMPASS });
    expect(fake.reloads).toEqual([]);
    expect(fake.injections.map((i) => i.tabId)).toEqual([2]);

    const lone = installFakeChrome([{ id: 1, url: COMPASS, status: 'unloaded', discarded: true }], {
      noReload: true,
    });
    const miss = await send();
    expect(miss).toEqual({ kind: 'no-tab', error: expected });
    expect(lone.injections).toEqual([]);
  });

  it('falls back to today’s behaviour where tabs.reload and scripting are both missing', async () => {
    const expected = await baselineError();
    const fake = installFakeChrome(
      [
        { id: 1, url: COMPASS, status: 'unloaded', discarded: true },
        { id: 2, url: COMPASS, status: 'complete' },
      ],
      { noReload: true, noScripting: true },
    );
    const started = Date.now();
    const r = await send();
    expect(r.kind).toBe('no-tab');
    expect(r.kind === 'no-tab' && r.error).toBe(expected.replace('1 URL match,', '2 URL matches,'));
    expect(fake.sends).toEqual([1, 2]);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it('injects only the runtime scripts whose matches cover the revived tab', async () => {
    const fake = installFakeChrome([{ id: 4, url: COMPASS, status: 'complete' }]);
    setReviveExtraContentScripts(async () => [
      {
        matches: ['*://*.compass.com/*'],
        js: ['capture-logger.js'],
        world: 'MAIN',
        run_at: 'document_start',
      },
      { matches: ['*://*.zillow.com/*'], js: ['other.js'], world: 'MAIN' },
    ]);
    const r = await send();
    expect(r.kind).toBe('response');
    expect(fake.injections).toEqual([
      { tabId: 4, files: ['content.js'], world: 'ISOLATED' },
      { tabId: 4, files: ['capture-logger.js'], world: 'MAIN' },
    ]);
  });
});
