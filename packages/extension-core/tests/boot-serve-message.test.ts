import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * X2: the popup's "Serve from this browser" reaches the background as
 * `serve-from-this-browser` naming one link. Only an extension page (no
 * `sender.tab`) is heard — a content script on any site can reach onMessage
 * too — and the background passes exactly the named link id on.
 */
type Listener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown;
const listeners: Listener[] = [];

const serveFromLink = vi.fn((_id: string) => true);
vi.mock('../src/background/socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/socket.js')>()),
  serveFromLink: (id: string) => serveFromLink(id),
}));

function area() {
  return {
    get: async () => ({}),
    set: async () => {},
    remove: async () => {},
    onChanged: { addListener: () => {} },
  };
}

beforeAll(async () => {
  const { freshVault } = await import('./helpers/vault.js');
  freshVault();
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: '3.1.0' }),
      onMessage: { addListener: (listener: Listener) => void listeners.push(listener) },
    },
    storage: { local: area(), session: area() },
    tabs: { query: async () => [] },
    action: {},
  });
  const { maybeBoot } = await import('../src/background/boot.js');
  maybeBoot();
  expect(listeners).toHaveLength(1);
});

beforeEach(() => serveFromLink.mockClear());

const { SERVE_FROM_THIS_BROWSER } = await import('../src/bridge-serve-message.js');

describe('serve-from-this-browser', () => {
  it('from the popup, serves from exactly the named link and answers', () => {
    const sendResponse = vi.fn();
    listeners[0]!({ type: SERVE_FROM_THIS_BROWSER, linkId: 'remote:brt_b' }, { id: 'ext' }, sendResponse);
    expect(serveFromLink).toHaveBeenCalledTimes(1);
    expect(serveFromLink).toHaveBeenCalledWith('remote:brt_b');
    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
  });

  it('says so when the background did not send', () => {
    serveFromLink.mockReturnValueOnce(false);
    const sendResponse = vi.fn();
    listeners[0]!({ type: SERVE_FROM_THIS_BROWSER, linkId: 'remote:brt_b' }, { id: 'ext' }, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false });
  });

  it('ignores a content script (a tab sender)', () => {
    const sendResponse = vi.fn();
    listeners[0]!({ type: SERVE_FROM_THIS_BROWSER, linkId: 'remote:brt_b' }, { id: 'ext', tab: { id: 4 } }, sendResponse);
    expect(serveFromLink).not.toHaveBeenCalled();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('sends nothing for a link id that is not a string', () => {
    const sendResponse = vi.fn();
    for (const linkId of [undefined, 7, ['remote:brt_b'], { id: 'remote:brt_b' }]) {
      listeners[0]!({ type: SERVE_FROM_THIS_BROWSER, linkId }, { id: 'ext' }, sendResponse);
    }
    expect(serveFromLink).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ ok: false });
  });
});
