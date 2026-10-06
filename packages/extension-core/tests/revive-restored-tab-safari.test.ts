/**
 * The restored-tab revive (`revive-tab.ts`), in the shape Safari really has.
 *
 * Safari's web-extension runtime is WebKit's (`Source/WebKit/UIProcess/
 * Extensions/`), and it differs from Chrome at every step of the revive:
 *
 *   - `tabs.sendMessage` to a tab with no `runtime.onMessage` listener does
 *     NOT reject with "Receiving end does not exist": it RESOLVES `undefined`
 *     (`WebExtensionContext::tabsSendMessage` answers `{ }` when the tab has no
 *     web view or no listening process). Unhandled, that reached the handlers
 *     as an answer and the revive never ran.
 *   - `tabs.Tab` has no `discarded`, and `status` is only `'loading'` or
 *     `'complete'` — a restored tab Safari has not loaded (no web view) reports
 *     `'complete'`, since WebKit falls back to `!webView.isLoading`.
 *   - `scripting.executeScript` on such a tab rejects with
 *     "Invalid call to scripting.executeScript(). Could not execute script on
 *     this tab." — WebKit's error for exactly one state, the tab has no web
 *     view, i.e. no page loaded. That is the signal that a reload is safe.
 *   - Both `tabs.reload` and `scripting.executeScript` exist (MDN BCD: Safari
 *     14 / 15.4).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { sendToFirstResponsiveTab } from '../src/background.js';
import { __resetColdOpenForTests } from '../src/lib/cold-open.js';
import { __resetReviveForTests, __setReviveTimingForTests } from '../src/lib/revive-tab.js';

/** WebKit's rejection for `scripting.executeScript` on a tab with no web view. */
const WEBKIT_NO_WEB_VIEW =
  'Invalid call to scripting.executeScript(). Could not execute script on this tab.';

/** What `@fetchproxy/server` (error-kind.ts) keys `content_script_unreachable` on. */
const SERVER_UNREACHABLE = /Could not establish connection|Receiving end does not exist/i;

interface SafariTab {
  id: number;
  url: string;
  /** Safari has a page loaded in this tab (a web view). */
  loaded: boolean;
  /** The content script is listening in it. */
  listening: boolean;
  /** Safari reports `'loading'` while a load is in flight. */
  loading?: boolean;
}

interface Fake {
  sends: number[];
  reloads: number[];
  injections: number[];
}

function installSafari(
  tabs: SafariTab[],
  opts: {
    noReload?: boolean;
    /** executeScript rejects for another reason (no host access). */
    injectDenied?: boolean;
    /** After a reload Safari keeps reporting 'complete' for this many polls before 'loading'. */
    staleCompletePolls?: number;
  } = {},
): Fake {
  const fake: Fake = { sends: [], reloads: [], injections: [] };
  const report = (t: SafariTab) => ({
    id: t.id,
    url: t.url,
    // No `discarded` key at all: WebKit's tab object never has one.
    status: t.loading ? 'loading' : 'complete',
  });
  const stale = new Map<number, number>();
  const tabsApi: Record<string, unknown> = {
    query: async () => tabs.map(report),
    get: async (id: number) => {
      const t = tabs.find((x) => x.id === id);
      if (!t) throw new Error('Invalid call to tabs.get(). Tab not found.');
      const left = stale.get(id) ?? 0;
      if (left > 0) {
        stale.set(id, left - 1);
        if (left === 1) {
          // The load Safari deferred starts now, and lands a moment later.
          t.loading = true;
          setTimeout(() => {
            t.loading = false;
            t.loaded = true;
            t.listening = true;
          }, 15);
        }
        return { id: t.id, url: t.url, status: 'complete' };
      }
      return report(t);
    },
    sendMessage: async (tabId: number) => {
      fake.sends.push(tabId);
      const t = tabs.find((x) => x.id === tabId)!;
      // WebKit: no web view, or no listening process -> resolves undefined.
      if (!t.loaded || !t.listening) return undefined;
      return { ok: true, from: tabId };
    },
  };
  if (!opts.noReload) {
    tabsApi.reload = async (id: number) => {
      fake.reloads.push(id);
      const t = tabs.find((x) => x.id === id)!;
      if (opts.staleCompletePolls) {
        stale.set(id, opts.staleCompletePolls);
        return;
      }
      t.loading = true;
      setTimeout(() => {
        t.loading = false;
        t.loaded = true;
        // WebKit adds manifest scripts as user scripts: they come with the load.
        t.listening = true;
      }, 20);
    };
  }
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      getManifest: () => ({
        version: '1.7.0',
        // Safari's generated manifest drops `world` (extension-safari/manifest.ts).
        content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'], run_at: 'document_idle' }],
      }),
    },
    tabs: tabsApi,
    scripting: {
      executeScript: async (i: { target: { tabId: number } }) => {
        const t = tabs.find((x) => x.id === i.target.tabId);
        if (!t) throw new Error('Invalid call to scripting.executeScript(). Tab not found.');
        if (opts.injectDenied) {
          throw new Error(
            'Invalid call to scripting.executeScript(). This extension does not have access to this tab.',
          );
        }
        if (!t.loaded) throw new Error(WEBKIT_NO_WEB_VIEW);
        fake.injections.push(t.id);
        t.listening = true;
        return [];
      },
    },
  };
  return fake;
}

