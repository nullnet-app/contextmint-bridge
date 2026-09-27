import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fromB64 } from '@fetchproxy/protocol';

import { loadOrCreateExtensionIdentity } from '../src/extension-identity.js';
import { freshVault, installChromeLocal } from './helpers/vault.js';
import { settle } from './helpers/settle.js';

/**
 * Confirming this browser for its account, from the extension (mcp-host plan
 * task C3, cut as C3a for the managed-pin slice; spec §4.4, invariant I-7).
 *
 * The person asks for it in the popup. The extension then:
 *
 * - Chrome (and Safari when ContextMint cannot take it): signs a start, opens
 *   the gateway's challenge URL in a tab and RECORDS THAT TAB'S ID; the
 *   confirm page's completion comes back through the content script, and is
 *   accepted only from that tab, on the link's gateway origin, on the confirm
 *   page — once. Then `finish`, signed by the bound key.
 * - Safari with ContextMint: `sendNativeMessage({type: "account-confirm",
 *   tokenId, extFingerprint, ts, sig})` for the handed-off credential — no
 *   challenge — and falls back to the tab flow on a rejection or
 *   `unknown-request`.
 *
 * On `4005 ACCOUNT_CONFIRMED` and `4006 FACTS_CHANGED` the link re-dials at
 * once. Nothing here writes trust.
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

const { reconcileRemoteLinks, setHandoffTarget } = await import('../src/background/socket.js');
const { state } = await import('../src/background/state.js');
const { links, linkStatuses, unbindAll } = await import('../src/background/links.js');
const { TrustStore } = await import('../src/trust-store.js');
const { SessionKeys } = await import('../src/session-keys.js');
const { beginAccountConfirm, onConfirmCompletion, PENDING_CONFIRM_KEY } =
  await import('../src/background/account-confirm.js');
const { ACCOUNT_CONFIRM_COMPLETION } = await import('../src/account-confirm-relay.js');
const { extensionKeyFingerprint } = await import('../src/account-confirm.js');
const { CONTEXTMINT_APP_ID } = await import('../src/native-handoff.js');

const ORIGIN = 'https://gw.test';
const SECRET = 'AbCdEfGhIjKlMnOpQrStUv';
const COMPLETION = 'CoMpLeTiOnVaLuE_0123-x';
const CHALLENGE_URL = `${ORIGIN}/bridge/confirm#${SECRET}`;
const PASTED = {
  id: 'b1',
  url: 'wss://gw.test/bridge',
  token: 'mcpb_' + 'P'.repeat(43),
  tokenId: 'brt_pasted',
  enabled: true,
};
const LINK_ID = `remote:${PASTED.id}`;
const HANDOFF = {
  id: 'brt_handoff',
  url: 'wss://mcp.nullnet.app/bridge',
  token: 'mcpb_' + 'H'.repeat(43),
  name: 'Safari',
};
const HANDOFF_LINK_ID = `contextmint:${HANDOFF.id}`;
const CONFIRM_TAB = 41;

type Call = { url: string; init: RequestInit };
let calls: Call[];
let startAnswer: () => Response;
let finishAnswer: () => Response;
let opened: string[];
let now: number;
let session: Map<string, unknown>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const startCalls = () => calls.filter((c) => c.url.endsWith('/bridge/account-confirm/start'));
const finishCalls = () => calls.filter((c) => c.url.endsWith('/bridge/account-confirm/finish'));
const socketsFor = (url: string) => FakeSocket.opened.filter((s) => s.url === url);
const lastSocket = (url: string) => socketsFor(url).at(-1)!;
const quiet = () => settle(() => `${calls.length}`);

function deps(overrides: Record<string, unknown> = {}) {
  return {
    now: () => now,
    openTab: async (url: string) => {
      opened.push(url);
      return CONFIRM_TAB;
    },
    nativeRuntime: () => null,
    ...overrides,
  };
}

/** The browser's own description of who sent a runtime message. */
function fromTab(
  tabId: number,
  url = `${ORIGIN}/bridge/confirm`,
  extra: Record<string, unknown> = {},
) {
  return { tab: { id: tabId }, frameId: 0, url, origin: new URL(url).origin, ...extra };
}

