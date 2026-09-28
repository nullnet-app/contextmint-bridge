/**
 * The page-load wake (contextmint-bridge#32): the content-script half, and
 * where that script is registered.
 *
 * Safari runs the background as a non-persistent event page, and a page load
 * alone never woke it: the manifest's `content.js` only listens, and the
 * background registers no `tabs`/`webNavigation` listener. So opening an MCP's
 * site from ContextMint ("Refresh from Safari", nullnet-app/mcp-host-app iOS
 * plan T8) did not run the hand-off the contract runs "at every wake" until
 * the person opened the popup.
 *
 * Now a small isolated-world script sends ONE runtime message when a page
 * finishes loading (`document_idle`, top frame only). A runtime message is a
 * wake event for the event page, and it needs no permission.
 *
 * It is not in the manifest. Waking Safari's event page runs boot, and boot
 * runs the hand-off, so a wake from EVERY site would be a lift on every site.
 * Like the MAIN-world bridge (`main-world-bridge.ts`), it is registered at
 * runtime with `chrome.scripting` (already granted) on the hosts some
 * approved MCP may reach, and nowhere else: an unapproved site carries no
 * wake script and sends nothing. The background still judges every wake by
 * the sender the browser reports (`background/page-load-wake.ts`), since the
 * `<all_urls>` content script shares this runtime.
 */

import { bridgeMatchPatterns } from './lib/host-match-patterns.js';

/** The runtime message the wake script sends. It carries nothing else. */
export const PAGE_LOAD_WAKE = 'page-load-wake';
export const PAGE_LOAD_WAKE_SCRIPT_ID = 'fetchproxy-page-load-wake';
export const PAGE_LOAD_WAKE_FILE = 'page-load-wake.js';

export interface PageLoadWakeMessage {
  type: typeof PAGE_LOAD_WAKE;
}

/**
 * Send the wake once, from the top frame only (the registration is
 * `allFrames: false` already; this holds if it ever is not). A rejected or
 * throwing send — an extension reload orphaned this script — is swallowed:
 * it is not the page's problem. Returns whether a wake was sent.
 */
export function sendPageLoadWake(
  win: { top?: unknown },
  send: (message: PageLoadWakeMessage) => unknown,
): boolean {
  if (win.top !== win) return false;
  try {
    const pending = send({ type: PAGE_LOAD_WAKE });
    if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
      (pending as Promise<unknown>).catch(() => {});
    }
  } catch {
    // No background to hear it.
  }
  return true;
}

interface RegisteredScript {
  id: string;
  js?: string[];
  matches?: string[];
  runAt?: 'document_start' | 'document_end' | 'document_idle';
  allFrames?: boolean;
  persistAcrossSessions?: boolean;
}

interface ScriptingApi {
  getRegisteredContentScripts?: (filter?: { ids?: string[] }) => Promise<RegisteredScript[]>;
  registerContentScripts?: (scripts: RegisteredScript[]) => Promise<void>;
  updateContentScripts?: (scripts: RegisteredScript[]) => Promise<void>;
  unregisterContentScripts?: (filter?: { ids?: string[] }) => Promise<void>;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

let queue: Promise<void> = Promise.resolve();

/**
 * Make the wake script cover exactly `domains` (the same "host or any
 * subdomain" patterns as the MAIN-world bridge). Serialised; best-effort — a
 * failure is logged, never thrown. Nothing is injected into tabs already
 * open: a wake is only useful from a load, and the background is awake at an
 * approval anyway.
 */
export function syncPageLoadWake(domains: Iterable<string>): Promise<void> {
  const list = [...domains];
  const run = queue.then(() => doSync(list));
  queue = run.catch(() => {});
  return run;
}

async function doSync(domains: string[]): Promise<void> {
  const s = ((globalThis as { chrome?: { scripting?: ScriptingApi } }).chrome ?? {}).scripting;
  if (
    typeof s?.getRegisteredContentScripts !== 'function' ||
    typeof s.registerContentScripts !== 'function' ||
    typeof s.updateContentScripts !== 'function' ||
    typeof s.unregisterContentScripts !== 'function'
  ) {
    return;
  }
  try {
    const matches = bridgeMatchPatterns(domains);
    const [existing] = await s.getRegisteredContentScripts({ ids: [PAGE_LOAD_WAKE_SCRIPT_ID] });
    if (matches.length === 0) {
      if (existing) await s.unregisterContentScripts({ ids: [PAGE_LOAD_WAKE_SCRIPT_ID] });
      return;
    }
    if (!existing) {
      // No `world`: ISOLATED is the default (Safari takes no manifest `world`
      // key either), and only the isolated world can reach `runtime`.
      await s.registerContentScripts([
        {
          id: PAGE_LOAD_WAKE_SCRIPT_ID,
          js: [PAGE_LOAD_WAKE_FILE],
          matches,
          runAt: 'document_idle',
          allFrames: false,
          persistAcrossSessions: true,
        },
      ]);
    } else if (!sameSet(existing.matches ?? [], matches)) {
      await s.updateContentScripts([{ id: PAGE_LOAD_WAKE_SCRIPT_ID, matches }]);
    }
  } catch (e) {
    console.error('[fetchproxy] could not update the page-load wake registration:', e);
  }
}
