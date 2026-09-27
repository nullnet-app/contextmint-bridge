/**
 * The content-script half of handing a confirmation back to this extension
 * (mcp-host plan task C3, spec §4.4 step 2, red-team R4-3).
 *
 * The gateway's confirm page, once the creator's session approved, posts
 * `{type: "mcp-host/bridge-account-confirm/v1", completion}` to its OWN
 * window (never a URL). This script is in that tab, so it hears it, and
 * forwards ONLY the completion to the background.
 *
 * This is not the gate. The content script runs on every site, so any page can
 * make it send this message; the background (`background/account-confirm.ts`)
 * accepts a completion only from the tab id it opened for the confirmation,
 * whose sender origin is the link's gateway origin and whose page is the
 * confirm page. What the relay adds is noise control: own window, own origin,
 * the exact type, a value shaped like one the gateway mints — and it never
 * forwards anything the page put beside the completion (a tab id, an origin),
 * since only the browser's own `sender` may speak to those.
 */

import { BRIDGE_CONFIRM_MESSAGE_TYPE, isConfirmSecret } from './account-confirm.js';

/** The runtime message the relay sends the background. */
export const ACCOUNT_CONFIRM_COMPLETION = 'account-confirm-completion';

export interface AccountConfirmCompletionMessage {
  type: typeof ACCOUNT_CONFIRM_COMPLETION;
  completion: string;
}

/** The window surface the relay touches; a stand-in in tests. */
export interface RelayWindow {
  addEventListener: (type: 'message', fn: (e: MessageEvent) => void) => void;
  location: { origin: string };
}

/** Listen on `win` for the confirm page's completion and hand it to `send`. */
export function installAccountConfirmRelay(
  win: RelayWindow,
  send: (message: AccountConfirmCompletionMessage) => unknown,
): void {
  win.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== (win as unknown)) return;
    if (event.origin !== win.location.origin) return;
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) return;
    const { type, completion } = data as { type?: unknown; completion?: unknown };
    if (type !== BRIDGE_CONFIRM_MESSAGE_TYPE || !isConfirmSecret(completion)) return;
    try {
      const pending = send({ type: ACCOUNT_CONFIRM_COMPLETION, completion });
      // A promise-returning sendMessage rejects when no background listens
      // (an extension reload orphaned this script); that is not the page's
      // problem.
      if (pending && typeof (pending as Promise<unknown>).catch === 'function') {
        (pending as Promise<unknown>).catch(() => {});
      }
    } catch {
      // Same, for a sendMessage that throws synchronously.
    }
  });
}
