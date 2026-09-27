// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  ACCOUNT_CONFIRM_COMPLETION,
  installAccountConfirmRelay,
} from '../src/account-confirm-relay.js';
import { BRIDGE_CONFIRM_MESSAGE_TYPE } from '../src/account-confirm.js';

/**
 * The content-script half of the confirmation hand-back (mcp-host plan task
 * C3, red-team R4-3). The gateway's confirm page posts
 * `{type: "mcp-host/bridge-account-confirm/v1", completion}` to its OWN window;
 * this relay forwards just the completion to the background.
 *
 * It runs on every site (the content script does), so it is not the gate:
 * the background accepts a completion only from the tab it opened, on the
 * link's gateway origin, on the confirm page. The relay only keeps the noise
 * down — own window, own origin, exact type, a well-formed value — and never
 * forwards anything the page put beside the completion.
 */

const SECRET = 'AbCdEfGhIjKlMnOpQrStUv';

let sent: unknown[];

function post(data: unknown, init: { origin?: string; source?: unknown } = {}): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data,
      origin: init.origin ?? window.location.origin,
      source: (init.source === undefined ? window : init.source) as MessageEventSource | null,
    }),
  );
}

beforeEach(() => {
  sent = [];
});

// One relay for the whole file, as content.ts installs one per page.
installAccountConfirmRelay(window, (m) => {
  sent.push(m);
});

describe('installAccountConfirmRelay', () => {
  it('forwards a completion the page posted to its own window, and nothing else from it', () => {
    post({ type: BRIDGE_CONFIRM_MESSAGE_TYPE, completion: SECRET, tabId: 99, origin: 'https://x' });
    expect(sent).toEqual([{ type: ACCOUNT_CONFIRM_COMPLETION, completion: SECRET }]);
  });

  it('ignores a message from another window (a frame, an opener)', () => {
    post({ type: BRIDGE_CONFIRM_MESSAGE_TYPE, completion: SECRET }, { source: null });
    post({ type: BRIDGE_CONFIRM_MESSAGE_TYPE, completion: SECRET }, { source: {} });
    expect(sent).toEqual([]);
  });

  it('ignores a message whose origin is not the page’s own', () => {
    post(
      { type: BRIDGE_CONFIRM_MESSAGE_TYPE, completion: SECRET },
      { origin: 'https://evil.test' },
    );
    expect(sent).toEqual([]);
  });

  it('ignores any other type, and a completion that is not one the gateway mints', () => {
    post({ type: 'something-else', completion: SECRET });
    post({ type: BRIDGE_CONFIRM_MESSAGE_TYPE, completion: 'short' });
    post({ type: BRIDGE_CONFIRM_MESSAGE_TYPE, completion: 42 });
    post({ type: BRIDGE_CONFIRM_MESSAGE_TYPE });
    post(`${BRIDGE_CONFIRM_MESSAGE_TYPE}:${SECRET}`);
    post(null);
    expect(sent).toEqual([]);
  });

  it('never throws into the page when the background is gone', () => {
    const throwing = vi.fn(() => {
      throw new Error('Extension context invalidated.');
    });
    const other = new EventTarget() as unknown as Window;
    Object.defineProperty(other, 'location', { value: { origin: 'https://gw.test' } });
    installAccountConfirmRelay(other, throwing);
    expect(() =>
      other.dispatchEvent(
        new MessageEvent('message', {
          data: { type: BRIDGE_CONFIRM_MESSAGE_TYPE, completion: SECRET },
          origin: 'https://gw.test',
          source: other as unknown as MessageEventSource,
        }),
      ),
    ).not.toThrow();
    expect(throwing).toHaveBeenCalledTimes(1);
  });
});
