import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fromB64 } from '@fetchproxy/protocol';

import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { freshVault, installChromeLocal } from './helpers/vault.js';
import { settle } from './helpers/settle.js';

/**
 * Binding a remote bridge credential to this extension on connect (mcp-host
 * plan task C2, spec §4.3, invariant I-13's extension half), and honouring
 * the room's `4004 EXTENSION_MISMATCH`.
 *
 * - On the FIRST successful attach of a remote link whose credential is not
 *   known to be bound, `POST /bridge/bind` once, to that link's own gateway.
 * - A 404 means the gateway predates binding: remembered, not retried every
 *   wake.
 * - `4004` stops reconnecting that target and says why; every other close
 *   (`4003` included) keeps today's reconnect.
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
const { credentialKey, loadBindState, recordOriginUnsupported, BIND_UNSUPPORTED_RETRY_MS } =
  await import('../src/bridge-bind-store.js');
const { EXTENSION_MISMATCH_MESSAGE } = await import('../src/bridge-binding.js');
const { bindOnConnect } = await import('../src/background/bind-on-connect.js');

const CREDENTIAL = 'mcpb_' + 'B'.repeat(43);
const HANDOFF = {
  id: 'brt_one',
  url: 'wss://mcp.nullnet.app/bridge',
  token: CREDENTIAL,
  name: 'Safari',
};
const PASTED = {
  id: 'b1',
  url: 'wss://gw.test/bridge',
  token: 'mcpb_' + 'P'.repeat(43),
  tokenId: 'brt_pasted',
  enabled: true,
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

describe('bind on the first successful attach', () => {
  it('binds a handed-off credential once, to its own gateway, and remembers it', async () => {
    setHandoffTarget(HANDOFF);
    expect(bindCalls()).toHaveLength(0); // not before the attach succeeded
    lastSocket(HANDOFF.url).open();
    await quiet();
    expect(bindCalls()).toHaveLength(1);
    const [call] = bindCalls();
    expect(call!.url).toBe('https://mcp.nullnet.app/bridge/bind');
    expect(new Headers(call!.init.headers).get('authorization')).toBe(`Bearer ${CREDENTIAL}`);
    const body = JSON.parse(String(call!.init.body));
    // Signed over the handed-off credential's id, at the gateway it dials.
    const message = new TextEncoder().encode(
      [
        'mcp-host/bridge-bind/v1',
        'https://mcp.nullnet.app',
        'brt_one',
        body.x25519Pub,
        body.ed25519Pub,
      ].join('\0'),
    );
    const key = await crypto.subtle.importKey(
      'raw',
      fromB64(body.ed25519Pub) as BufferSource,
      'Ed25519',
      false,
      ['verify'],
    );
    expect(
      await crypto.subtle.verify('Ed25519', key, fromB64(body.sig) as BufferSource, message),
    ).toBe(true);
    expect(await loadBindState(await credentialKey(CREDENTIAL))).toBe('bound');

    // A reconnect on the same link does not bind again...
    lastSocket(HANDOFF.url).remoteClose(1006);
    for (const link of links.values()) link.nextAttemptAt = 0;
    connect();
    lastSocket(HANDOFF.url).open();
    await quiet();
    // ...and neither does a fresh link (a new wake) for the same credential.
    setHandoffTarget(null);
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).open();
    await quiet();
    expect(bindCalls()).toHaveLength(1);
  });

  it('binds a vault target that knows its credential id, and never one that does not', async () => {
    reconcileRemoteLinks([
      PASTED,
      { ...PASTED, id: 'b2', url: 'wss://noid.test/bridge', tokenId: undefined },
    ]);
    lastSocket(PASTED.url).open();
    lastSocket('wss://noid.test/bridge').open();
    await quiet();
    expect(bindCalls().map((c) => c.url)).toEqual(['https://gw.test/bridge/bind']);
  });

  it('never binds the loopback link', async () => {
    lastSocket('ws://127.0.0.1:37149').open();
    await quiet();
    expect(calls).toHaveLength(0);
  });

  it('remembers a 404 per gateway and does not ask it again on the next wake', async () => {
    answer = () => new Response('not found', { status: 404 });
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).open();
    await quiet();
    expect(bindCalls()).toHaveLength(1);
    // A new wake (fresh link), and another credential on the same gateway.
    setHandoffTarget(null);
    setHandoffTarget({ ...HANDOFF, id: 'brt_two', token: 'mcpb_' + 'Z'.repeat(43) });
    lastSocket(HANDOFF.url).open();
    await quiet();
    expect(bindCalls()).toHaveLength(1);
    expect(await loadBindState(await credentialKey(CREDENTIAL))).toBeNull();
  });

  it('asks a gateway that answered 404 again once the retry window has passed', async () => {
    await recordOriginUnsupported(
      'https://mcp.nullnet.app',
      Date.now() - BIND_UNSUPPORTED_RETRY_MS - 1,
    );
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).open();
    await quiet();
    expect(bindCalls()).toHaveLength(1);
  });

  it('does not retry a refused bind — it would spend /bridge’s own failure allowance', async () => {
    for (const status of [400, 401]) {
      calls = [];
      answer = () => json(status, { error: 'no' });
      const token = `mcpb_${String(status).repeat(12)}`;
      setHandoffTarget({ ...HANDOFF, token });
      lastSocket(HANDOFF.url).open();
      await quiet();
      setHandoffTarget(null);
      setHandoffTarget({ ...HANDOFF, token });
      lastSocket(HANDOFF.url).open();
      await quiet();
      expect(bindCalls()).toHaveLength(1);
      expect(await loadBindState(await credentialKey(token))).toBe('refused');
      setHandoffTarget(null);
    }
  });

  it('records a 409 and does not ask again', async () => {
    answer = () => json(409, { error: 'bound to a different extension' });
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).open();
    await quiet();
    setHandoffTarget(null);
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).open();
    await quiet();
    expect(bindCalls()).toHaveLength(1);
    expect(await loadBindState(await credentialKey(CREDENTIAL))).toBe('conflict');
  });

  it('tries again on the next attach after a transient failure', async () => {
    answer = () => json(503, { error: 'later' });
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).open();
    await quiet();
    lastSocket(HANDOFF.url).remoteClose(1006);
    for (const link of links.values()) link.nextAttemptAt = 0;
    answer = () => json(200, { bound: true });
    connect();
    lastSocket(HANDOFF.url).open();
    await quiet();
    expect(bindCalls()).toHaveLength(2);
    expect(await loadBindState(await credentialKey(CREDENTIAL))).toBe('bound');
  });
});

describe('bind guards', () => {
  it('never binds a hand-off whose id is not a brt_* credential id, and records nothing', async () => {
    setHandoffTarget({ ...HANDOFF, id: 'not-a-credential-id' });
    lastSocket(HANDOFF.url).open();
    await quiet();
    expect(bindCalls()).toHaveLength(0);
    expect(await loadBindState(await credentialKey(CREDENTIAL))).toBeNull();
  });

  it('does not bind for a link withdrawn while the vault was being read', async () => {
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).open(); // bindOnConnect is now awaiting the vault
    setHandoffTarget(null);
    await quiet();
    expect(bindCalls()).toHaveLength(0);
  });

  it('sends one bind when two opens race on the same link', async () => {
    answer = () => json(400, { error: 'no' });
    setHandoffTarget(HANDOFF);
    const link = [...links.values()].find((l) => l.url === HANDOFF.url)!;
    await Promise.all([bindOnConnect(link), bindOnConnect(link)]);
    expect(bindCalls()).toHaveLength(1);
  });

  it('says which origin it signed over when the gateway refuses the bind', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      answer = () => json(400, { error: 'bad signature' });
      setHandoffTarget(HANDOFF);
      lastSocket(HANDOFF.url).open();
      await quiet();
      const lines = warn.mock.calls.map((c) => c.join(' '));
      expect(
        lines.some((l) => l.includes('refused') && l.includes('https://mcp.nullnet.app')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
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
});
