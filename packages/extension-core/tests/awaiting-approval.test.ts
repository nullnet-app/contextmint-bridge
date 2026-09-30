import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendAwaitingApproval } from '../src/background/awaiting-approval.js';
import type { Link } from '../src/background/links.js';

describe('sendAwaitingApproval', () => {
  beforeEach(() => {
    class FakeWebSocket {
      static OPEN = 1;
    }
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  function link(kind: 'remote' | 'local' = 'remote', nonce = 1) {
    const sent: string[] = [];
    const value = {
      kind,
      sessionNonce: new Uint8Array([nonce]),
      ws: { readyState: 1, send: (frame: string) => sent.push(frame) },
    } as unknown as Link;
    return { value, sent };
  }

  it('sends once per link session and identity, and sends again for a new session', () => {
    const { value, sent } = link();
    expect(
      sendAwaitingApproval(value, 'mcp-1', ['hello-rejected'], 'identity-a', 'alice', 'Chrome'),
    ).toBe(true);
    expect(
      sendAwaitingApproval(value, 'mcp-2', ['hello-rejected'], 'identity-a', 'alice', 'Chrome'),
    ).toBe(false);
    expect(
      sendAwaitingApproval(value, 'mcp-3', ['hello-rejected'], 'identity-b', 'bob', 'Chrome'),
    ).toBe(true);
    expect(sent).toHaveLength(2);
    expect(JSON.parse(sent[0]!)).toMatchObject({
      type: 'hello-rejected',
      reason: 'awaiting-approval: approve alice in Chrome',
    });
    value.sessionNonce = new Uint8Array([2]);
    expect(
      sendAwaitingApproval(value, 'mcp-1', ['hello-rejected'], 'identity-a', 'alice', 'Chrome'),
    ).toBe(true);
  });

  it('does not notify local links or remote links that did not accept the frame', () => {
    const local = link('local');
    const incompatible = link();
    expect(sendAwaitingApproval(local.value, 'm', ['hello-rejected'], 'h', 'name', 'Chrome')).toBe(
      false,
    );
    expect(sendAwaitingApproval(incompatible.value, 'm', [], 'h', 'name', 'Chrome')).toBe(false);
    expect(sendAwaitingApproval(incompatible.value, 'm', undefined, 'h', 'name', 'Chrome')).toBe(
      false,
    );
    expect(local.sent).toHaveLength(0);
    expect(incompatible.sent).toHaveLength(0);
  });

  it('caps the reason at 200 characters', () => {
    const { value, sent } = link();
    sendAwaitingApproval(value, 'm', ['hello-rejected'], 'h', 'x'.repeat(300), 'Chrome');
    expect(JSON.parse(sent[0]!).reason).toHaveLength(200);
  });
});
