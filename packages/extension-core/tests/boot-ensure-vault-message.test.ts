import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

/**
 * fleet-audit #1001: the background is the vault's ONLY initialiser. Boot
 * claims that role before anything touches the vault, and answers the
 * popup's `ensure-vault` message by running the owner initialisation. The
 * message is honoured only from an extension page (no `sender.tab`); a
 * content script asking gets no answer.
 */

const ensureVaultAsOwner = vi.fn(async () => {});
const claimVaultOwnership = vi.fn();
vi.mock('../src/vault-migration.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/vault-migration.js')>()),
  ensureVaultAsOwner,
  claimVaultOwnership,
}));
vi.mock('../src/background/socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/socket.js')>()),
  connect: vi.fn(),
  loadRemoteLinks: vi.fn(async () => {}),
}));

type MessageListener = (
  msg: unknown,
  sender: { tab?: unknown; id?: string } | undefined,
  sendResponse: (r: unknown) => void,
) => unknown;
const messageListeners: MessageListener[] = [];
let claimedAtBoot = 0;

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
  sender: { tab?: unknown; id?: string } | undefined,
): {
  async: unknown;
  response: Promise<unknown>;
} {
  let resolve!: (r: unknown) => void;
  const response = new Promise<unknown>((r) => (resolve = r));
  let async: unknown;
  for (const l of messageListeners) {
    const r = l(msg, sender, resolve);
    if (r !== undefined) async = r;
  }
  return { async, response };
}

beforeAll(async () => {
  vi.stubGlobal('chrome', {
    runtime: {
      getManifest: () => ({ version: '1.4.1' }),
      onMessage: { addListener: (cb: MessageListener) => void messageListeners.push(cb) },
    },
    storage: { local: area(), session: area() },
    tabs: { query: async () => [] },
    action: {},
  });
  const { maybeBoot } = await import('../src/background/boot.js');
  maybeBoot();
  claimedAtBoot = claimVaultOwnership.mock.calls.length;
  await new Promise((r) => setTimeout(r, 10));
});

beforeEach(() => ensureVaultAsOwner.mockClear());

describe('boot owns the vault', () => {
  it('claims vault ownership', () => {
    expect(claimedAtBoot).toBe(1);
  });

  it('answers the popup (no sender.tab) by initialising as the owner', async () => {
    const { async, response } = dispatch({ type: 'ensure-vault' }, { id: 'ext-id' });
    expect(async).toBe(true);
    expect(await response).toEqual({ ok: true });
    expect(ensureVaultAsOwner).toHaveBeenCalledTimes(1);
  });

  it('reports a failed initialisation instead of hanging', async () => {
    ensureVaultAsOwner.mockRejectedValueOnce(new Error('disk full'));
    const { response } = dispatch({ type: 'ensure-vault' }, { id: 'ext-id' });
    expect(await response).toEqual({ ok: false, reason: 'disk full' });
  });

  it('ignores the same message from a content script (sender.tab set)', () => {
    dispatch({ type: 'ensure-vault' }, { id: 'ext-id', tab: { id: 7 } });
    expect(ensureVaultAsOwner).not.toHaveBeenCalled();
  });
});
