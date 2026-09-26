/**
 * The bridge target ContextMint hands over — the extension side of
 * nullnet-app/mcp-host-app `docs/BRIDGE-HANDOFF.md` (contract v1), which wins
 * wherever this file and it disagree.
 *
 * Safari runs ContextMint Bridge inside the ContextMint app. Instead of the
 * person pasting a `wss://` address and an `mcpb_*` credential into the
 * Bridges form, the signed-in app mints the credential and the app's appex
 * answers `browser.runtime.sendNativeMessage`:
 *
 * - `{type:"bridge-target"}` → `{url, credential, name, id}`, or
 *   `{error:"not-set-up"}` / `{error:"unknown-request"}`; a rejected promise
 *   (no handler — not inside ContextMint) means the same as `not-set-up`;
 * - `{type:"status", connected:<bool>}` → `{ok:true|false}`. It carries
 *   NOTHING else, and `ok:false` changes nothing here.
 *
 * When: at every wake (ask, then report `connected:false` — the link is not up
 * yet), when the link opens or drops, and on a {@link HANDOFF_HEARTBEAT_MINUTES}
 * alarm (ask again, then report the link's current state) — the app reads a
 * report older than ten minutes as "unknown".
 *
 * The credential is held IN MEMORY ONLY. Safari's background is a
 * non-persistent event page, so it is lost at every unload and asked for again
 * at the next wake — that is the design, not a cost. It never touches
 * `storage.*`, IndexedDB (the vault included), a log line or the popup; it
 * goes nowhere but the `fetchproxy.token.<credential>` subprotocol of the
 * socket to the handed-off URL, and only after that URL and credential pass
 * the SAME validation a typed-in remote target does: a handed-off target is
 * trusted no more than one the person typed.
 *
 * Chrome is untouched: its manifest asks for no `nativeMessaging`, so
 * `sendNativeMessage` does not exist there and {@link nativeMessagingRuntime}
 * answers null. The check is that API's presence — never `currentPlatform()`
 * or a user agent.
 */

import { validateRemoteTargetToken, validateRemoteTargetUrl } from './remote-targets.js';

/**
 * The container app's bundle id. Safari routes the message to the containing
 * app's appex whatever this says; the contract names the container.
 */
export const CONTEXTMINT_APP_ID = 'app.nullnet.mcphost';

/** The heartbeat alarm. Timers die with the event page; alarms wake it. */
export const HANDOFF_ALARM_NAME = 'contextmint-handoff';
/** "At least every 5 minutes" (the contract); the app's staleness bound is 10. */
export const HANDOFF_HEARTBEAT_MINUTES = 5;

/** A target ContextMint handed over and this module validated. */
export interface HandoffTarget {
  /** The credential's stable id (`brt_*`). A new id is a new credential. */
  id: string;
  url: string;
  /** The `mcpb_*` credential. In memory only. */
  token: string;
  /** The credential's name in the account; a label for the popup. */
  name: string;
}

/**
 * The one method this module calls. Always called ON its runtime object —
 * Safari's methods need their receiver, and a detached reference answers
 * `undefined` there.
 */
export interface NativeMessagingRuntime {
  sendNativeMessage(application: string, message: unknown): Promise<unknown> | unknown;
}

interface NamespaceLike {
  runtime?: { sendNativeMessage?: unknown };
}

/**
 * The runtime that can reach ContextMint, or null when this browser cannot
 * (Chrome). Prefers `browser` (Safari's promise-returning namespace), then
 * `chrome`. Reads a property's type; calls and detaches nothing.
 */
export function nativeMessagingRuntime(
  globals: { browser?: unknown; chrome?: unknown } = globalThis as { browser?: unknown; chrome?: unknown },
): NativeMessagingRuntime | null {
  for (const ns of [globals.browser, globals.chrome] as (NamespaceLike | undefined)[]) {
    const runtime = ns?.runtime;
    if (runtime && typeof runtime.sendNativeMessage === 'function') {
      return runtime as NativeMessagingRuntime;
    }
  }
  return null;
}

export type ParsedBridgeTarget = { ok: true; target: HandoffTarget } | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v !== '';

/**
 * Read a `bridge-target` answer. Total, and every reason it returns names a
 * failure, never a value — the answer holds a live credential.
 */
