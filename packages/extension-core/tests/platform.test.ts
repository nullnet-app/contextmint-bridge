import { afterEach, describe, expect, it, vi } from 'vitest';
import { freshVault } from './helpers/vault.js';

/**
 * The extension hello's `platform` comes from the build, not from a literal.
 *
 * `socket.ts` used to hardcode `platform: 'chrome'`, so a Safari build would
 * have introduced itself to every MCP as Chrome. The value is now an esbuild
 * `define` (`__FETCHPROXY_PLATFORM__`) read through `currentPlatform()`, and a
 * build that forgets the define must fail loudly rather than default to
 * `'chrome'` — a silent default is exactly the bug this replaces.
 */

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static opened: FakeSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  private listeners = new Map<string, ((ev: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    for (const cb of this.listeners.get('open') ?? []) cb({});
  }
  hellos(): Record<string, unknown>[] {
    return this.sent
      .map((s) => JSON.parse(s) as Record<string, unknown>)
      .filter((f) => f.type === 'hello');
  }
}

const storage = new Map<string, unknown>();

function stubChrome(): void {
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '3.2.2' }), sendMessage: () => undefined },
    storage: {
      local: {
        get: async () => ({}),
        set: async (kv: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(kv)) storage.set(k, v);
        },
        remove: async () => undefined,
      },
    },
    tabs: { query: async () => [], create: async () => ({ id: 1 }) },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('currentPlatform()', () => {
  it.each(['chrome', 'safari', 'firefox'] as const)(
    'returns the build-time platform %s',
    async (p) => {
      vi.stubGlobal('__FETCHPROXY_PLATFORM__', p);
      const { currentPlatform } = await import('../src/platform.js');
      expect(currentPlatform()).toBe(p);
    },
  );

  it('throws when the build did not define __FETCHPROXY_PLATFORM__ (no silent chrome default)', async () => {
    vi.stubGlobal('__FETCHPROXY_PLATFORM__', undefined);
    const { currentPlatform } = await import('../src/platform.js');
    expect(() => currentPlatform()).toThrow(/platform is not defined/);
  });

  it('throws on a value the protocol does not accept', async () => {
    vi.stubGlobal('__FETCHPROXY_PLATFORM__', 'edge');
    const { currentPlatform } = await import('../src/platform.js');
    expect(() => currentPlatform()).toThrow(/edge/);
  });
});

describe('the extension hello', () => {
  it.each(['safari', 'chrome'] as const)(
    'carries platform %s when the build is configured for it',
    async (p) => {
      stubChrome();
      vi.stubGlobal('__FETCHPROXY_PLATFORM__', p);
      FakeSocket.opened = [];
      freshVault();

      const { connect } = await import('../src/background/socket.js');
      const { state } = await import('../src/background/state.js');
      const { links, unbindAll } = await import('../src/background/links.js');
      const { TrustStore } = await import('../src/trust-store.js');
      const { SessionKeys } = await import('../src/session-keys.js');
      const { loadOrCreateExtensionIdentity } = await import('../src/extension-identity.js');

      unbindAll();
      links.clear();
      state.trust = new TrustStore('3.2.2');
      state.sessions = new SessionKeys();
      state.extIdentity = await loadOrCreateExtensionIdentity();

      connect();
      const ws = FakeSocket.opened.find((s) => s.url.startsWith('ws://127.0.0.1'));
      expect(ws, 'connect() opened no loopback socket').toBeDefined();
      ws!.open();

      const [hello] = ws!.hellos();
      expect(hello).toMatchObject({ type: 'hello', role: 'extension', platform: p });
    },
  );
});
