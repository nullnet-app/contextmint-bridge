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

const { reconcileRemoteLinks, connect } =
  await import('../src/background/socket.js');
const { state } = await import('../src/background/state.js');
const { links, linkStatuses, unbindAll } = await import('../src/background/links.js');
const { TrustStore } = await import('../src/trust-store.js');
const { SessionKeys } = await import('../src/session-keys.js');
const { EXTENSION_MISMATCH_MESSAGE } = await import('../src/bridge-gateway.js');

const CREDENTIAL = 'mcpb_' + 'B'.repeat(43);
const TARGET = {
  id: 'brt_one',
  url: 'wss://mcp.nullnet.app/bridge',
  token: CREDENTIAL,
  tokenId: 'brt_one',
  label: 'Safari',
  enabled: true,
};
/** Hold exactly this one configured target (what Connect saves). */
const useTarget = (t: typeof TARGET) => reconcileRemoteLinks([t]);

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
  reconcileRemoteLinks([]);
});

describe('retired browser-side credential binding', () => {
  it('does not call /bridge/bind when a remote socket opens', async () => {
    useTarget(TARGET);
    lastSocket(TARGET.url).open();
    await quiet();
    expect(bindCalls()).toHaveLength(0);
  });
});

describe('the room’s close codes', () => {
  it('4004 stops reconnecting that target and says why', async () => {
    useTarget(TARGET);
    lastSocket(TARGET.url).open();
    await quiet();
    const before = socketsFor(TARGET.url).length;
    lastSocket(TARGET.url).remoteClose(4004, 'EXTENSION_MISMATCH');
    // No reconnect is even scheduled (the open reset the backoff to zero)...
    const refused = [...links.values()].find((l) => l.url === TARGET.url)!;
    expect(refused.nextAttemptAt).toBe(0);
    expect(refused.reconnectAttempt).toBe(0);
    // ...and the keepalive's connect() does not re-dial it either.
    for (const link of links.values()) link.nextAttemptAt = 0;
    connect(); // the keepalive tick
    await new Promise((r) => setTimeout(r, 1100)); // past the first backoff step
    expect(socketsFor(TARGET.url)).toHaveLength(before);
    const status = linkStatuses().find((l) => l.url === TARGET.url)!;
    expect(status.connected).toBe(false);
    expect(status.refusal).toBe(EXTENSION_MISMATCH_MESSAGE);
    expect(EXTENSION_MISMATCH_MESSAGE).toBe('This bridge is paired with a different browser');
  });

  it('a new credential for the target is a new link, and dials again', () => {
    useTarget(TARGET);
    lastSocket(TARGET.url).remoteClose(4004);
    const before = socketsFor(TARGET.url).length;
    useTarget({ ...TARGET, id: 'brt_two', tokenId: 'brt_two', token: 'mcpb_' + 'N'.repeat(43) });
    expect(socketsFor(TARGET.url)).toHaveLength(before + 1);
    expect(linkStatuses().find((l) => l.url === TARGET.url)!.refusal).toBeUndefined();
  });

  it('4003 (revoked) keeps today’s behaviour: it reconnects', () => {
    useTarget(TARGET);
    lastSocket(TARGET.url).remoteClose(4003, 'REVOKED');
    const before = socketsFor(TARGET.url).length;
    for (const link of links.values()) link.nextAttemptAt = 0;
    connect();
    expect(socketsFor(TARGET.url)).toHaveLength(before + 1);
    expect(linkStatuses().find((l) => l.url === TARGET.url)!.refusal).toBeUndefined();
  });

  it('4004 on the loopback link is not a bridge refusal', () => {
    lastSocket('ws://127.0.0.1:37149').remoteClose(4004);
    const before = socketsFor('ws://127.0.0.1:37149').length;
    for (const link of links.values()) link.nextAttemptAt = 0;
    connect();
    expect(socketsFor('ws://127.0.0.1:37149')).toHaveLength(before + 1);
  });

  // mcp-host plan task X4: 4001 BROWSER_TAKEN means the account's room has no
  // place for this browser (its cap, or the single slot). Re-dialling at the
  // floor only knocks on a full room; back off to the slowest step and say why.
  it('4001 says the account is full and backs off to the slowest step', () => {
    useTarget(TARGET);
    const sock = lastSocket(TARGET.url);
    sock.open(); // the room accepts the socket, then closes it: the open reset the backoff
    const before = Date.now();
    sock.remoteClose(4001, 'this account already has 4 browsers attached');
    const link = [...links.values()].find((l) => l.url === TARGET.url)!;
    expect(link.nextAttemptAt - before).toBeGreaterThanOrEqual(60_000);
    // The keepalive tick inside that minute does not re-dial it.
    const count = socketsFor(TARGET.url).length;
    connect();
    expect(socketsFor(TARGET.url)).toHaveLength(count);
    const status = linkStatuses().find((l) => l.url === TARGET.url)!;
    expect(status.connected).toBe(false);
    expect(status.notice).toBe('This account already has 4 browsers connected; disconnect one in Settings');
    // Not a final refusal: once the backoff passes it dials again.
    expect(status.refusal).toBeUndefined();
    link.nextAttemptAt = 0;
    connect();
    expect(socketsFor(TARGET.url)).toHaveLength(count + 1);
  });

  it('4001 against a single-slot room names one other browser, not four', () => {
    useTarget(TARGET);
    lastSocket(TARGET.url).remoteClose(4001, 'another browser is attached to this account');
    expect(linkStatuses().find((l) => l.url === TARGET.url)!.notice).toBe(
      'Another browser is connected to this account; disconnect it in Settings',
    );
  });

  it('the 4001 line goes once the link is up, and on any other close', () => {
    useTarget(TARGET);
    lastSocket(TARGET.url).remoteClose(4001, 'this account already has 4 browsers attached');
    const link = [...links.values()].find((l) => l.url === TARGET.url)!;
    link.nextAttemptAt = 0;
    connect();
    lastSocket(TARGET.url).open();
    // Cleared by the open itself, not merely hidden while connected.
    expect(link.notice).toBeNull();
    expect(linkStatuses().find((l) => l.url === TARGET.url)).not.toHaveProperty('notice');
    lastSocket(TARGET.url).remoteClose(1006);
    expect(linkStatuses().find((l) => l.url === TARGET.url)).not.toHaveProperty('notice');
    // A different close without an open (a dial that failed) clears it too:
    // the room did not say it is full this time.
    lastSocket(TARGET.url).remoteClose(4001, 'this account already has 4 browsers attached');
    expect(linkStatuses().find((l) => l.url === TARGET.url)!.notice).toBeDefined();
    link.nextAttemptAt = 0;
    connect();
    lastSocket(TARGET.url).remoteClose(1006);
    expect(linkStatuses().find((l) => l.url === TARGET.url)).not.toHaveProperty('notice');
  });

  it('a connected link never shows a 4001 line, whatever it holds', () => {
    useTarget(TARGET);
    lastSocket(TARGET.url).open();
    const link = [...links.values()].find((l) => l.url === TARGET.url)!;
    link.notice = 'This account already has 4 browsers connected; disconnect one in Settings';
    expect(linkStatuses().find((l) => l.url === TARGET.url)).not.toHaveProperty('notice');
  });

  it('4004 and 4003 keep their own handling and carry no 4001 line', () => {
    useTarget(TARGET);
    lastSocket(TARGET.url).open();
    lastSocket(TARGET.url).remoteClose(4003, 'REVOKED');
    const link = [...links.values()].find((l) => l.url === TARGET.url)!;
    // 4003 still climbs from the floor: the open reset it, so one step (1 s).
    expect(link.reconnectAttempt).toBe(1);
    expect(link.nextAttemptAt - Date.now()).toBeLessThanOrEqual(1000);
    expect(linkStatuses().find((l) => l.url === TARGET.url)).not.toHaveProperty('notice');
    link.nextAttemptAt = 0;
    connect();
    lastSocket(TARGET.url).remoteClose(4004, 'EXTENSION_MISMATCH');
    const status = linkStatuses().find((l) => l.url === TARGET.url)!;
    expect(status.refusal).toBe(EXTENSION_MISMATCH_MESSAGE);
    expect(status).not.toHaveProperty('notice');
  });

  it('4001 on the loopback link is not a full account', () => {
    lastSocket('ws://127.0.0.1:37149').remoteClose(4001, 'this account already has 4 browsers attached');
    const local = [...links.values()].find((l) => l.kind === 'local')!;
    expect(local.nextAttemptAt - Date.now()).toBeLessThanOrEqual(10_000);
    expect(linkStatuses().find((l) => l.kind === 'local')).not.toHaveProperty('notice');
  });

  it('4005 and 4006 immediately redial remote links without confirmation UI state', () => {
    for (const code of [4005, 4006]) {
      useTarget({ ...TARGET, id: `brt_${code}`, tokenId: `brt_${code}` });
      const before = socketsFor(TARGET.url).length;
      lastSocket(TARGET.url).remoteClose(code);
      expect(socketsFor(TARGET.url)).toHaveLength(before + 1);
      expect(linkStatuses().find((l) => l.url === TARGET.url)).not.toHaveProperty('confirm');
    }
  });
});
