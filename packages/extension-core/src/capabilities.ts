/**
 * The capability seam: which declared capabilities THIS browser cannot serve.
 *
 * Found by runtime API detection — never by `currentPlatform()` and never by
 * a user agent — so one rule is right for Chrome, Safari and a future
 * Firefox alike. Safari 27 has no `chrome.downloads`, for example; an MCP
 * that declares `download` there is refused at its hello, naming the
 * capability (`background/hello.ts`), instead of being paired and then
 * failing mid-request with `undefined is not a function`.
 *
 * Every probe READS a property and compares its `typeof`; none calls or
 * detaches a method. #7 is why: Safari's `tabs.query` returned `undefined`
 * when called detached, and a probe that did `const f = api.x.y; f()` would
 * report a present API as absent (or worse, the reverse).
 *
 * A new capability whose API can be absent in some browser MUST be added
 * below; a capability not listed is treated as always available.
 */

import type { Capability } from '@fetchproxy/protocol';

/**
 * The namespaces probed, all optional. Structural and loose on purpose: the
 * real `chrome` (typed as `ChromeApi`, which does not name `scripting`) and
 * a test stub are both assignable, and only presence is ever asked.
 */
export interface CapabilityProbeApi {
  downloads?: { download?: unknown; onChanged?: unknown };
  webRequest?: {
    onBeforeSendHeaders?: { addListener?: unknown };
    onBeforeRedirect?: { addListener?: unknown };
  };
  scripting?: {
    getRegisteredContentScripts?: unknown;
    registerContentScripts?: unknown;
    updateContentScripts?: unknown;
    unregisterContentScripts?: unknown;
    executeScript?: unknown;
  };
  cookies?: { set?: unknown };
}

const isFn = (v: unknown): boolean => typeof v === 'function';

/**
 * APIs do not appear or vanish during a background's life, so the answer is
 * computed once per wake. Keyed by the API object rather than held in a
 * single slot, so a test that hands in a different stub gets its own answer.
 */
const cache = new WeakMap<object, ReadonlySet<Capability>>();

export function unavailableCapabilities(api: CapabilityProbeApi): ReadonlySet<Capability> {
  const hit = cache.get(api);
  if (hit) return hit;
  const out = new Set<Capability>();

  // `download` waits on `onChanged` for the terminal state
  // (`background/handlers/download.ts`), so both halves are needed.
  if (!isFn(api.downloads?.download) || !api.downloads?.onChanged) out.add('download');

  // Present-but-unproven counts as present: the macOS spike neither proved
  // nor disproved Safari's webRequest header capture. Only absence refuses.
  if (!isFn(api.webRequest?.onBeforeSendHeaders?.addListener)) out.add('capture_request_header');
  if (!isFn(api.webRequest?.onBeforeRedirect?.addListener)) out.add('capture_redirect');

  // Both reach the page through the MAIN-world bridge (`capture-logger.js`),
  // which `main-world-bridge.ts` places with these five: the four
  // registration calls for future tabs (it no-ops unless all four are
  // functions) and `executeScript` for tabs already open. Same guard, so the
  // two can never disagree about whether the bridge can exist.
  const s = api.scripting;
  if (
    !isFn(s?.getRegisteredContentScripts) ||
    !isFn(s?.registerContentScripts) ||
    !isFn(s?.updateContentScripts) ||
    !isFn(s?.unregisterContentScripts) ||
    !isFn(s?.executeScript)
  ) {
    out.add('fetch_in_page');
    out.add('graphql');
  }

  if (!isFn(api.cookies?.set)) out.add('write_cookies');

  // Deliberately absent: `fetch`, `read_cookies` (it has a `document.cookie`
  // path without `chrome.cookies`), and the storage / IndexedDB / DOM reads —
  // all served by the content script, which every browser build has.
  cache.set(api, out);
  return out;
}
