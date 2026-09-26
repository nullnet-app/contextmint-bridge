import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CONTEXTMINT_APP_ID,
  HANDOFF_ALARM_NAME,
  HANDOFF_FAILURE_KINDS,
  HANDOFF_HEARTBEAT_MINUTES,
  handoffAdvice,
  nativeMessagingRuntime,
  parseBridgeTargetAnswer,
  startNativeHandoff,
  type HandoffFailureKind,
  type HandoffTarget,
  type NativeMessagingRuntime,
} from '../src/native-handoff.js';

/**
 * The extension side of nullnet-app/mcp-host-app `docs/BRIDGE-HANDOFF.md`:
 * ContextMint (the app that contains the Safari extension) hands the bridge
 * target over native messaging, and the extension reports back whether its
 * link to it is up. Everything here runs against a mocked
 * `browser.runtime.sendNativeMessage`.
 */

const CREDENTIAL = 'mcpb_' + 'A'.repeat(43);
const GOOD = {
  url: 'wss://mcp.nullnet.app/bridge',
  credential: CREDENTIAL,
  name: "Safari on Chris's MacBook Pro",
  id: 'brt_01J0000000',
};

/**
 * A `runtime` whose `sendNativeMessage` answers from a script, and refuses to
 * work when called detached — Safari's methods need their receiver (the
 * contract's "CALL IT BOUND"), so a detached call here answers `undefined`
 * exactly as Safari's did.
 */