const completionMessage = (completion = COMPLETION) => ({
  type: ACCOUNT_CONFIRM_COMPLETION,
  completion,
});

async function verify(parts: string[], sig: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    state.extIdentity!.ed25519Pub as BufferSource,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'Ed25519',
    key,
    fromB64(sig) as BufferSource,
    new TextEncoder().encode(parts.join('\0')),
  );
}

async function connectedPastedLink(): Promise<void> {
  reconcileRemoteLinks([PASTED]);
  lastSocket(PASTED.url).open();
  await quiet();
}

beforeEach(async () => {
  FakeSocket.opened = [];
  freshVault();
  installChromeLocal();
  session = new Map();
  const chromeObj = (globalThis as { chrome: Record<string, unknown> }).chrome;
  chromeObj.runtime = { getManifest: () => ({ version: '1.0.0' }), sendMessage: () => {} };
  chromeObj.tabs = { query: async () => [] };
  (chromeObj.storage as Record<string, unknown>).session = {
    get: async (k: string) => (session.has(k) ? { [k]: session.get(k) } : {}),
    set: async (kv: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(kv)) session.set(k, structuredClone(v));
    },
    remove: async (k: string) => void session.delete(k),
  };
  calls = [];
  opened = [];
  now = 1_800_000_000_000;
  startAnswer = () => json(200, { challengeUrl: CHALLENGE_URL, expiresAt: 'x' });
  finishAnswer = () => json(200, { id: PASTED.tokenId, accountConfirmed: true });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/bridge/account-confirm/start')) return startAnswer();
    if (String(url).endsWith('/bridge/account-confirm/finish')) return finishAnswer();
    return json(200, { id: 'x', bound: true }); // /bridge/bind
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

describe('starting a confirmation (tab flow)', () => {
  it('signs a start at the link’s own gateway and opens exactly the challenge URL', async () => {
    await connectedPastedLink();
    const result = await beginAccountConfirm(LINK_ID, deps());
    expect(result).toEqual({ ok: true, via: 'tab' });
    expect(startCalls()).toHaveLength(1);
    const [call] = startCalls();
    expect(call!.url).toBe(`${ORIGIN}/bridge/account-confirm/start`);
    expect(new Headers(call!.init.headers).get('authorization')).toBe(`Bearer ${PASTED.token}`);
    const body = JSON.parse(String(call!.init.body));
    expect(body.ts).toBe(Math.floor(now / 1000));
    expect(
      await verify(
        ['mcp-host/bridge-confirm/v1', ORIGIN, PASTED.tokenId, String(body.ts)],
        body.sig,
      ),
    ).toBe(true);
    expect(opened).toEqual([CHALLENGE_URL]);
    expect(linkStatuses().find((l) => l.id === LINK_ID)?.confirm).toEqual({ phase: 'tab' });
    // The recorded tab lives in storage.session — not storage.local, which
    // every site's content script can write — and holds no credential.
    expect(JSON.stringify(session.get(PENDING_CONFIRM_KEY))).toContain(String(CONFIRM_TAB));
    expect(JSON.stringify([...session.values()])).not.toContain(PASTED.token);
  });

  it('opens nothing when the gateway points the challenge anywhere else', async () => {
    await connectedPastedLink();
    startAnswer = () => json(200, { challengeUrl: `https://evil.test/bridge/confirm#${SECRET}` });
    const result = await beginAccountConfirm(LINK_ID, deps());
    expect(result.ok).toBe(false);
    expect(opened).toEqual([]);
    expect(linkStatuses().find((l) => l.id === LINK_ID)?.confirm?.phase).toBe('failed');
  });

  it('shows the gateway’s refusal, and opens nothing', async () => {
    await connectedPastedLink();
    startAnswer = () => json(403, { error: 'this browser could not be confirmed for the account' });
    expect(await beginAccountConfirm(LINK_ID, deps())).toEqual({
      ok: false,
      reason: 'this browser could not be confirmed for the account',
    });
    expect(opened).toEqual([]);
  });

  it('opens no tab when the link’s credential changed while the start was in flight', async () => {
    await connectedPastedLink();
    startAnswer = () => {
      reconcileRemoteLinks([{ ...PASTED, token: 'mcpb_' + 'Q'.repeat(43) }]);
      return json(200, { challengeUrl: CHALLENGE_URL, expiresAt: 'x' });
    };
    expect(await beginAccountConfirm(LINK_ID, deps())).toEqual({
      ok: false,
      reason: 'this bridge changed; try again',
    });
    expect(opened).toEqual([]);
    expect(session.get(PENDING_CONFIRM_KEY)).toBeUndefined();
  });

  it('never starts on the loopback link, an unknown link, or a credential without its id', async () => {
    await connectedPastedLink();
    expect((await beginAccountConfirm('local', deps())).ok).toBe(false);
    expect((await beginAccountConfirm('remote:nope', deps())).ok).toBe(false);
    reconcileRemoteLinks([{ ...PASTED, id: 'b2', tokenId: undefined }]);
    expect((await beginAccountConfirm('remote:b2', deps())).ok).toBe(false);
    expect(startCalls()).toHaveLength(0);
    expect(opened).toEqual([]);
  });

  it('never starts on a link the bridge refused for good (4004)', async () => {
    await connectedPastedLink();
    lastSocket(PASTED.url).remoteClose(4004, 'EXTENSION_MISMATCH');
    expect((await beginAccountConfirm(LINK_ID, deps())).ok).toBe(false);
    expect(startCalls()).toHaveLength(0);
  });

  it('marks only a remote link whose credential id is known as confirmable', async () => {
    await connectedPastedLink();
    reconcileRemoteLinks([
      PASTED,
      { ...PASTED, id: 'b2', url: 'wss://two.test/bridge', tokenId: undefined },
    ]);
    const statuses = linkStatuses();
    expect(statuses.find((l) => l.id === LINK_ID)?.confirmable).toBe(true);
    expect(statuses.find((l) => l.id === 'remote:b2')?.confirmable).toBeUndefined();
    expect(statuses.find((l) => l.id === 'local')?.confirmable).toBeUndefined();
  });
});

describe('the completion comes back only through the tab the extension opened', () => {
  beforeEach(async () => {
    await connectedPastedLink();
    await beginAccountConfirm(LINK_ID, deps());
  });

  it('finishes, signed by the bound key over the completion, and shows it confirmed', async () => {
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(true);
    expect(finishCalls()).toHaveLength(1);
    const [call] = finishCalls();
    expect(call!.url).toBe(`${ORIGIN}/bridge/account-confirm/finish`);
    expect(new Headers(call!.init.headers).get('authorization')).toBe(`Bearer ${PASTED.token}`);
    const body = JSON.parse(String(call!.init.body));
    expect(body.completion).toBe(COMPLETION);
    expect(
      await verify(
        ['mcp-host/bridge-confirm-finish/v1', ORIGIN, PASTED.tokenId, COMPLETION],
        body.sig,
      ),
    ).toBe(true);
    expect(linkStatuses().find((l) => l.id === LINK_ID)?.confirm).toEqual({ phase: 'confirmed' });
  });

  it('ignores a completion from any other tab — and finish is never called (R4-3)', async () => {
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB + 1), deps())).toBe(
      false,
    );
    expect(
      await onConfirmCompletion(completionMessage(), { url: `${ORIGIN}/bridge/confirm` }, deps()),
    ).toBe(false);
    expect(finishCalls()).toHaveLength(0);
    // …and the real tab still can.
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(true);
  });

  it('ignores the recorded tab once it is on another origin (it navigated away)', async () => {
    expect(
      await onConfirmCompletion(
        completionMessage(),
        fromTab(CONFIRM_TAB, 'https://evil.test/bridge/confirm'),
        deps(),
      ),
    ).toBe(false);
    expect(
      await onConfirmCompletion(
        completionMessage(),
        fromTab(CONFIRM_TAB, 'http://gw.test/bridge/confirm'),
        deps(),
      ),
    ).toBe(false);
    expect(finishCalls()).toHaveLength(0);
  });

  it('ignores a sender whose reported origin disagrees with its URL', async () => {
    expect(
      await onConfirmCompletion(
        completionMessage(),
        fromTab(CONFIRM_TAB, `${ORIGIN}/bridge/confirm`, { origin: 'https://evil.test' }),
        deps(),
      ),
    ).toBe(false);
    expect(finishCalls()).toHaveLength(0);
  });

  it('ignores the gateway origin anywhere but the confirm page, and any frame but the top one', async () => {
    expect(
      await onConfirmCompletion(
        completionMessage(),
        fromTab(CONFIRM_TAB, `${ORIGIN}/admin`),
        deps(),
      ),
    ).toBe(false);
    expect(
      await onConfirmCompletion(
        completionMessage(),
        fromTab(CONFIRM_TAB, `${ORIGIN}/bridge/confirm`, { frameId: 3 }),
        deps(),
      ),
    ).toBe(false);
    expect(finishCalls()).toHaveLength(0);
  });

  it('ignores a sender the browser reported no URL for (Safari’s sender fields differ)', async () => {
    expect(
      await onConfirmCompletion(
        completionMessage(),
        { tab: { id: CONFIRM_TAB }, frameId: 0, origin: ORIGIN },
        deps(),
      ),
    ).toBe(false);
    expect(finishCalls()).toHaveLength(0);
  });

  it('finishes nothing once the link’s gateway URL was edited — the completion never leaves for another gateway', async () => {
    // Same target id and credential, a different gateway: the link keeps its
    // id and credential, and must not carry gw.test's completion elsewhere.
    reconcileRemoteLinks([{ ...PASTED, url: 'wss://other.test/bridge' }]);
    expect(links.get(LINK_ID)?.url).toBe('wss://other.test/bridge');
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(
      false,
    );
    expect(finishCalls()).toHaveLength(0);
    expect(calls.some((c) => c.url.startsWith('https://other.test/'))).toBe(false);
  });

  it('is single use: a second completion from the same tab finishes nothing', async () => {
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(true);
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(
      false,
    );
    expect(finishCalls()).toHaveLength(1);
  });

  it('expires with the gateway’s ten minutes', async () => {
    now += 10 * 60 * 1000 + 1;
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(
      false,
    );
    expect(finishCalls()).toHaveLength(0);
  });

  it('refuses a malformed completion without spending the recorded tab', async () => {
    expect(
      await onConfirmCompletion(completionMessage('short'), fromTab(CONFIRM_TAB), deps()),
    ).toBe(false);
    expect(
      await onConfirmCompletion(
        { type: 'other', completion: COMPLETION },
        fromTab(CONFIRM_TAB),
        deps(),
      ),
    ).toBe(false);
    expect(finishCalls()).toHaveLength(0);
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(true);
  });

  it('finishes nothing once the link’s credential changed', async () => {
    reconcileRemoteLinks([{ ...PASTED, token: 'mcpb_' + 'Q'.repeat(43) }]);
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(
      false,
    );
    expect(finishCalls()).toHaveLength(0);
  });

  it('a new start supersedes the tab an earlier one opened', async () => {
    let next = CONFIRM_TAB + 10;
    await beginAccountConfirm(LINK_ID, deps({ openTab: async () => next++ }));
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(
      false,
    );
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB + 10), deps())).toBe(
      true,
    );
    expect(finishCalls()).toHaveLength(1);
  });

  it('shows a refused finish, and is not confirmed', async () => {
    finishAnswer = () => json(403, { error: 'refused' });
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(
      false,
    );
    expect(linkStatuses().find((l) => l.id === LINK_ID)?.confirm).toEqual({
      phase: 'failed',
      message: 'refused',
    });
  });

  it('writes no trust anywhere', async () => {
    await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps());
    expect(await state.trust!.list()).toEqual({});
  });

  it('survives the worker restarting: the recorded tab is read back from storage.session', async () => {
    // A fresh module instance has no memory of the start; only storage.session does.
    vi.resetModules();
    const fresh = await import('../src/background/account-confirm.js');
    const freshLinks = await import('../src/background/links.js');
    // The link registry is module state too; hand the fresh module the same link.
    for (const [id, link] of links) freshLinks.links.set(id, link);
    const freshState = await import('../src/background/state.js');
    freshState.state.extIdentity = state.extIdentity;
    expect(await fresh.onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(
      true,
    );
    expect(finishCalls()).toHaveLength(1);
  });
});

