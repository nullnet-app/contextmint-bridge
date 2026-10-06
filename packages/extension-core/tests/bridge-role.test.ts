import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { freshVault, installChromeLocal } from './helpers/vault.js';
import { settle } from './helpers/settle.js';

/**
 * X1 (mcp-host plan 2026-10-05-multi-browser-bridge, decision M8): a remote
 * link's hello lists `bridge-role` in `accepts`, and the account room tells
 * the browser whether it SERVES the account or stands by. The extension keeps
 * that per link, in memory, for the popup — display only, never a grant —
 * and loopback (no room) never advertises it or acts on one.
 */

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static opened: FakeSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  closedWith: number | undefined;
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
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', { code: code ?? 1000, reason: '' }));
  }
  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
  message(data: unknown): void {
    this.emit('message', { data: typeof data === 'string' ? data : JSON.stringify(data) });
  }
  remoteClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

vi.stubGlobal('WebSocket', FakeSocket);

const { reconcileRemoteLinks, connect } = await import('../src/background/socket.js');
const { state } = await import('../src/background/state.js');
const { links, linkStatuses, unbindAll, LOCAL_LINK_ID } = await import('../src/background/links.js');
const { TrustStore } = await import('../src/trust-store.js');
const { SessionKeys } = await import('../src/session-keys.js');

const target = (n: string) => ({
  id: `brt_${n}`,
  url: `wss://${n}.example/bridge`,
  token: 'mcpb_' + n.toUpperCase().padEnd(43, 'B'),
  tokenId: `brt_${n}`,
  label: n,
  enabled: true,
});
const A = target('a');
const B = target('b');
const LOCAL_URL = 'ws://127.0.0.1:37149';

const lastSocket = (url: string) => FakeSocket.opened.filter((s) => s.url === url).at(-1)!;
const hello = (s: FakeSocket) =>
  JSON.parse(s.sent.find((f) => (JSON.parse(f) as { type: string }).type === 'hello')!) as {
    accepts?: string[];
  };
const statusOf = (url: string) => linkStatuses().find((l) => l.url === url)!;

const SERVING = { type: 'bridge-role', role: 'serving', canServe: true };
const STANDBY = {
  type: 'bridge-role',
  role: 'standby',
  canServe: true,
  serving: { label: 'Chrome on Mac', since: 1_760_000_000_000 },
};
const UNCONFIRMED = { ...STANDBY, canServe: false };

let sendMessage: ReturnType<typeof vi.fn>;
let local: Record<string, unknown>;