function fakeRuntime(answer: (msg: { type: string }) => unknown) {
  const calls: { app: string; msg: Record<string, unknown> }[] = [];
  const runtime = {
    sendNativeMessage(this: unknown, app: string, msg: Record<string, unknown>): Promise<unknown> | undefined {
      if (this !== runtime) return undefined;
      calls.push({ app, msg });
      try {
        return Promise.resolve(answer(msg as { type: string }));
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
  return { runtime: runtime as NativeMessagingRuntime, calls };
}

function fakeAlarms() {
  const created: { name: string; info: { periodInMinutes?: number } }[] = [];
  const listeners: ((a: { name: string }) => void)[] = [];
  return {
    alarms: {
      create: (name: string, info: { periodInMinutes?: number }) => void created.push({ name, info }),
      onAlarm: { addListener: (cb: (a: { name: string }) => void) => void listeners.push(cb) },
    },
    created,
    fire: (name: string) => {
      for (const l of listeners) l({ name });
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
let debug: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  info = vi.spyOn(console, 'info').mockImplementation(() => {});
  debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  // Nothing this module does may put the credential in a console line.
  for (const spy of [warn, log, error, info, debug]) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain(CREDENTIAL);
    expect(JSON.stringify(spy.mock.calls)).not.toContain('mcpb_');
  }
  vi.restoreAllMocks();
});

describe('nativeMessagingRuntime — the runtime check', () => {
  it('finds browser.runtime when sendNativeMessage exists (Safari with nativeMessaging)', () => {
    const runtime = { sendNativeMessage: () => Promise.resolve({}) };
    expect(nativeMessagingRuntime({ browser: { runtime } })).toBe(runtime);
  });

  it('falls back to chrome.runtime when only that namespace carries it', () => {
    const runtime = { sendNativeMessage: () => Promise.resolve({}) };
    expect(nativeMessagingRuntime({ chrome: { runtime } })).toBe(runtime);
  });

  it('is null in Chrome, where the manifest asks for no nativeMessaging and the method is absent', () => {
    expect(nativeMessagingRuntime({ chrome: { runtime: { getManifest: () => ({}) } } })).toBeNull();
    expect(nativeMessagingRuntime({})).toBeNull();
  });

  it('reads no user agent — the check is the API itself', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/native-handoff.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/userAgent|navigator\./);
    expect(src).not.toMatch(/from '\.\/platform\.js'/);
  });
});

describe('parseBridgeTargetAnswer', () => {
  it('accepts the contract’s set-up answer', () => {
    expect(parseBridgeTargetAnswer(GOOD)).toEqual({
      ok: true,
      target: { id: GOOD.id, url: GOOD.url, token: CREDENTIAL, name: GOOD.name },
    });
  });

  it('accepts ws:// only for a loopback (development) gateway', () => {
    expect(parseBridgeTargetAnswer({ ...GOOD, url: 'ws://127.0.0.1:8787/bridge' }).ok).toBe(true);
    expect(parseBridgeTargetAnswer({ ...GOOD, url: 'ws://mcp.nullnet.app/bridge' })).toMatchObject({
      ok: false,
      reason: expect.stringContaining('ws://'),
    });
  });

  it('validates the handed-off target like a typed-in one', () => {
    for (const url of ['https://mcp.nullnet.app/bridge', 'wss://u:p@mcp.nullnet.app/bridge', 'wss://h/b#x', 'nope']) {
      expect(parseBridgeTargetAnswer({ ...GOOD, url }).ok).toBe(false);
    }
    for (const credential of ['', 'mcpb_has space', 'mcpb_padded==', 'mcpb_a/b', 'mcpb_a,b']) {
      const r = parseBridgeTargetAnswer({ ...GOOD, credential });
      expect(r.ok).toBe(false);
      // The reason names the failure, never the value.
      if (!r.ok && credential !== '') expect(r.reason).not.toContain(credential);
    }
  });

  it('maps the contract’s error answers', () => {
    expect(parseBridgeTargetAnswer({ error: 'not-set-up' })).toEqual({
      ok: false,
      kind: 'not-set-up',
      reason: 'not-set-up',
    });
    expect(parseBridgeTargetAnswer({ error: 'unknown-request' })).toEqual({
      ok: false,
      kind: 'unknown-request',
      reason: 'unknown-request',
    });
  });

  it('classifies every failure by kind, not by its reason text', () => {
    expect(parseBridgeTargetAnswer({ error: 'something-new' })).toMatchObject({ ok: false, kind: 'malformed' });
    expect(parseBridgeTargetAnswer({ url: GOOD.url })).toMatchObject({ ok: false, kind: 'malformed' });
    expect(parseBridgeTargetAnswer({ ...GOOD, url: 'ws://evil.example/bridge' })).toMatchObject({
      ok: false,
      kind: 'unusable-target',
    });
    expect(parseBridgeTargetAnswer({ ...GOOD, credential: 'mcpb_has space' })).toMatchObject({
      ok: false,
      kind: 'unusable-target',
    });
  });

  it('refuses anything malformed', () => {
    for (const answer of [
      undefined,
      null,
      'wss://x',
      [],
      {},
      { error: 'something-new' },
      { ...GOOD, url: 1 },
      { ...GOOD, credential: undefined },
      { ...GOOD, name: undefined },
      { ...GOOD, id: '' },
    ]) {
      expect(parseBridgeTargetAnswer(answer)).toMatchObject({ ok: false });
    }
  });
});

function harness(answer: (msg: { type: string }) => unknown, opts: { connected?: boolean } = {}) {
  const { runtime, calls } = fakeRuntime(answer);
  const alarms = fakeAlarms();
  const targets: (HandoffTarget | null)[] = [];
  let connected = opts.connected ?? false;
  const handoff = startNativeHandoff({
    runtime,
    alarms: alarms.alarms,
    setTarget: (t) => void targets.push(t),
    linkConnected: () => connected,
  });
  return {
    handoff,
    calls,
    alarms,
    targets,
    setConnected: (c: boolean) => {
      connected = c;
    },
  };
}

describe('startNativeHandoff', () => {
  it('asks for the target, hands it on, then reports connected:false — the link is not up yet', async () => {
    const h = harness((m) => (m.type === 'bridge-target' ? GOOD : { ok: true }));
    await h.handoff.refresh();
    expect(h.calls.map((c) => c.app)).toEqual([CONTEXTMINT_APP_ID, CONTEXTMINT_APP_ID]);
    expect(h.calls.map((c) => c.msg)).toEqual([
      { type: 'bridge-target' },
      { type: 'status', connected: false },
    ]);
    expect(h.targets).toEqual([{ id: GOOD.id, url: GOOD.url, token: CREDENTIAL, name: GOOD.name }]);
  });

  it('a status report carries nothing but the boolean', async () => {
    const h = harness((m) => (m.type === 'bridge-target' ? GOOD : { ok: true }));
    await h.handoff.refresh();
    h.handoff.onLinkState(true);
    await flush();
    for (const c of h.calls.filter((c) => c.msg['type'] === 'status')) {
      expect(Object.keys(c.msg).sort()).toEqual(['connected', 'type']);
      expect(typeof c.msg['connected']).toBe('boolean');
    }
  });

  it.each([
    ['not-set-up', () => ({ error: 'not-set-up' })],
    ['unknown-request', () => ({ error: 'unknown-request' })],
    ['a malformed answer', () => ({ url: GOOD.url })],
    ['an invalid target', () => ({ ...GOOD, url: 'ws://evil.example/bridge' })],
    [
      'a rejection (no handler: not inside ContextMint, or the appex failed to load)',
      () => {
        throw new Error('native host not found');
      },
    ],
  ])('%s → no target, one warning, and still a status report', async (_name, bridgeTarget) => {
    const h = harness((m) => (m.type === 'bridge-target' ? bridgeTarget() : { ok: true }));
    await h.handoff.refresh();
    expect(h.targets).toEqual([null]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(h.calls.at(-1)!.msg).toEqual({ type: 'status', connected: false });
  });

  // The warning tells the person what to do, and that differs by failure:
  // only "nothing set up" is fixed by setting it up. An `unknown-request` is
  // the app's handler being older or newer than this extension (the
  // contract), and a malformed or unusable target is the app sending
  // something this extension will not dial — setting it up again fixes
  // neither.
  it.each([
    ['not-set-up', () => ({ error: 'not-set-up' }), /set it up in the ContextMint app/],
    [
      'a rejection',
      () => {
        throw new Error('native host not found');
      },
      /set it up in the ContextMint app/,
    ],
    ['unknown-request', () => ({ error: 'unknown-request' }), /update the ContextMint app/],
    ['a malformed answer', () => ({ url: GOOD.url }), /update the ContextMint app/],
    [
      'an unusable URL',
      () => ({ ...GOOD, url: 'ws://evil.example/bridge' }),
      /check the bridge in the ContextMint app/,
    ],
    [
      'an unusable credential',
      () => ({ ...GOOD, credential: 'mcpb_has space' }),
      /check the bridge in the ContextMint app/,
    ],
  ])('%s → a warning whose advice fits that failure', async (_name, bridgeTarget, advice) => {
    const h = harness((m) => (m.type === 'bridge-target' ? bridgeTarget() : { ok: true }));
    await h.handoff.refresh();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]![0]);
    expect(line).toMatch(advice);
    if (!/set it up/.test(advice.source)) expect(line).not.toMatch(/set it up/);
  });

  it('does not repeat the same warning on every heartbeat', async () => {
    const h = harness((m) => (m.type === 'bridge-target' ? { error: 'not-set-up' } : { ok: true }));
    await h.handoff.refresh();
    await h.handoff.refresh();
    await h.handoff.refresh();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not retry in a loop — one ask per refresh', async () => {
    const h = harness((m) => (m.type === 'bridge-target' ? { error: 'not-set-up' } : { ok: true }));
    await h.handoff.refresh();
    await new Promise((r) => setTimeout(r, 30));
    expect(h.calls.filter((c) => c.msg['type'] === 'bridge-target')).toHaveLength(1);
  });

  it('coalesces overlapping refreshes (a wake and an alarm at once) into one ask', async () => {
    const h = harness((m) => (m.type === 'bridge-target' ? GOOD : { ok: true }));
    await Promise.all([h.handoff.refresh(), h.handoff.refresh()]);
    expect(h.calls.filter((c) => c.msg['type'] === 'bridge-target')).toHaveLength(1);
  });

  it('a failed or ok:false status report changes nothing', async () => {
    const h = harness((m) => {
      if (m.type === 'bridge-target') return GOOD;
      throw new Error('status failed');
    });
    await expect(h.handoff.refresh()).resolves.toBeUndefined();
    const h2 = harness((m) => (m.type === 'bridge-target' ? GOOD : { ok: false }));
    await expect(h2.handoff.refresh()).resolves.toBeUndefined();
    expect(h.targets).toEqual([expect.objectContaining({ id: GOOD.id })]);
    expect(h2.targets).toEqual([expect.objectContaining({ id: GOOD.id })]);
  });

  it('reports the link opening and dropping, once per change', async () => {
    const h = harness((m) => (m.type === 'bridge-target' ? GOOD : { ok: true }));
    await h.handoff.refresh();
    h.calls.length = 0;
    h.handoff.onLinkState(true);
    h.handoff.onLinkState(true);
    h.handoff.onLinkState(false);
    // A remote that keeps refusing closes on every retry; that is one drop.
    h.handoff.onLinkState(false);
    await flush();
    expect(h.calls.map((c) => c.msg)).toEqual([
      { type: 'status', connected: true },
      { type: 'status', connected: false },
    ]);
  });

  it('registers a 5-minute heartbeat alarm that re-asks and reports the current state', async () => {
    let answer: unknown = GOOD;
    const h = harness((m) => (m.type === 'bridge-target' ? answer : { ok: true }));
    expect(h.alarms.created).toEqual([
      { name: HANDOFF_ALARM_NAME, info: { periodInMinutes: HANDOFF_HEARTBEAT_MINUTES } },
    ]);
    expect(HANDOFF_HEARTBEAT_MINUTES).toBeLessThanOrEqual(5);
    await h.handoff.refresh();
    h.setConnected(true);
    h.calls.length = 0;

    h.alarms.fire('some-other-alarm');
    await flush();
    expect(h.calls).toEqual([]);

    // The person disconnected in the app: the heartbeat drops the target.
    answer = { error: 'not-set-up' };
    h.alarms.fire(HANDOFF_ALARM_NAME);
    await new Promise((r) => setTimeout(r, 10));
    expect(h.calls.map((c) => c.msg)).toEqual([
      { type: 'bridge-target' },
      { type: 'status', connected: true },
    ]);
    expect(h.targets.at(-1)).toBeNull();
  });

  it('keeps no copy of the target in any storage — it only hands it on', async () => {
    const storageWrites: unknown[] = [];
    const area = {
      set: (kv: unknown) => void storageWrites.push(kv),
      get: async () => ({}),
      remove: async () => {},
    };
    vi.stubGlobal('chrome', { storage: { local: area, session: area, sync: area } });
    vi.stubGlobal('browser', { storage: { local: area, session: area, sync: area } });
    const lsSet = vi.fn();
    vi.stubGlobal('localStorage', { setItem: lsSet });
    const idbOpen = vi.fn();
    vi.stubGlobal('indexedDB', { open: idbOpen });
    try {
      const h = harness((m) => (m.type === 'bridge-target' ? GOOD : { ok: true }));
      await h.handoff.refresh();
      h.alarms.fire(HANDOFF_ALARM_NAME);
      await new Promise((r) => setTimeout(r, 10));
      expect(storageWrites).toEqual([]);
      expect(lsSet).not.toHaveBeenCalled();
      expect(idbOpen).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// The advice is an exhaustive mapping over the failure kinds, so a kind added
// later fails `tsc` in `handoffAdvice` until it is given its own advice —
// it can never fall through to "update the ContextMint app" by default.
describe('handoffAdvice', () => {
  const expected: Record<HandoffFailureKind, RegExp> = {
    'not-set-up': /set it up in the ContextMint app/,
    'unknown-request': /update the ContextMint app/,
    malformed: /update the ContextMint app/,
    'unusable-target': /check the bridge in the ContextMint app/,
  };

  it('lists every kind exactly once', () => {
    expect([...HANDOFF_FAILURE_KINDS].sort()).toEqual(Object.keys(expected).sort());
  });

  it.each(HANDOFF_FAILURE_KINDS.map((k) => [k]))('%s → its own advice', (kind) => {
    expect(handoffAdvice(kind)).toMatch(expected[kind]);
  });

  it('only a version mismatch is told to update the app', () => {
    const updating = HANDOFF_FAILURE_KINDS.filter((k) => /update the ContextMint app/.test(handoffAdvice(k)));
    expect(updating.sort()).toEqual(['malformed', 'unknown-request']);
  });

  it('refuses a kind it does not know rather than guessing', () => {
    // @ts-expect-error — not a HandoffFailureKind; the type refuses it too.
    expect(() => handoffAdvice('something-new')).toThrow(/something-new/);
  });
});
