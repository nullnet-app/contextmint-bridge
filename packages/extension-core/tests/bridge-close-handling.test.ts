import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { freshVault, installChromeLocal } from './helpers/vault.js';
import { settle } from './helpers/settle.js';

/** The retired bind endpoint stays unused while remote close handling remains covered. */

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

const { reconcileRemoteLinks, setHandoffTarget, connect } =
  await import('../src/background/socket.js');
const { state } = await import('../src/background/state.js');
const { links, linkStatuses, unbindAll } = await import('../src/background/links.js');
const { TrustStore } = await import('../src/trust-store.js');
const { SessionKeys } = await import('../src/session-keys.js');
const { EXTENSION_MISMATCH_MESSAGE } = await import('../src/bridge-gateway.js');

const CREDENTIAL = 'mcpb_' + 'B'.repeat(43);
const HANDOFF = {
  id: 'brt_one',
  url: 'wss://mcp.nullnet.app/bridge',
  token: CREDENTIAL,
  name: 'Safari',
};

type Call = { url: string; init: RequestInit };
let calls: Call[];
let answer: () => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const socketsFor = (url: string) => FakeSocket.opened.filter((s) => s.url === url);
const lastSocket = (url: string) => socketsFor(url).at(-1)!;
const bindCalls = () => calls.filter((c) => c.url.endsWith('/bridge/bind'));
const quiet = () => settle(() => `${calls.length}`);

beforeEach(async () => {
  FakeSocket.opened = [];
  freshVault();
  installChromeLocal();
  (globalThis as { chrome: Record<string, unknown> }).chrome.runtime = {
    getManifest: () => ({ version: '1.0.0' }),
    sendMessage: () => {},
  };
  (globalThis as { chrome: Record<string, unknown> }).chrome.tabs = { query: async () => [] };
  calls = [];
  answer = () => json(200, { id: 'x', bound: true, extensionFingerprint: 'f' });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer();
  });
  unbindAll();
  links.clear();
  state.trust = new TrustStore('1.0.0');
  state.sessions = new SessionKeys();
  state.extIdentity = await loadOrCreateExtensionIdentity();
  reconcileRemoteLinks([]);
});

afterEach(() => {
  setHandoffTarget(null);
  reconcileRemoteLinks([]);
});

describe('retired browser-side credential binding', () => {
  it('does not call /bridge/bind when a remote socket opens', async () => {
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).open();
    await quiet();
    expect(bindCalls()).toHaveLength(0);
  });
});

describe('the room’s close codes', () => {
  it('4004 stops reconnecting that target and says why', async () => {
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).open();
    await quiet();
    const before = socketsFor(HANDOFF.url).length;
    lastSocket(HANDOFF.url).remoteClose(4004, 'EXTENSION_MISMATCH');
    // No reconnect is even scheduled (the open reset the backoff to zero)...
    const refused = [...links.values()].find((l) => l.url === HANDOFF.url)!;
    expect(refused.nextAttemptAt).toBe(0);
    expect(refused.reconnectAttempt).toBe(0);
    // ...and the keepalive's connect() does not re-dial it either.
    for (const link of links.values()) link.nextAttemptAt = 0;
    connect(); // the keepalive tick
    await new Promise((r) => setTimeout(r, 1100)); // past the first backoff step
    expect(socketsFor(HANDOFF.url)).toHaveLength(before);
    const status = linkStatuses().find((l) => l.url === HANDOFF.url)!;
    expect(status.connected).toBe(false);
    expect(status.refusal).toBe(EXTENSION_MISMATCH_MESSAGE);
    expect(EXTENSION_MISMATCH_MESSAGE).toBe('This bridge is paired with a different browser');
  });

  it('a new credential for the target is a new link, and dials again', () => {
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).remoteClose(4004);
    const before = socketsFor(HANDOFF.url).length;
    setHandoffTarget({ ...HANDOFF, id: 'brt_two', token: 'mcpb_' + 'N'.repeat(43) });
    expect(socketsFor(HANDOFF.url)).toHaveLength(before + 1);
    expect(linkStatuses().find((l) => l.url === HANDOFF.url)!.refusal).toBeUndefined();
  });

  it('4003 (revoked) keeps today’s behaviour: it reconnects', () => {
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).remoteClose(4003, 'REVOKED');
    const before = socketsFor(HANDOFF.url).length;
    for (const link of links.values()) link.nextAttemptAt = 0;
    connect();
    expect(socketsFor(HANDOFF.url)).toHaveLength(before + 1);
    expect(linkStatuses().find((l) => l.url === HANDOFF.url)!.refusal).toBeUndefined();
  });

  it('4004 on the loopback link is not a bridge refusal', () => {
    lastSocket('ws://127.0.0.1:37149').remoteClose(4004);
    const before = socketsFor('ws://127.0.0.1:37149').length;
    for (const link of links.values()) link.nextAttemptAt = 0;
    connect();
    expect(socketsFor('ws://127.0.0.1:37149')).toHaveLength(before + 1);
  });

  it('4005 and 4006 immediately redial remote links without confirmation UI state', () => {
    for (const code of [4005, 4006]) {
      setHandoffTarget({ ...HANDOFF, id: `brt_${code}` });
      const before = socketsFor(HANDOFF.url).length;
      lastSocket(HANDOFF.url).remoteClose(code);
      expect(socketsFor(HANDOFF.url)).toHaveLength(before + 1);
      expect(linkStatuses().find((l) => l.url === HANDOFF.url)).not.toHaveProperty('confirm');
    }
  });
});