export function parseBridgeTargetAnswer(answer: unknown): ParsedBridgeTarget {
  if (!isRecord(answer)) return { ok: false, reason: 'malformed answer' };
  if ('error' in answer) {
    const error = answer['error'];
    if (error === 'not-set-up' || error === 'unknown-request') return { ok: false, reason: error };
    return { ok: false, reason: 'malformed answer' };
  }
  const { url, credential, name, id } = answer;
  if (!nonEmpty(url) || !nonEmpty(credential) || !nonEmpty(name) || !nonEmpty(id)) {
    return { ok: false, reason: 'malformed answer' };
  }
  const urlCheck = validateRemoteTargetUrl(url);
  if (!urlCheck.ok) return { ok: false, reason: `unusable bridge URL: ${urlCheck.reason}` };
  const tokenCheck = validateRemoteTargetToken(credential);
  if (!tokenCheck.ok) return { ok: false, reason: `unusable credential: ${tokenCheck.reason}` };
  return { ok: true, target: { id, url, token: credential, name } };
}

/**
 * `true`/`false` only: the handed-off target is valid by the same rules the
 * Bridges form applies. Exposed for the socket layer, which re-checks every
 * target it is given rather than trusting its caller to have parsed it.
 */
export function isUsableHandoffTarget(t: HandoffTarget): boolean {
  return (
    nonEmpty(t.id) &&
    nonEmpty(t.name) &&
    validateRemoteTargetUrl(t.url).ok &&
    validateRemoteTargetToken(t.token).ok
  );
}

export interface NativeHandoffDeps {
  runtime: NativeMessagingRuntime;
  /** `chrome.alarms` (Safari aliases it); absent → no heartbeat. */
  alarms?: {
    create: (name: string, info: { periodInMinutes?: number }) => unknown;
    onAlarm: { addListener: (cb: (alarm: { name: string }) => void) => void };
  };
  /** Hand the target (or none) to the link layer. */
  setTarget: (target: HandoffTarget | null) => void;
  /** Whether the link to the handed-off target is open right now. */
  linkConnected: () => boolean;
}

export interface NativeHandoff {
  /** Ask for the target, hand it on, then report the link's state. */
  refresh(): Promise<void>;
  /** The link to the handed-off target opened (true) or dropped (false). */
  onLinkState(connected: boolean): void;
}

/**
 * Wire the hand-off. Registers the heartbeat alarm; the caller runs the
 * first {@link NativeHandoff.refresh} once the link layer can dial.
 */
export function startNativeHandoff(deps: NativeHandoffDeps): NativeHandoff {
  const { runtime } = deps;
  let inflight: Promise<void> | null = null;
  /** The last failure warned about, so a heartbeat does not repeat it. */
  let lastWarned: string | null = null;
  /** The last state reported by a link event, so a retry loop reports one drop. */
  let lastLinkState: boolean | null = null;

  const send = async (message: unknown): Promise<unknown> =>
    // Bound: called on `runtime`, never through a detached reference.
    await runtime.sendNativeMessage(CONTEXTMINT_APP_ID, message);

  const report = async (connected: boolean): Promise<void> => {
    try {
      // `{ok:false}` (no App Group — a build without its profile) changes
      // nothing about the link, so the answer is not read.
      await send({ type: 'status', connected });
    } catch {
      // No handler to hear it; nothing to do about that from here.
    }
  };

  const askOnce = async (): Promise<void> => {
    let parsed: ParsedBridgeTarget;
    try {
      parsed = parseBridgeTargetAnswer(await send({ type: 'bridge-target' }));
    } catch {
      // A rejection is "no handler": treated exactly like not-set-up. The
      // error itself is not logged — it is Safari's, and says nothing the
      // person can act on beyond this.
      parsed = { ok: false, reason: 'not-set-up (no answer from the ContextMint app)' };
    }
    if (parsed.ok) {
      lastWarned = null;
      deps.setTarget(parsed.target);
    } else {
      deps.setTarget(null);
      if (parsed.reason !== lastWarned) {
        lastWarned = parsed.reason;
        console.warn(
          `[fetchproxy] no bridge target from ContextMint: ${parsed.reason} — set it up in the ContextMint app`,
        );
      }
    }
    const connected = deps.linkConnected();
    lastLinkState = connected;
    await report(connected);
  };

  const refresh = (): Promise<void> => {
    if (!inflight) {
      inflight = askOnce().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  };

  if (deps.alarms) {
    deps.alarms.create(HANDOFF_ALARM_NAME, { periodInMinutes: HANDOFF_HEARTBEAT_MINUTES });
    deps.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name !== HANDOFF_ALARM_NAME) return;
      void refresh().catch((e) => console.error('[fetchproxy] ContextMint hand-off heartbeat:', e));
    });
  }

  return {
    refresh,
    onLinkState(connected: boolean): void {
      if (connected === lastLinkState) return;
      lastLinkState = connected;
      void report(connected);
    },
  };
}
