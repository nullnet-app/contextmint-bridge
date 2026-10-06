import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ROOM_PING_TEXT, ROOM_PONG_TEXT } from '@fetchproxy/protocol';

import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { freshVault, installChromeLocal } from './helpers/vault.js';
import { settle } from './helpers/settle.js';

/**
 * X3 (mcp-host plan 2026-10-05-multi-browser-bridge): every open REMOTE link
 * sends the literal `{"type":"room-ping"}` from the keepalive alarm, so an
 * account room can tell a browser that has gone quiet (a phone's Safari
 * suspended on screen-off) from one that is merely idle, and hand its MCPs to
 * another browser. The relay answers with a fixed auto-response, accepted here
 * silently. Loopback has no room: it is never pinged and never advertises it.
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
    queueMicrotask(() => this.emit('close', { code: 1000, reason: '' }));
  }
  emit(type: string, ev: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) cb(ev);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open', {});
  }
  message(data: string): void {
    this.emit('message', { data });
  }
  remoteClose(code = 1006, reason = ''): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }
}

vi.stubGlobal('WebSocket', FakeSocket);

const { reconcileRemoteLinks, connect, pingRemoteLinks } =
  await import('../src/background/socket.js');
const { state } = await import('../src/background/state.js');
const { links, linkStatuses, unbindAll, LOCAL_LINK_ID } =
  await import('../src/background/links.js');
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

const socketsFor = (url: string) => FakeSocket.opened.filter((s) => s.url === url);
const lastSocket = (url: string) => socketsFor(url).at(-1)!;
/** Every frame that is not the hello: a ping must be the ONLY other thing sent. */
const pings = (s: FakeSocket) =>
  s.sent.filter((f) => (JSON.parse(f) as { type: string }).type !== 'hello');
const hello = (s: FakeSocket) =>
  JSON.parse(s.sent.find((f) => (JSON.parse(f) as { type: string }).type === 'hello')!) as {
    accepts?: string[];
  };

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  FakeSocket.opened = [];
  freshVault();
  installChromeLocal();
  (globalThis as { chrome: Record<string, unknown> }).chrome.runtime = {
    getManifest: () => ({ version: '1.0.0' }),
    sendMessage: () => {},
  };
  (globalThis as { chrome: Record<string, unknown> }).chrome.tabs = { query: async () => [] };
  unbindAll();
  links.clear();
  state.trust = new TrustStore('1.0.0');
  state.sessions = new SessionKeys();
  state.extIdentity = await loadOrCreateExtensionIdentity();
  reconcileRemoteLinks([]);
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  reconcileRemoteLinks([]);
  vi.restoreAllMocks();
});

describe('the room-ping heartbeat', () => {
  it('advertises room-ping on a remote link and never on loopback', () => {
    connect();
    reconcileRemoteLinks([A]);
    lastSocket(LOCAL_URL).open();
    lastSocket(A.url).open();
    expect(hello(lastSocket(A.url)).accepts).toContain('room-ping');
    expect(hello(lastSocket(LOCAL_URL)).accepts).not.toContain('room-ping');
  });

  it('sends exactly the literal text once per open remote link per tick', () => {
    connect();
    reconcileRemoteLinks([A, B]);
    lastSocket(LOCAL_URL).open();
    lastSocket(A.url).open();
    lastSocket(B.url).open();

    pingRemoteLinks();

    expect(pings(lastSocket(A.url))).toEqual([ROOM_PING_TEXT]);
    expect(pings(lastSocket(B.url))).toEqual([ROOM_PING_TEXT]);
    // The exact bytes the relay's fixed auto-response pair compares against.
    expect(ROOM_PING_TEXT).toBe('{"type":"room-ping"}');

    pingRemoteLinks();
    expect(pings(lastSocket(A.url))).toEqual([ROOM_PING_TEXT, ROOM_PING_TEXT]);
    expect(pings(lastSocket(B.url))).toEqual([ROOM_PING_TEXT, ROOM_PING_TEXT]);
  });

  it('never pings the loopback link', () => {
    connect();
    reconcileRemoteLinks([A]);
    lastSocket(LOCAL_URL).open();
    lastSocket(A.url).open();
    pingRemoteLinks();
    expect(pings(lastSocket(LOCAL_URL))).toEqual([]);
    expect(links.get(LOCAL_LINK_ID)).toBeDefined();
    // Skipped outright, not attempted and refused by the `accepts` gate: a
    // loopback that logged a refusal every tick would be noise forever.
    expect(warn).not.toHaveBeenCalled();
  });

  it('sends nothing on a link still dialling, and dials nothing', () => {
    reconcileRemoteLinks([A]);
    const dialling = lastSocket(A.url); // CONNECTING, never opened
    const before = FakeSocket.opened.length;
    pingRemoteLinks();
    expect(dialling.sent).toEqual([]);
    expect(FakeSocket.opened.length).toBe(before);
  });

  it('sends nothing on a closed link, and neither wakes nor re-dials it', () => {
    reconcileRemoteLinks([A]);
    lastSocket(A.url).open();
    lastSocket(A.url).remoteClose(1006);
    const closed = lastSocket(A.url);
    const sentBefore = closed.sent.length;
    const before = FakeSocket.opened.length;
    const link = [...links.values()].find((l) => l.url === A.url)!;
    const nextAttemptAt = link.nextAttemptAt;
    const reconnectAttempt = link.reconnectAttempt;

    pingRemoteLinks();

    expect(closed.sent.length).toBe(sentBefore);
    expect(FakeSocket.opened.length).toBe(before);
    expect(link.nextAttemptAt).toBe(nextAttemptAt);
    expect(link.reconnectAttempt).toBe(reconnectAttempt);
  });

  it('does not ping a link removed from the registry', () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    reconcileRemoteLinks([]);
    sock.readyState = FakeSocket.OPEN; // a socket the runtime has not closed yet
    pingRemoteLinks();
    expect(pings(sock)).toEqual([]);
  });

  it('a send that throws on one link still pings the others', () => {
    reconcileRemoteLinks([A, B]);
    lastSocket(A.url).open();
    lastSocket(B.url).open();
    lastSocket(A.url).send = () => {
      throw new Error('socket went away');
    };
    expect(() => pingRemoteLinks()).not.toThrow();
    expect(pings(lastSocket(B.url))).toEqual([ROOM_PING_TEXT]);
  });

  it('accepts room-pong silently: nothing sent, nothing warned, the link stays up', async () => {
    reconcileRemoteLinks([A]);
    const sock = lastSocket(A.url);
    sock.open();
    const sentBefore = sock.sent.length;
    sock.message(ROOM_PONG_TEXT);
    await settle(() => `${sock.sent.length}`);
    expect(sock.sent.length).toBe(sentBefore);
    expect(warn).not.toHaveBeenCalled();
    expect(sock.readyState).toBe(FakeSocket.OPEN);
    expect(linkStatuses().find((l) => l.url === A.url)!.connected).toBe(true);
  });
});