describe('without storage.session', () => {
  it('records the tab in memory, with the same checks', async () => {
    delete (
      (globalThis as { chrome: Record<string, unknown> }).chrome.storage as Record<string, unknown>
    ).session;
    await connectedPastedLink();
    await beginAccountConfirm(LINK_ID, deps());
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB + 1), deps())).toBe(
      false,
    );
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(true);
    expect(await onConfirmCompletion(completionMessage(), fromTab(CONFIRM_TAB), deps())).toBe(
      false,
    );
    expect(finishCalls()).toHaveLength(1);
  });
});

describe('Safari inside ContextMint (hand-off contract v1.1)', () => {
  function native(answer: (m: unknown) => unknown) {
    const sent: { app: string; message: unknown }[] = [];
    return {
      sent,
      runtime: {
        sendNativeMessage: async (app: string, message: unknown) => {
          sent.push({ app, message });
          return answer(message);
        },
      },
    };
  }

  async function connectedHandoff(): Promise<void> {
    setHandoffTarget(HANDOFF);
    lastSocket(HANDOFF.url).open();
    await quiet();
  }

  it('asks ContextMint to confirm the credential it handed over — signed, and with no challenge', async () => {
    await connectedHandoff();
    const app = native(() => ({ ok: true }));
    const result = await beginAccountConfirm(
      HANDOFF_LINK_ID,
      deps({ nativeRuntime: () => app.runtime }),
    );
    expect(result).toEqual({ ok: true, via: 'app' });
    expect(app.sent).toHaveLength(1);
    expect(app.sent[0]!.app).toBe(CONTEXTMINT_APP_ID);
    const message = app.sent[0]!.message as Record<string, unknown>;
    expect(Object.keys(message).sort()).toEqual(['extFingerprint', 'sig', 'tokenId', 'ts', 'type']);
    expect(message.type).toBe('account-confirm');
    expect(message.tokenId).toBe(HANDOFF.id);
    expect(message.ts).toBe(Math.floor(now / 1000));
    expect(message.extFingerprint).toBe(
      await extensionKeyFingerprint(state.extIdentity!.x25519Pub),
    );
    expect(
      await verify(
        [
          'mcp-host/bridge-confirm-app/v1',
          'https://mcp.nullnet.app',
          HANDOFF.id,
          String(message.ts),
        ],
        message.sig as string,
      ),
    ).toBe(true);
    // No challenge crossed, and no tab was opened.
    expect(startCalls()).toHaveLength(0);
    expect(opened).toEqual([]);
    expect(JSON.stringify(message)).not.toContain(HANDOFF.token);
    expect(linkStatuses().find((l) => l.id === HANDOFF_LINK_ID)?.confirm).toEqual({ phase: 'app' });
  });

  it('falls back to the tab flow on unknown-request (an app older than v1.1)', async () => {
    await connectedHandoff();
    startAnswer = () =>
      json(200, {
        challengeUrl: `https://mcp.nullnet.app/bridge/confirm#${SECRET}`,
        expiresAt: 'x',
      });
    const app = native(() => ({ error: 'unknown-request' }));
    const result = await beginAccountConfirm(
      HANDOFF_LINK_ID,
      deps({ nativeRuntime: () => app.runtime }),
    );
    expect(result).toEqual({ ok: true, via: 'tab' });
    expect(startCalls()).toHaveLength(1);
    expect(opened).toEqual([`https://mcp.nullnet.app/bridge/confirm#${SECRET}`]);
  });

  it('falls back to the tab flow when the native message is rejected', async () => {
    await connectedHandoff();
    startAnswer = () =>
      json(200, {
        challengeUrl: `https://mcp.nullnet.app/bridge/confirm#${SECRET}`,
        expiresAt: 'x',
      });
    const app = native(() => {
      throw new Error('no handler');
    });
    expect(
      await beginAccountConfirm(HANDOFF_LINK_ID, deps({ nativeRuntime: () => app.runtime })),
    ).toEqual({
      ok: true,
      via: 'tab',
    });
  });

  it('never asks ContextMint about a credential it did not hand over', async () => {
    await connectedPastedLink();
    const app = native(() => ({ ok: true }));
    expect(await beginAccountConfirm(LINK_ID, deps({ nativeRuntime: () => app.runtime }))).toEqual({
      ok: true,
      via: 'tab',
    });
    expect(app.sent).toHaveLength(0);
  });
});

