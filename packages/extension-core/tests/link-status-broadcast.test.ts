import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { freshVault, installChromeLocal } from './helpers/vault.js';

/**
 * A bridge link coming UP (or going down after being up) tells any open popup.
 *
 * Safari runs the background as an event page that is unloaded when idle and
 * re-woken by the popup's own `get-connected-identities` query. The woken page
 * answers that query at once — while the remote link it just re-read from the
 * vault is still CONNECTING — so the popup renders the row "Offline". Until
 * now nothing told the popup when the socket opened a moment later (only MCP
 * session changes broadcast `connections-changed`), so the row stayed
 * "Offline" for as long as the popup was open while the room showed the
 * browser attached. These pin the broadcast on the link's own transitions.
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

  constructor(
    readonly url: string,
    readonly protocols?: string[],
  ) {
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
  private emit(type: string, ev: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
  remoteClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

vi.stubGlobal('WebSocket', FakeSocket);

const { reconcileRemoteLinks } = await import('../src/background/socket.js');
const { state } = await import('../src/background/state.js');
const { links, linkStatuses, unbindAll } = await import('../src/background/links.js');
const { TrustStore } = await import('../src/trust-store.js');
const { SessionKeys } = await import('../src/session-keys.js');

const TARGET = {
  id: 'brt_safari',
  url: 'wss://mcp.nullnet.app/bridge',
  token: 'mcpb_' + 'S'.repeat(43),
  tokenId: 'brt_safari',
  label: 'Safari (personal)',
  enabled: true,
};

let messages: unknown[];
const broadcasts = (): number =>
  messages.filter((m) => (m as { type?: unknown } | null)?.type === 'connections-changed').length;
const remoteSocket = (): FakeSocket => FakeSocket.opened.filter((s) => s.url === TARGET.url).at(-1)!;
const remoteStatus = () => linkStatuses().find((l) => l.id === `remote:${TARGET.id}`)!;

beforeEach(async () => {
  FakeSocket.opened = [];
  freshVault();
  installChromeLocal();
  messages = [];
  (globalThis as { chrome: Record<string, unknown> }).chrome.runtime = {
    getManifest: () => ({ version: '1.6.1' }),
    sendMessage: (m: unknown) => void messages.push(m),
  };
  (globalThis as { chrome: Record<string, unknown> }).chrome.tabs = { query: async () => [] };
  unbindAll();
  links.clear();
  state.trust = new TrustStore('1.6.1');
  state.sessions = new SessionKeys();
  state.extIdentity = await loadOrCreateExtensionIdentity();
});

afterEach(() => {
  reconcileRemoteLinks([]);
});

describe('connections-changed on a link’s own transitions', () => {
  it('a freshly woken background reports the dialling link as not connected', () => {
    // What the popup's query sees on Safari right after it wakes the page.
    reconcileRemoteLinks([TARGET]);
    expect(remoteStatus().connected).toBe(false);
  });

  it('broadcasts when a remote link opens, so an open popup turns the row Connected', () => {
    reconcileRemoteLinks([TARGET]);
    const before = broadcasts();
    remoteSocket().open();
    expect(remoteStatus().connected).toBe(true);
    expect(broadcasts()).toBeGreaterThan(before);
  });

  it('broadcasts when the loopback link opens too', () => {
    reconcileRemoteLinks([]);
    const local = FakeSocket.opened.find((s) => s.url.startsWith('ws://127.0.0.1'))!;
    const before = broadcasts();
    local.open();
    expect(broadcasts()).toBeGreaterThan(before);
  });

  it('broadcasts when a link that was up goes down', () => {
    reconcileRemoteLinks([TARGET]);
    remoteSocket().open();
    const before = broadcasts();
    remoteSocket().remoteClose(1006);
    expect(remoteStatus().connected).toBe(false);
    expect(broadcasts()).toBeGreaterThan(before);
  });

  it('stays quiet when a dial that never opened fails (no re-render churn while retrying)', () => {
    reconcileRemoteLinks([TARGET]);
    const before = broadcasts();
    remoteSocket().remoteClose(1006);
    expect(broadcasts()).toBe(before);
  });
});
