/**
 * The background half of the page-load wake (contextmint-bridge#32; the
 * content half and where it runs: `../page-load-wake.ts`).
 *
 * The wake script is registered only on approved hosts, but the `<all_urls>`
 * content script shares this runtime, so a wake is judged here by the sender
 * the browser reports — a tab, its top frame, an http(s) URL on a host some
 * approved MCP may reach — and never by anything in the message.
 *
 * What it runs is the lift boot runs at every wake: dial every link.
 * {@link createWakeLift} makes that idempotent across page loads: a lift in
 * flight is joined, and one that ran is not repeated while its link is up,
 * nor within {@link WAKE_RETRY_MS} of finishing (a redirect chain or a few
 * quick loads is one lift, not several). Most of what a wake buys on Safari is
 * the wake itself: the event page restarting runs boot.
 */

import { isUrlAllowedForAnyDomain } from '../lib/url-match.js';
import { PAGE_LOAD_WAKE } from '../page-load-wake.js';

/** How soon after a lift finished a page load may run another (link not up). */
export const WAKE_RETRY_MS = 30_000;

interface WakeSender {
  tab?: { id?: number; url?: string };
  frameId?: number;
  url?: string;
}

/**
 * Whether `msg` is a page-load wake from the top frame of a tab on an
 * approved host. `sender.url` (the frame's own URL) wins over the tab's; a
 * sender the browser reports no URL for is refused.
 */
export function isApprovedPageLoadWake(
  msg: unknown,
  sender: unknown,
  approvedDomains: readonly string[],
): boolean {
  if (
    msg === null ||
    typeof msg !== 'object' ||
    (msg as { type?: unknown }).type !== PAGE_LOAD_WAKE
  ) {
    return false;
  }
  const s = (sender ?? {}) as WakeSender;
  if (s.tab === undefined || s.tab === null) return false;
  if (s.frameId !== undefined && s.frameId !== 0) return false;
  const url = typeof s.url === 'string' ? s.url : s.tab.url;
  if (typeof url !== 'string' || url === '') return false;
  return isUrlAllowedForAnyDomain(url, approvedDomains);
}

export interface WakeLiftDeps {
  /** The lift: dial every link. */
  lift: () => Promise<void>;
  /** Whether the link the lift yields is open or dialling right now. */
  linkLive: () => boolean;
  now?: () => number;
}

export interface WakeLift {
  /** Run the lift unless one is in flight (joined) or already served. Never rejects. */
  run(): Promise<void>;
}

export function createWakeLift(deps: WakeLiftDeps): WakeLift {
  const now = deps.now ?? (() => Date.now());
  let inflight: Promise<void> | null = null;
  let finishedAt: number | null = null;
  return {
    run(): Promise<void> {
      if (inflight) return inflight;
      if (finishedAt !== null && (deps.linkLive() || now() - finishedAt < WAKE_RETRY_MS)) {
        return Promise.resolve();
      }
      inflight = (async () => {
        try {
          await deps.lift();
        } catch (e) {
          console.error('[fetchproxy] page-load wake:', e);
        } finally {
          finishedAt = now();
          inflight = null;
        }
      })();
      return inflight;
    },
  };
}
