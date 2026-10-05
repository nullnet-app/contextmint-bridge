import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { freshVault } from './helpers/vault.js';

/**
 * The extension no longer talks to the ContextMint app. Boot never sends a
 * native message (even where `browser.runtime.sendNativeMessage` exists),
 * registers no alarm for it, and clears the one an older version left.
 */

vi.mock('../src/background/socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/socket.js')>()),
  connect: vi.fn(),
  loadRemoteLinks: vi.fn(async () => {}),
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

function chromeStub() {
  const alarmsCreated: string[] = [];
  const alarmsCleared: string[] = [];
  return {
    alarmsCreated,
    alarmsCleared,
    chrome: {
      runtime: { getManifest: () => ({ version: '1.0.0' }) },
      storage: { local: area(), session: area() },
      tabs: { query: async () => [] },
      action: {},
      alarms: {
        create: (name: string) => void alarmsCreated.push(name),
        clear: async (name: string) => {
          alarmsCleared.push(name);
          return true;
        },
        onAlarm: { addListener: () => {} },
      },
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => {
  vi.resetModules();
  freshVault();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('boot without the ContextMint app', () => {
  it('clears the alarm an older version registered, and registers only the keepalive', async () => {
    const stub = chromeStub();
    vi.stubGlobal('chrome', stub.chrome);
    const { maybeBoot } = await import('../src/background/boot.js');
    maybeBoot();
    await settle();
    expect(stub.alarmsCleared).toEqual(['contextmint-handoff']);
    expect(stub.alarmsCreated).toEqual(['fetchproxy-keepalive']);
  });

  it('never sends a native message, even where the browser offers one (Safari)', async () => {
    const stub = chromeStub();
    vi.stubGlobal('chrome', stub.chrome);
    const sendNativeMessage = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('browser', { runtime: { sendNativeMessage } });
    const { maybeBoot } = await import('../src/background/boot.js');
    maybeBoot();
    await settle();
    await settle();
    expect(sendNativeMessage).not.toHaveBeenCalled();
  });
});