const COMPASS = 'https://www.compass.com/';
const matchCompass = (u: string): boolean => u.startsWith(COMPASS);
const send = () => sendToFirstResponsiveTab(matchCompass, () => ({ kind: 'noop' }), COMPASS);

beforeEach(() => {
  __resetColdOpenForTests();
  __resetReviveForTests();
  __setReviveTimingForTests({ budgetMs: 400, pollMs: 5, reloadSettleMs: 60 });
});

afterEach(() => {
  __resetReviveForTests();
  delete (globalThis as { chrome?: unknown }).chrome;
});

describe('reviving a script-less matched tab in Safari', () => {
  it('reloads a restored tab Safari never loaded (no web view), then retries the send', async () => {
    const fake = installSafari([{ id: 3, url: COMPASS, loaded: false, listening: false }]);
    const r = await send();
    expect(r).toEqual({ kind: 'response', response: { ok: true, from: 3 }, tabUrl: COMPASS });
    // Injection was tried first and refused for want of a page; only then reloaded.
    expect(fake.injections).toEqual([]);
    expect(fake.reloads).toEqual([3]);
    expect(fake.sends).toEqual([3, 3]);
  });

  it('injects into a loaded tab with no listener, never reloading it', async () => {
    const fake = installSafari([{ id: 4, url: COMPASS, loaded: true, listening: false }]);
    const r = await send();
    expect(r).toEqual({ kind: 'response', response: { ok: true, from: 4 }, tabUrl: COMPASS });
    expect(fake.injections).toEqual([4]);
    expect(fake.reloads).toEqual([]);
  });

  it("waits out a 'complete' that Safari reports before the reload's load has begun", async () => {
    const fake = installSafari([{ id: 5, url: COMPASS, loaded: false, listening: false }], {
      staleCompletePolls: 3,
    });
    const r = await send();
    expect(r).toEqual({ kind: 'response', response: { ok: true, from: 5 }, tabUrl: COMPASS });
    expect(fake.reloads).toEqual([5]);
  });

  it('does not reload when tabs.reload is missing (scripting present, reload absent)', async () => {
    const fake = installSafari([{ id: 6, url: COMPASS, loaded: false, listening: false }], {
      noReload: true,
    });
    const r = await send();
    expect(r.kind).toBe('no-tab');
    expect(fake.reloads).toEqual([]);
    expect(fake.sends).toEqual([6]);
  });

  it('never reloads when executeScript fails for any other reason', async () => {
    const fake = installSafari([{ id: 7, url: COMPASS, loaded: true, listening: false }], {
      injectDenied: true,
    });
    const r = await send();
    expect(r.kind).toBe('no-tab');
    expect(fake.reloads).toEqual([]);
  });

  it('leaves a tab Safari reports as loading alone', async () => {
    const fake = installSafari([
      { id: 8, url: COMPASS, loaded: false, listening: false, loading: true },
    ]);
    const r = await send();
    expect(r.kind).toBe('no-tab');
    expect(fake.reloads).toEqual([]);
    expect(fake.injections).toEqual([]);
  });

  it('a miss keeps the reload advice and the server’s content_script_unreachable marker', async () => {
    installSafari([{ id: 9, url: COMPASS, loaded: false, listening: false }], { noReload: true });
    const r = await send();
    if (r.kind !== 'no-tab') throw new Error(`expected a miss, got ${r.kind}`);
    expect(r.error).toMatch(/^no tab matching /);
    expect(r.error).toContain('has the fetchproxy content script loaded');
    expect(r.error).toContain('Reload that tab');
    expect(r.error).toMatch(SERVER_UNREACHABLE);
  });

  it('skips a silent tab and answers from the next match without reviving anything', async () => {
    const fake = installSafari([
      { id: 1, url: COMPASS, loaded: false, listening: false },
      { id: 2, url: COMPASS, loaded: true, listening: true },
    ]);
    const r = await send();
    expect(r).toEqual({ kind: 'response', response: { ok: true, from: 2 }, tabUrl: COMPASS });
    expect(fake.reloads).toEqual([]);
    expect(fake.injections).toEqual([]);
  });
});

describe('the Safari signals never move Chrome', () => {
  it('never reloads a tab that reports discarded:false, whatever executeScript says', async () => {
    const reloads: number[] = [];
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        getManifest: () => ({
          version: '1.7.0',
          content_scripts: [{ matches: ['<all_urls>'], js: ['content.js'] }],
        }),
      },
      tabs: {
        query: async () => [{ id: 1, url: COMPASS, status: 'complete', discarded: false }],
        get: async () => ({ id: 1, url: COMPASS, status: 'complete', discarded: false }),
        sendMessage: async () => {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
        reload: async (id: number) => {
          reloads.push(id);
        },
      },
      scripting: {
        executeScript: async () => {
          throw new Error(WEBKIT_NO_WEB_VIEW);
        },
      },
    };
    const r = await send();
    expect(r.kind).toBe('no-tab');
    expect(reloads).toEqual([]);
  });
});
