// @vitest-environment jsdom

import { describe, it, expect, beforeAll, vi } from 'vitest';

/**
 * The shipped content script installs the confirmation relay (mcp-host plan
 * task C3a): a completion the gateway's confirm page posts to its own window
 * reaches the background as `account-confirm-completion`, and nothing else
 * does.
 */

const sendMessage = vi.fn(async () => undefined);

beforeAll(async () => {
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: { onMessage: { addListener: () => {} }, sendMessage },
  };
  await import('../src/content.js');
});

describe('content script', () => {
  it('relays the confirm page’s completion to the background', () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'mcp-host/bridge-account-confirm/v1', completion: 'AbCdEfGhIjKlMnOpQrStUv' },
        origin: window.location.origin,
        source: window,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith({
      type: 'account-confirm-completion',
      completion: 'AbCdEfGhIjKlMnOpQrStUv',
    });
  });
});
