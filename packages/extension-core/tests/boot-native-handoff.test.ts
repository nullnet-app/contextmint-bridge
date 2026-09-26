import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { freshVault } from './helpers/vault.js';

/**
 * Boot wires the ContextMint hand-off ONLY where `sendNativeMessage` exists
 * (Safari, whose manifest asks for `nativeMessaging`). Chrome has no such
 * method, and there boot must not register the heartbeat alarm, call
 * anything native, or touch the link layer's hand-off at all.
 */

const setHandoffTarget = vi.fn();
const onHandoffLinkState = vi.fn();
vi.mock('../src/background/socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/socket.js')>()),
  connect: vi.fn(),
  loadRemoteLinks: vi.fn(async () => {}),
  setHandoffTarget,
  onHandoffLinkState,
  handoffLinkOpen: () => false,
}));

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
    remove: async () => {},
    onChanged: { addListener: () => {} },
  };
}

function chromeStub(runtimeExtra: Record<string, unknown> = {}) {
  const alarmsCreated: string[] = [];
  return {
    alarmsCreated,
    chrome: {
      runtime: { getManifest: () => ({ version: '1.0.0' }), ...runtimeExtra },
      storage: { local: area(), session: area() },
      tabs: { query: async () => [] },
      action: {},
      alarms: {
        create: (name: string) => void alarmsCreated.push(name),
        onAlarm: { addListener: () => {} },
      },
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  vi.resetModules();
  freshVault();
  setHandoffTarget.mockClear();
  onHandoffLinkState.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('boot and the ContextMint hand-off', () => {
  it('in Safari: asks for the target at wake and registers the heartbeat', async () => {
    const calls: unknown[] = [];
    const stub = chromeStub();
    vi.stubGlobal('chrome', stub.chrome);
    const runtime = {
      sendNativeMessage(this: unknown, app: string, msg: { type: string }) {
        if (this !== runtime) return undefined;
        calls.push([app, msg]);
        return Promise.resolve(msg.type === 'bridge-target' ? { error: 'not-set-up' } : { ok: true });
      },
    };
    vi.stubGlobal('browser', { runtime });
    const { maybeBoot } = await import('../src/background/boot.js');
    maybeBoot();
    // The first ask waits for the vault-backed identity (IndexedDB macrotasks).
    await vi.waitUntil(() => calls.length >= 2, { timeout: 2000 });
    expect(calls).toEqual([
      ['app.nullnet.mcphost', { type: 'bridge-target' }],
      ['app.nullnet.mcphost', { type: 'status', connected: false }],
    ]);
    expect(setHandoffTarget).toHaveBeenCalledWith(null);
    expect(onHandoffLinkState).toHaveBeenCalledTimes(1);
    expect(stub.alarmsCreated).toContain('contextmint-handoff');
  });

  it('in Chrome: inert — nothing native, no heartbeat, no hand-off', async () => {
    const stub = chromeStub();
    vi.stubGlobal('chrome', stub.chrome);
    const { maybeBoot } = await import('../src/background/boot.js');
    maybeBoot();
    await settle();
    expect(setHandoffTarget).not.toHaveBeenCalled();
    expect(onHandoffLinkState).not.toHaveBeenCalled();
    expect(stub.alarmsCreated).not.toContain('contextmint-handoff');
  });
});
