/**
 * The toolbar "!" says something is waiting in the popup — and nothing else.
 *
 * Three queues in `chrome.storage.session` hold things the person must act on:
 * `pendingPair` (pairings and scope-update offers), `pendingAccountCards` (a new
 * or changed account key) and `pendingAccountMcpCards` (an account MCP asking
 * to connect, or to widen its scope). The badge used to be a latch: every
 * queue could set it, but only a `pendingPair` change could clear it. Allowing
 * an account MCP card left "!" lit over a popup with nothing in it, until the
 * background happened to restart — the stuck badge on Safari.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setPairPendingBadge, syncPendingBadge } from '../src/background/badge.js';
import { decideAccountMcpCard } from '../src/background/server-hello.js';
import { onScopeUpdateDismiss } from '../src/background/approval.js';
import { freshVault } from './helpers/vault.js';

let session: Record<string, unknown>;
let badgeText: string[];

function installChrome(): void {
  session = {};
  badgeText = [];
  vi.stubGlobal('chrome', {
    action: {
      setBadgeText: ({ text }: { text: string }) => void badgeText.push(text),
      setBadgeBackgroundColor: () => undefined,
    },
    storage: {
      session: {
        get: async (k: string | string[]) => {
          const out: Record<string, unknown> = {};
          for (const key of Array.isArray(k) ? k : [k]) {
            if (key in session) out[key] = structuredClone(session[key]);
          }
          return out;
        },
        set: async (kv: Record<string, unknown>) => void Object.assign(session, structuredClone(kv)),
        remove: async (k: string) => void delete session[k],
      },
    },
  });
}

const lit = (): boolean => badgeText.at(-1) === '!';

beforeEach(async () => {
  installChrome();
  await syncPendingBadge(); // badge.ts state is module-level: start dark
  badgeText = [];
});
afterEach(() => vi.unstubAllGlobals());

const mcpCard = { 'link:mcp:hash': { kind: 'confirm', key: 'link:mcp:hash', origin: 'https://mcp.nullnet.app', accountId: 'acc' } };
const accountCard = { 'link:acc': { key: 'link:acc', origin: 'https://mcp.nullnet.app' } };
const pair = { 'id:scope': { key: 'id:scope', kind: 'pair', identityHash: 'id', mcpIds: ['m'] } };

describe('syncPendingBadge — the badge is derived from what is queued', () => {
  it('is dark when nothing is queued', async () => {
    await syncPendingBadge();
    expect(lit()).toBe(false);
  });

  it.each([
    ['a pending pair', 'pendingPair', pair],
    ['an account card', 'pendingAccountCards', accountCard],
    ['an account MCP card', 'pendingAccountMcpCards', mcpCard],
  ])('lights for %s — so a background restart keeps it', async (_name, key, value) => {
    session[key] = value;
    await syncPendingBadge();
    expect(lit()).toBe(true);
  });

  it('clears a "!" left by a queue that has since drained', async () => {
    setPairPendingBadge();
    expect(lit()).toBe(true);
    await syncPendingBadge();
    expect(lit()).toBe(false);
  });

  it('never clears over a pair queued while it was reading', async () => {
    session.pendingPair = {};
    const realGet = (globalThis as { chrome: { storage: { session: { get: (k: unknown) => Promise<unknown> } } } })
      .chrome.storage.session.get;
    (globalThis as { chrome: { storage: { session: { get: unknown } } } }).chrome.storage.session.get = async (k: unknown) => {
      const got = await realGet(k);
      setPairPendingBadge(); // a hello queues a pair mid-read
      return got;
    };
    await syncPendingBadge();
    expect(lit()).toBe(true);
  });
});

describe('deciding the last card clears the "!"', () => {
  it('an account MCP card, allowed or not', async () => {
    session.pendingAccountMcpCards = structuredClone(mcpCard);
    setPairPendingBadge();
    expect(await decideAccountMcpCard('link:mcp:hash', false)).toBe(true);
    expect(session.pendingAccountMcpCards).toBeUndefined();
    expect(lit()).toBe(false);
  });

  it('but draining the pair queue keeps it while an account MCP card still waits', async () => {
    freshVault();
    session.pendingPair = {
      'id:scope': { key: 'id:scope', kind: 'scope-update', identityHash: 'id', mcpIds: ['m'] },
    };
    session.pendingAccountMcpCards = structuredClone(mcpCard);
    setPairPendingBadge();
    await onScopeUpdateDismiss('id:scope', 'id', 'scope');
    expect(session.pendingPair).toBeUndefined();
    expect(lit()).toBe(true);
  });
});
