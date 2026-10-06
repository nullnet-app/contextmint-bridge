import { describe, it, expect, vi } from 'vitest';

import {
  LinkStatusWatch,
  parseLinkRole,
  statusSignature,
  type StatusAnswer,
} from '../src/popup/link-status-watch.js';

/**
 * The popup's own check on the background's link statuses.
 *
 * Safari (macOS 27) is the reason it exists: the background is an event page
 * the popup's query wakes, so the FIRST answer the popup gets describes a link
 * that is still dialling ("Offline"), and the `connections-changed` broadcast
 * that should follow is not something the popup can count on reaching it. The
 * room meanwhile shows the browser attached. The watch re-asks while the popup
 * is open and re-renders only when the answer actually changed.
 */

const ROW = 'remote:brt_safari';
const offline: StatusAnswer = { connectedHashes: [], links: [{ id: ROW, connected: false }] };
const online: StatusAnswer = { connectedHashes: [], links: [{ id: ROW, connected: true }] };

describe('statusSignature', () => {
  it('ignores ordering and the fields the popup does not render from', () => {
    const a = statusSignature({
      connectedHashes: ['b', 'a'],
      links: [
        { id: 'remote:2', connected: true, label: 'x', url: 'wss://x' },
        { id: 'local', connected: false },
      ],
    });
    const b = statusSignature({
      connectedHashes: ['a', 'b'],
      links: [
        { id: 'local', connected: false },
        { id: 'remote:2', connected: true },
      ],
    });
    expect(a).toBe(b);
  });

  it('changes when a link comes up, or is refused', () => {
    expect(statusSignature(offline)).not.toBe(statusSignature(online));
    expect(statusSignature(offline)).not.toBe(
      statusSignature({ links: [{ id: ROW, connected: false, refusal: 'nope' }] }),
    );
  });

  // mcp-host plan task X1: a failover or switch moves the role without the
  // link going up or down, and an open popup must redraw for it.
  it('changes when the room changes what this browser is (bridge-role)', () => {
    const serving = { role: 'serving', canServe: true };
    const standby = { role: 'standby', canServe: true, serving: { label: 'Chrome on Mac' } };
    const other = { role: 'standby', canServe: true, serving: { label: 'Safari on iPhone' } };
    const unconfirmed = { role: 'standby', canServe: false, serving: { label: 'Chrome on Mac' } };
    const sig = (role?: unknown) =>
      statusSignature({ links: [{ id: ROW, connected: true, ...(role ? { role } : {}) }] } as StatusAnswer);
    const all = [sig(), sig(serving), sig(standby), sig(other), sig(unconfirmed)];
    expect(new Set(all).size).toBe(all.length);
  });

  it('changes when the account turns this browser away (4001)', () => {
    expect(statusSignature(offline)).not.toBe(
      statusSignature({ links: [{ id: ROW, connected: false, notice: 'full' }] }),
    );
  });
});

describe('LinkStatusWatch (Safari: the link opens after the popup asked, no broadcast arrives)', () => {
  it('re-renders once the background reports the bridge connected', async () => {
    const answers = [online];
    const query = vi.fn(async () => answers.shift());
    const rerender = vi.fn();
    const watch = new LinkStatusWatch(query, rerender);
    watch.noteRendered(offline); // the popup's first paint: "Offline"
    expect(await watch.check()).toBe(true);
    expect(rerender).toHaveBeenCalledTimes(1);
  });

  it('does not re-render while nothing changed (no churn under the person’s cursor)', async () => {
    const rerender = vi.fn();
    const watch = new LinkStatusWatch(async () => offline, rerender);
    watch.noteRendered(offline);
    expect(await watch.check()).toBe(false);
    expect(await watch.check()).toBe(false);
    expect(rerender).not.toHaveBeenCalled();
  });

  it('re-renders when the first query went unanswered and a later one is answered', async () => {
    const rerender = vi.fn();
    const watch = new LinkStatusWatch(async () => online, rerender);
    watch.noteRendered(undefined); // the woken page had not registered its listener yet
    expect(await watch.check()).toBe(true);
    expect(rerender).toHaveBeenCalledTimes(1);
  });

  it('treats an unanswered or failed query as no news', async () => {
    const rerender = vi.fn();
    const failing = new LinkStatusWatch(async () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    }, rerender);
    failing.noteRendered(offline);
    expect(await failing.check()).toBe(false);
    const silent = new LinkStatusWatch(async () => undefined, rerender);
    silent.noteRendered(offline);
    expect(await silent.check()).toBe(false);
    expect(rerender).not.toHaveBeenCalled();
  });

  it('polls on the given interval until stopped', async () => {
    vi.useFakeTimers();
    try {
      const answers = [offline, online, online];
      const rerender = vi.fn();
      const watch = new LinkStatusWatch(async () => answers.shift() ?? online, rerender);
      watch.noteRendered(offline);
      watch.start(1000);
      await vi.advanceTimersByTimeAsync(1000); // still offline
      expect(rerender).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000); // now connected
      expect(rerender).toHaveBeenCalledTimes(1);
      watch.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(rerender).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parseLinkRole (the background answer, read defensively)', () => {
  it('reads serving, standby and unconfirmed', () => {
    expect(parseLinkRole({ role: 'serving', canServe: true })).toEqual({ role: 'serving', canServe: true });
    expect(parseLinkRole({ role: 'standby', canServe: false, serving: { label: 'Chrome on Mac' } })).toEqual({
      role: 'standby',
      canServe: false,
      serving: { label: 'Chrome on Mac' },
    });
  });

  it('keeps nothing but the fields it shows', () => {
    expect(
      parseLinkRole({ role: 'standby', canServe: true, serving: { label: 'x', since: 5, tokenId: 't' }, extra: 1 }),
    ).toEqual({ role: 'standby', canServe: true, serving: { label: 'x' } });
  });

  it('refuses anything malformed, so the row reads as plain Connected', () => {
    for (const bad of [
      undefined,
      null,
      'serving',
      {},
      { role: 'leader', canServe: true },
      { role: 'serving' },
      { role: 'serving', canServe: 'yes' },
      { role: 'standby', canServe: true },
      { role: 'standby', canServe: true, serving: {} },
      { role: 'standby', canServe: true, serving: { label: '' } },
      { role: 'standby', canServe: true, serving: { label: 7 } },
    ]) {
      expect(parseLinkRole(bad)).toBeUndefined();
    }
  });
});
