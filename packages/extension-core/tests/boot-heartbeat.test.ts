import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { freshVault } from './helpers/vault.js';

/**
 * X3: the room-ping heartbeat rides the existing keepalive alarm. Boot wires
 * `pingRemoteLinks` beside `connect`, so each tick pings every open remote
 * link — and adds no second alarm.
 */

const socket = vi.hoisted(() => ({ connect: vi.fn(), pingRemoteLinks: vi.fn() }));
vi.mock('../src/background/socket.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/background/socket.js')>()),
  connect: socket.connect,
  pingRemoteLinks: socket.pingRemoteLinks,
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

beforeEach(() => {
  vi.resetModules();
  freshVault();
  socket.connect.mockClear();
  socket.pingRemoteLinks.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('boot wires the heartbeat to the keepalive', () => {
  it('pings remote links on each keepalive tick, and on no other alarm', async () => {
    const listeners: Array<(alarm: { name: string }) => void> = [];
    const created: string[] = [];
    vi.stubGlobal('chrome', {
      runtime: { getManifest: () => ({ version: '1.0.0' }) },
      storage: { local: area(), session: area() },
      tabs: { query: async () => [] },
      action: {},
      alarms: {
        create: (name: string) => void created.push(name),
        clear: async () => true,
        onAlarm: {
          addListener: (cb: (alarm: { name: string }) => void) => void listeners.push(cb),
        },
      },
    });
    const { maybeBoot } = await import('../src/background/boot.js');
    maybeBoot();
    await new Promise((r) => setTimeout(r, 50));
    expect(created).toEqual(['fetchproxy-keepalive']);
    expect(socket.pingRemoteLinks).not.toHaveBeenCalled();

    for (const l of listeners) l({ name: 'fetchproxy-keepalive' });
    expect(socket.pingRemoteLinks).toHaveBeenCalledTimes(1);

    for (const l of listeners) l({ name: 'some-other-alarm' });
    expect(socket.pingRemoteLinks).toHaveBeenCalledTimes(1);
  });
});
