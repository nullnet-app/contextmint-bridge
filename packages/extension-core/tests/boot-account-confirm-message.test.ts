import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * The service worker's routing of the two confirmation messages (mcp-host
 * plan task C3a):
 *
 * - `account-confirm-begin` is the PERSON's request, from the popup. It is
 *   honoured only with no `sender.tab`: a content script — which every site
 *   gets — must not be able to start a confirmation (or open tabs) by itself.
 * - `account-confirm-completion` is the content script relaying the confirm
 *   page's completion. It is handed on WITH the browser's own `sender`, which
 *   is what the flow checks (tab id, origin, page); a message from an extension
 *   page, which has no tab, is not a relay and is dropped here.
 *
 * The status answer carries this browser's key fingerprint, for the popup to
 * show beside a confirmation.
 */

const beginAccountConfirm = vi.fn(async () => ({ ok: true, via: 'tab' }));
const onConfirmCompletion = vi.fn(async () => true);
vi.mock('../src/background/account-confirm.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/account-confirm.js')>()),
  beginAccountConfirm,
  onConfirmCompletion,
}));
vi.mock('../src/background/socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/socket.js')>()),
  connect: vi.fn(),
  loadRemoteLinks: vi.fn(async () => {}),
}));

type Sender = { tab?: { id?: number }; id?: string; url?: string; frameId?: number };
type MessageListener = (
  msg: unknown,
  sender: Sender | undefined,
  sendResponse: (r: unknown) => void,
) => unknown;
const messageListeners: MessageListener[] = [];

function area() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string | string[]) => {
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(k) ? k : [k]) if (m.has(key)) out[key] = m.get(key);
      return out;
    },
    set: async (kv: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(kv)) m.set(k, v);
    },
    remove: async (k: string | string[]) => {
      for (const key of Array.isArray(k) ? k : [k]) m.delete(key);
    },
    onChanged: { addListener: () => {} },
  };
}

function dispatch(
  msg: unknown,
  sender: Sender | undefined,
): { returned: unknown; response: Promise<unknown> } {
  let resolve!: (r: unknown) => void;
  const response = new Promise<unknown>((r) => (resolve = r));
  let returned: unknown;
  for (const l of messageListeners) returned = l(msg, sender, resolve) ?? returned;
  return { returned, response };
}

beforeAll(async () => {
  const { freshVault } = await import('./helpers/vault.js');
  freshVault();
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: '3.1.0' }),
      onMessage: { addListener: (cb: MessageListener) => void messageListeners.push(cb) },
    },
    storage: { local: area(), session: area() },
    tabs: { query: async () => [] },
    action: {},
  });
  const { maybeBoot } = await import('../src/background/boot.js');
  maybeBoot();
  // The identity loads asynchronously, and the fingerprint after it.
  const { state } = await import('../src/background/state.js');
  for (let i = 0; i < 200 && state.extFingerprint === null; i++)
    await new Promise((r) => setTimeout(r, 5));
  expect(messageListeners).toHaveLength(1);
});

beforeEach(() => {
  beginAccountConfirm.mockClear();
  onConfirmCompletion.mockClear();
});

describe('account-confirm-begin', () => {
  it('starts for the popup (no sender.tab) and answers the outcome', async () => {
    const { returned, response } = dispatch(
      { type: 'account-confirm-begin', linkId: 'remote:b1' },
      { id: 'ext' },
    );
    expect(returned).toBe(true); // async answer
    expect(await response).toEqual({ ok: true, via: 'tab' });
    expect(beginAccountConfirm).toHaveBeenCalledWith('remote:b1');
  });

  it('is ignored from a content script (sender.tab set)', () => {
    dispatch({ type: 'account-confirm-begin', linkId: 'remote:b1' }, { id: 'ext', tab: { id: 3 } });
    expect(beginAccountConfirm).not.toHaveBeenCalled();
  });

  it('is ignored without a link id', () => {
    dispatch({ type: 'account-confirm-begin' }, { id: 'ext' });
    dispatch({ type: 'account-confirm-begin', linkId: 7 }, { id: 'ext' });
    expect(beginAccountConfirm).not.toHaveBeenCalled();
  });
});

describe('account-confirm-completion', () => {
  it('hands a content script’s relay on with the browser’s own sender', () => {
    const sender = {
      id: 'ext',
      tab: { id: 41 },
      frameId: 0,
      url: 'https://gw.test/bridge/confirm',
    };
    const msg = { type: 'account-confirm-completion', completion: 'AbCdEfGhIjKlMnOpQrStUv' };
    dispatch(msg, sender);
    expect(onConfirmCompletion).toHaveBeenCalledTimes(1);
    expect(onConfirmCompletion).toHaveBeenCalledWith(msg, sender);
  });

  it('is ignored from an extension page (no tab: not a relay)', () => {
    dispatch(
      { type: 'account-confirm-completion', completion: 'AbCdEfGhIjKlMnOpQrStUv' },
      { id: 'ext' },
    );
    expect(onConfirmCompletion).not.toHaveBeenCalled();
  });
});

describe('get-connected-identities', () => {
  it('carries this browser’s key fingerprint', async () => {
    const { state } = await import('../src/background/state.js');
    const { extensionKeyFingerprint } = await import('../src/account-confirm.js');
    const { response } = dispatch({ type: 'get-connected-identities' }, { id: 'ext' });
    const answer = (await response) as { extensionFingerprint?: string };
    expect(answer.extensionFingerprint).toBe(
      await extensionKeyFingerprint(state.extIdentity!.x25519Pub),
    );
  });
});
