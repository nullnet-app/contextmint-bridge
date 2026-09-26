import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { freshVault } from './helpers/vault.js';

/**
 * The link to the bridge target ContextMint handed over (native-handoff.ts):
 * held in memory beside the vault's user-configured targets, dialled like one
 * of them, reported on when it opens and drops, and never written anywhere.
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
    // A real socket closed from this side still fires `close`, later.
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

const storageWrites: unknown[] = [];
function area() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string | string[]) => {
      const out: Record<string, unknown> = {};
      for (const key of Array.isArray(k) ? k : [k]) if (m.has(key)) out[key] = m.get(key);
      return out;
    },
    set: async (kv: Record<string, unknown>) => {
      storageWrites.push(structuredClone(kv));
      for (const [k, v] of Object.entries(kv)) m.set(k, v);
    },
    remove: async () => {},
    onChanged: { addListener: () => {} },
  };
}

vi.stubGlobal('WebSocket', FakeSocket);
vi.stubGlobal('chrome', {
  runtime: { getManifest: () => ({ version: '1.0.0' }), sendMessage: () => {} },
  storage: { local: area(), session: area() },
  tabs: { query: async () => [], create: async () => ({ id: 1 }) },
});

const { reconcileRemoteLinks, setHandoffTarget, handoffLinkOpen, onHandoffLinkState } = await import(
  '../src/background/socket.js'
);
const { state } = await import('../src/background/state.js');
const { links, linkStatuses, unbindAll } = await import('../src/background/links.js');
const { TrustStore } = await import('../src/trust-store.js');
const { SessionKeys } = await import('../src/session-keys.js');
const { bridgeSubprotocols } = await import('../src/remote-targets.js');

const CREDENTIAL = 'mcpb_' + 'B'.repeat(43);
const HANDOFF = {
  id: 'brt_one',
  url: 'wss://mcp.nullnet.app/bridge',
  token: CREDENTIAL,
  name: 'Safari on the Mac',
};
const USER_TARGET = { id: 'b1', url: 'wss://other.example/bridge', token: 'mcpb_user', enabled: true };

const socketFor = (url: string, token: string) =>
  FakeSocket.opened.filter((s) => s.url === url && s.protocols?.includes(`fetchproxy.token.${token}`));
const flush = () => new Promise((r) => setTimeout(r, 0));

let reports: boolean[];

beforeEach(async () => {
  FakeSocket.opened = [];
  storageWrites.length = 0;
  freshVault();
  unbindAll();
  links.clear();
  state.trust = new TrustStore('1.0.0');
  state.sessions = new SessionKeys();
  state.extIdentity = await loadOrCreateExtensionIdentity();
  storageWrites.length = 0;
  reports = [];
  onHandoffLinkState((c) => void reports.push(c));
  reconcileRemoteLinks([]);
});

afterEach(() => {
  setHandoffTarget(null);
});

describe('the handed-off bridge link', () => {
  it('dials the handed-off URL with the credential as its subprotocol', () => {
    setHandoffTarget(HANDOFF);
    const [ws] = socketFor(HANDOFF.url, CREDENTIAL);
    expect(ws).toBeDefined();
    expect(ws!.protocols).toEqual(bridgeSubprotocols(CREDENTIAL));
    // The loopback link is untouched: the hand-off is an addition.
    expect(FakeSocket.opened.some((s) => s.url === 'ws://127.0.0.1:37149')).toBe(true);
  });

  it('reports the link opening and dropping', () => {
    setHandoffTarget(HANDOFF);
    const [ws] = socketFor(HANDOFF.url, CREDENTIAL);
    expect(handoffLinkOpen()).toBe(false);
    ws!.open();
    expect(handoffLinkOpen()).toBe(true);
    ws!.remoteClose(1008, 'revoked');
    expect(handoffLinkOpen()).toBe(false);
    expect(reports).toEqual([true, false]);
  });

  it('reports nothing for a user-configured remote link', () => {
    reconcileRemoteLinks([USER_TARGET]);
    const [ws] = socketFor(USER_TARGET.url, USER_TARGET.token);
    ws!.open();
    ws!.remoteClose();
    expect(reports).toEqual([]);
  });

  it('survives a reconcile of the vault targets — the popup saving does not drop it', () => {
    setHandoffTarget(HANDOFF);
    reconcileRemoteLinks([USER_TARGET]);
    reconcileRemoteLinks([]);
    expect(socketFor(HANDOFF.url, CREDENTIAL)).toHaveLength(1);
    expect([...links.values()].filter((l) => l.handoff)).toHaveLength(1);
  });

  it('is idempotent: the same target handed over again opens no second socket', () => {
    setHandoffTarget(HANDOFF);
    setHandoffTarget({ ...HANDOFF });
    expect(socketFor(HANDOFF.url, CREDENTIAL)).toHaveLength(1);
  });

  it('a changed id is a new credential: drop the old link, dial the new one', async () => {
    setHandoffTarget(HANDOFF);
    const [old] = socketFor(HANDOFF.url, CREDENTIAL);
    old!.open();
    const next = { ...HANDOFF, id: 'brt_two', token: 'mcpb_' + 'C'.repeat(43) };
    setHandoffTarget(next);
    await flush();
    expect(old!.readyState).toBe(3);
    expect(socketFor(next.url, next.token)).toHaveLength(1);
    expect([...links.values()].filter((l) => l.handoff).map((l) => l.id)).toEqual(['contextmint:brt_two']);
  });

  it('not set up any more (null) closes the link and holds none', async () => {
    setHandoffTarget(HANDOFF);
    const [ws] = socketFor(HANDOFF.url, CREDENTIAL);
    ws!.open();
    setHandoffTarget(null);
    await flush();
    expect(ws!.readyState).toBe(3);
    expect([...links.values()].some((l) => l.handoff)).toBe(false);
    expect(handoffLinkOpen()).toBe(false);
  });

  it('refuses a target that fails typed-in validation, even if a caller skips the parser', () => {
    setHandoffTarget({ ...HANDOFF, url: 'ws://evil.example/bridge' });
    setHandoffTarget({ ...HANDOFF, url: 'wss://u:p@mcp.nullnet.app/bridge' });
    setHandoffTarget({ ...HANDOFF, token: 'mcpb_bad token' });
    expect([...links.values()].some((l) => l.handoff)).toBe(false);
    expect(FakeSocket.opened.every((s) => s.url === 'ws://127.0.0.1:37149')).toBe(true);
  });

  it('shows in the link statuses as from ContextMint, without the credential', () => {
    setHandoffTarget(HANDOFF);
    const status = linkStatuses().find((s) => s.handoff);
    expect(status).toMatchObject({
      id: 'contextmint:brt_one',
      kind: 'remote',
      handoff: true,
      label: HANDOFF.name,
      url: HANDOFF.url,
      connected: false,
    });
    expect(JSON.stringify(linkStatuses())).not.toContain(CREDENTIAL);
    // A user-configured row carries no hand-off marker.
    reconcileRemoteLinks([USER_TARGET]);
    expect(linkStatuses().find((s) => s.id === 'remote:b1')).not.toHaveProperty('handoff');
  });

  it('never writes the credential to storage', () => {
    setHandoffTarget(HANDOFF);
    const [ws] = socketFor(HANDOFF.url, CREDENTIAL);
    ws!.open();
    ws!.remoteClose();
    expect(JSON.stringify(storageWrites)).not.toContain(CREDENTIAL);
  });
});
