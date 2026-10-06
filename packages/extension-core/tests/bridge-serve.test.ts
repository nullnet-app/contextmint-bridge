import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { freshVault, installChromeLocal } from './helpers/vault.js';
import { settle } from './helpers/settle.js';

/**
 * X2 (mcp-host plan 2026-10-05-multi-browser-bridge, decisions M3, M8): a
 * remote link's hello lists `bridge-serve`, and on a STANDBY link whose last
 * `bridge-role` said `canServe: true` the popup may ask the account's room to
 * let this browser serve: exactly `{"type":"bridge-serve"}`, on that link
 * only, once until the room's next `bridge-role`. Nowhere else — not on a
 * serving link, an unconfirmed one, one that never heard a `bridge-role`
 * (today's gateway), loopback, or a link that is not open.
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

const { reconcileRemoteLinks, connect, serveFromLink } = await import('../src/background/socket.js');
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

const SERVE_TEXT = '{"type":"bridge-serve"}';
const servesSent = (s: FakeSocket) => s.sent.filter((f) => (JSON.parse(f) as { type: string }).type === 'bridge-serve');
const idOf = (t: { id: string }) => `remote:${t.id}`;

describe('advertising bridge-serve', () => {
  it('a remote hello lists bridge-serve; the loopback hello never does', () => {
    connect();
    reconcileRemoteLinks([A]);
    lastSocket(LOCAL_URL).open();
    lastSocket(A.url).open();
    expect(hello(lastSocket(A.url)).accepts).toContain('bridge-serve');
    expect(hello(lastSocket(A.url)).accepts).toContain('bridge-role');
    expect(hello(lastSocket(LOCAL_URL)).accepts).not.toContain('bridge-serve');
  });
});

describe('serveFromLink', () => {
  it('on an eligible standby link sends exactly the literal frame, once', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    const before = sock.sent.length;
    expect(serveFromLink(idOf(A))).toBe(true);
    expect(sock.sent.slice(before)).toEqual([SERVE_TEXT]);
  });

  it('sends on the chosen link and on no other, even when both could serve', async () => {
    reconcileRemoteLinks([A, B]);
    const a = lastSocket(A.url);
    const b = lastSocket(B.url);
    a.open();
    b.open();
    await deliver(a, STANDBY);
    await deliver(b, STANDBY);
    expect(serveFromLink(idOf(B))).toBe(true);
    expect(servesSent(b)).toEqual([SERVE_TEXT]);
    expect(servesSent(a)).toEqual([]);
  });

  it('sends nothing on a serving link', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, SERVING);
    expect(serveFromLink(idOf(A))).toBe(false);
    expect(servesSent(sock)).toEqual([]);
  });

  it('sends nothing when the room said this browser is not confirmed (canServe false)', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, UNCONFIRMED);
    expect(serveFromLink(idOf(A))).toBe(false);
    expect(servesSent(sock)).toEqual([]);
  });

  // Today's gateway (before mcp-host G10 is deployed) never sends bridge-role,
  // so it is never sent a bridge-serve.
  it('sends nothing on a link that never got a bridge-role', () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    const before = sock.sent.length;
    expect(serveFromLink(idOf(A))).toBe(false);
    expect(sock.sent.length).toBe(before);
  });

  it('sends nothing on loopback, an unknown id, or a link that is not open', async () => {
    connect();
    lastSocket(LOCAL_URL).open();
    expect(serveFromLink(LOCAL_LINK_ID)).toBe(false);
    expect(servesSent(lastSocket(LOCAL_URL))).toEqual([]);
    expect(serveFromLink('remote:brt_nope')).toBe(false);

    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    sock.readyState = FakeSocket.CLOSING;
    expect(serveFromLink(idOf(A))).toBe(false);
    expect(servesSent(sock)).toEqual([]);
  });

  it('is pending until the next bridge-role: a second ask sends nothing', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    expect(statusOf(A.url).servePending).toBeUndefined();
    sendMessage.mockClear();
    expect(serveFromLink(idOf(A))).toBe(true);
    expect(statusOf(A.url).servePending).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith({ type: 'connections-changed' });
    expect(serveFromLink(idOf(A))).toBe(false);
    expect(servesSent(sock)).toHaveLength(1);
  });

  // The room answers a bridge-serve with a bridge-role whether or not it
  // switched (a refusal inside its 10 s limit repeats the same standby), so
  // even an unchanged role ends the pending state and brings the button back.
  it('the next bridge-role ends the pending state, even an identical one, and tells the popup', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    serveFromLink(idOf(A));
    sendMessage.mockClear();
    await deliver(sock, STANDBY);
    expect(statusOf(A.url).servePending).toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith({ type: 'connections-changed' });
    expect(serveFromLink(idOf(A))).toBe(true);
    expect(servesSent(sock)).toHaveLength(2);
  });

  it('a switch answered with serving ends the pending state and offers nothing more', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    serveFromLink(idOf(A));
    await deliver(sock, SERVING);
    expect(statusOf(A.url).servePending).toBeUndefined();
    expect(statusOf(A.url).role).toEqual({ role: 'serving', canServe: true });
    expect(serveFromLink(idOf(A))).toBe(false);
  });

  it('a malformed bridge-role does not end the pending state', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    serveFromLink(idOf(A));
    await deliver(sock, { ...STANDBY, tokenId: 'brt_x' });
    expect(statusOf(A.url).servePending).toBe(true);
  });

  it('a closed link forgets the pending ask; the reopened one has none and no role', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    serveFromLink(idOf(A));
    sock.remoteClose(1006);
    const link = [...links.values()].find((l) => l.url === A.url)!;
    expect(link.servePending).toBe(false);
    expect('servePending' in statusOf(A.url)).toBe(false);
    link.nextAttemptAt = 0;
    connect();
    const fresh = lastSocket(A.url);
    fresh.open();
    expect(link.servePending).toBe(false);
    expect(serveFromLink(idOf(A))).toBe(false);
    expect(servesSent(fresh)).toEqual([]);
  });

  it('a new hello forgets the pending ask, even before the old socket finished closing', async () => {
    reconcileRemoteLinks([A]);
    const old = lastSocket(A.url);
    old.open();
    await deliver(old, STANDBY);
    serveFromLink(idOf(A));
    old.readyState = FakeSocket.CLOSING;
    const link = [...links.values()].find((l) => l.url === A.url)!;
    link.nextAttemptAt = 0;
    connect();
    lastSocket(A.url).open();
    expect(link.servePending).toBe(false);
  });

  it('a send that throws is logged, sends nothing and leaves nothing pending', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    await deliver(sock, STANDBY);
    sock.send = () => {
      throw new Error('gone');
    };
    expect(serveFromLink(idOf(A))).toBe(false);
    expect(statusOf(A.url).servePending).toBeUndefined();
    expect(console.warn).toHaveBeenCalled();
  });
});