describe('the room’s confirmation closes', () => {
  it('4005 ACCOUNT_CONFIRMED re-dials at once and shows the confirmation this browser asked for', async () => {
    await connectedPastedLink();
    await beginAccountConfirm(LINK_ID, deps());
    const before = socketsFor(PASTED.url).length;
    lastSocket(PASTED.url).remoteClose(4005, 'ACCOUNT_CONFIRMED');
    expect(socketsFor(PASTED.url).length).toBe(before + 1);
    expect(linkStatuses().find((l) => l.id === LINK_ID)?.confirm).toEqual({ phase: 'confirmed' });
  });

  it('an unasked-for 4005 re-dials but claims nothing in the popup', async () => {
    await connectedPastedLink();
    const before = socketsFor(PASTED.url).length;
    lastSocket(PASTED.url).remoteClose(4005, 'ACCOUNT_CONFIRMED');
    expect(socketsFor(PASTED.url).length).toBe(before + 1);
    expect(linkStatuses().find((l) => l.id === LINK_ID)?.confirm).toBeUndefined();
  });

  it('the immediate re-dial keeps the backoff it had — a room that keeps closing climbs it', async () => {
    await connectedPastedLink();
    const link = links.get(LINK_ID)!;
    link.reconnectAttempt = 3;
    lastSocket(PASTED.url).remoteClose(4006);
    expect(link.reconnectAttempt).toBe(3);
    // Closed again before it ever opened, inside the spacing: the backoff grows.
    lastSocket(PASTED.url).remoteClose(4006);
    expect(link.reconnectAttempt).toBe(4);
  });

  it('4006 FACTS_CHANGED re-dials at once too — not an error', async () => {
    await connectedPastedLink();
    const before = socketsFor(PASTED.url).length;
    lastSocket(PASTED.url).remoteClose(4006, 'FACTS_CHANGED');
    expect(socketsFor(PASTED.url).length).toBe(before + 1);
    expect(linkStatuses().find((l) => l.id === LINK_ID)?.refusal).toBeUndefined();
  });

  it('re-dials at once only once per spacing — a room that kept closing is not dialled in a loop', async () => {
    await connectedPastedLink();
    lastSocket(PASTED.url).remoteClose(4006);
    lastSocket(PASTED.url).open();
    const before = socketsFor(PASTED.url).length;
    lastSocket(PASTED.url).remoteClose(4006);
    expect(socketsFor(PASTED.url).length).toBe(before);
    expect(links.get(LINK_ID)!.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it('a plain drop still backs off, and 4004 still stops', async () => {
    await connectedPastedLink();
    const before = socketsFor(PASTED.url).length;
    lastSocket(PASTED.url).remoteClose(1006);
    expect(socketsFor(PASTED.url).length).toBe(before);
    links.get(LINK_ID)!.nextAttemptAt = 0;
    reconcileRemoteLinks([PASTED]);
    lastSocket(PASTED.url).open();
    const after = socketsFor(PASTED.url).length;
    lastSocket(PASTED.url).remoteClose(4004);
    expect(socketsFor(PASTED.url).length).toBe(after);
  });

  it('the loopback link ignores 4005: it has no account', async () => {
    reconcileRemoteLinks([]);
    const local = FakeSocket.opened.filter((s) => s.url === 'ws://127.0.0.1:37149');
    const before = local.length;
    local.at(-1)!.remoteClose(4005);
    expect(FakeSocket.opened.filter((s) => s.url === 'ws://127.0.0.1:37149').length).toBe(before);
    expect(linkStatuses().find((l) => l.id === 'local')?.confirm).toBeUndefined();
  });
});