beforeEach(async () => {
  FakeSocket.opened = [];
  freshVault();
  local = installChromeLocal().data;
  sendMessage = vi.fn();
  const chrome = (globalThis as { chrome: Record<string, unknown> }).chrome;
  chrome.runtime = { getManifest: () => ({ version: '1.0.0' }), sendMessage };
  chrome.tabs = { query: async () => [] };
  unbindAll();
  links.clear();
  state.trust = new TrustStore('1.0.0');
  state.sessions = new SessionKeys();
  state.extIdentity = await loadOrCreateExtensionIdentity();
  reconcileRemoteLinks([]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  reconcileRemoteLinks([]);
  vi.restoreAllMocks();
});

/** Deliver `frame` on `sock` and wait for the async message handler to finish. */
async function deliver(sock: FakeSocket, frame: unknown): Promise<void> {
  sock.message(frame);
  await settle(() => JSON.stringify(linkStatuses()));
}

describe('advertising bridge-role', () => {
  it('a remote hello lists bridge-role; the loopback hello never does', () => {
    connect();
    reconcileRemoteLinks([A]);
    lastSocket(LOCAL_URL).open();
    lastSocket(A.url).open();
    expect(hello(lastSocket(A.url)).accepts).toContain('bridge-role');
    expect(hello(lastSocket(LOCAL_URL)).accepts).not.toContain('bridge-role');
  });

});

describe('the role per remote link', () => {
  it('with no bridge-role received, the link status carries no role (reads as today)', () => {
    reconcileRemoteLinks([A]);
    lastSocket(A.url).open();
    const s = statusOf(A.url);
    expect(s.connected).toBe(true);
    expect('role' in s).toBe(false);
  });

  it('records serving', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, SERVING);
    expect(statusOf(A.url).role).toEqual({ role: 'serving', canServe: true });
  });

  it('records standby with the serving label, and the label only', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    expect(statusOf(A.url).role).toEqual({
      role: 'standby',
      canServe: true,
      serving: { label: 'Chrome on Mac' },
    });
  });

  it('records an unconfirmed browser (canServe false)', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, UNCONFIRMED);
    expect(statusOf(A.url).role?.canServe).toBe(false);
  });

  it('follows a change: standby, then serving after failover', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    await deliver(sock, SERVING);
    expect(statusOf(A.url).role).toEqual({ role: 'serving', canServe: true });
  });

  it('tells an open popup when the role changes, and not when it repeats', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    sendMessage.mockClear();
    await deliver(sock, STANDBY);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'connections-changed' });
    sendMessage.mockClear();
    await deliver(sock, STANDBY);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('is per link: one link serving says nothing about another', async () => {
    reconcileRemoteLinks([A, B]);
    lastSocket(A.url).open();
    lastSocket(B.url).open();
    await deliver(lastSocket(A.url), SERVING);
    expect(statusOf(A.url).role?.role).toBe('serving');
    expect('role' in statusOf(B.url)).toBe(false);
  });

  it('forgets the role when the link closes, and a reopened link starts with none', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, SERVING);
    sock.remoteClose(1006);
    expect('role' in statusOf(A.url)).toBe(false);
    const link = [...links.values()].find((l) => l.url === A.url)!;
    expect(link.role).toBeNull();
    link.nextAttemptAt = 0;
    connect();
    lastSocket(A.url).open();
    expect('role' in statusOf(A.url)).toBe(false);
  });

  // A socket the browser is still closing (CLOSING, its close event not yet
  // run) does not stop the keepalive dialling a new one, so the new
  // connection can open before the old one's teardown: its hello must start
  // it with no role of its own.
  it('a new connection opening before the old one finished closing starts with no role', async () => {
    reconcileRemoteLinks([A]);
    const old = lastSocket(A.url);
    old.open();
    await deliver(old, SERVING);
    old.readyState = FakeSocket.CLOSING;
    const link = [...links.values()].find((l) => l.url === A.url)!;
    link.nextAttemptAt = 0;
    connect();
    const fresh = lastSocket(A.url);
    expect(fresh).not.toBe(old);
    fresh.open();
    expect(link.role).toBeNull();
    expect('role' in statusOf(A.url)).toBe(false);
  });

  it('never writes the role to storage.local', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    expect(JSON.stringify(local)).not.toContain('Chrome on Mac');
    expect(JSON.stringify(local)).not.toContain('standby');
  });

  it('drops a malformed bridge-role and keeps the last good one', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    // A control character in the label, an extra member (a token id), and a
    // standby without who serves: each refused by the published validator.
    await deliver(sock, { ...STANDBY, serving: { label: 'evil\u0007', since: 1 } });
    await deliver(sock, { ...SERVING, tokenId: 'brt_x' });
    await deliver(sock, { type: 'bridge-role', role: 'standby', canServe: true });
    expect(statusOf(A.url).role).toEqual({
      role: 'standby',
      canServe: true,
      serving: { label: 'Chrome on Mac' },
    });
  });
});

describe('loopback', () => {
  it('acts on no bridge-role: no role, nothing sent, the link stays up', async () => {
    connect();
    const sock = lastSocket(LOCAL_URL);
    sock.open();
    const sentBefore = sock.sent.length;
    await deliver(sock, SERVING);
    await deliver(sock, STANDBY);
    expect(links.get(LOCAL_LINK_ID)!.role).toBeNull();
    expect('role' in statusOf(LOCAL_URL)).toBe(false);
    expect(sock.sent.length).toBe(sentBefore);
    expect(sock.readyState).toBe(FakeSocket.OPEN);
  });

  // Dropped BEFORE validation, like every account-room frame on loopback: a
  // concentrator's bridge-role is not parsed at all, so even a malformed one
  // logs nothing.
  it('does not even parse one: a malformed bridge-role logs nothing', async () => {
    connect();
    const sock = lastSocket(LOCAL_URL);
    sock.open();
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    await deliver(sock, { type: 'bridge-role', role: 'leader', canServe: 'yes' });
    expect(warn).not.toHaveBeenCalled();
    expect(links.get(LOCAL_LINK_ID)!.role).toBeNull();
  });
});
