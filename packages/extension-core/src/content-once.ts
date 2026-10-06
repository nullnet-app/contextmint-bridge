/**
 * Keep `content.js` to one live copy per page.
 *
 * The manifest injects it on every navigation, and the background can now
 * inject it again on demand: after an extension update
 * (`reinject-content-scripts.ts`) and when reviving a matched tab that does
 * not answer (`lib/revive-tab.ts`). A second run beside a first copy that is
 * still alive would register a second `onMessage` listener, and a request
 * would be served twice — for a write, the POST sent twice.
 *
 * So a run proceeds only when no LIVE copy is already installed in this
 * isolated world. "Live" means the copy's extension context still exists: an
 * update orphans the old copy (`chrome.runtime.id` reads `undefined` there),
 * and the fresh injection that replaces it must not be refused by the marker
 * the orphan left behind. Where no extension id is visible at all, the guard
 * never blocks, which keeps the old behaviour for anything it cannot judge.
 */

const MARKER = '__fetchproxyContentScript';

interface Marker {
  alive: () => boolean;
}

function runtimeId(chromeObj: unknown): string | undefined {
  try {
    const id = (chromeObj as { runtime?: { id?: unknown } } | undefined)?.runtime?.id;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when this run should install its listeners; false when a live copy
 * already serves the page. Records this run as the live copy when true.
 */
export function claimContentScriptRun(
  g: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): boolean {
  const existing = g[MARKER] as Partial<Marker> | undefined;
  try {
    if (typeof existing?.alive === 'function' && existing.alive()) return false;
  } catch {
    // A marker that cannot answer is not a live copy.
  }
  const chromeObj = g.chrome;
  const id = runtimeId(chromeObj);
  const marker: Marker = {
    alive: () => id !== undefined && g.chrome === chromeObj && runtimeId(chromeObj) === id,
  };
  g[MARKER] = marker;
  return true;
}
