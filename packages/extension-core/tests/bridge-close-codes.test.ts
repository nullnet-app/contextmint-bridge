import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_CONFIRMED_CLOSE,
  BROWSER_TAKEN_CLOSE,
  DEFAULT_ROOM_BROWSER_LIMIT,
  FACTS_CHANGED_CLOSE,
  browserTakenMessage,
} from '../src/bridge-close-codes.js';

describe('remote bridge close codes', () => {
  it('keeps the gateway codes used for immediate reattach', () => {
    expect(ACCOUNT_CONFIRMED_CLOSE).toBe(4005);
    expect(FACTS_CHANGED_CLOSE).toBe(4006);
  });

  it('keeps the gateway code for a room with no place for this browser', () => {
    expect(BROWSER_TAKEN_CLOSE).toBe(4001);
    expect(DEFAULT_ROOM_BROWSER_LIMIT).toBe(4);
  });
});

/**
 * mcp-host plan task X4. The reasons are the gateway's exported strings
 * (`packages/gateway/src/bridge/room.ts`: `ROOM_FULL_REASON`,
 * `BROWSER_TAKEN_REASON`), copied here as literals so a gateway rewording
 * shows up as this test failing rather than as a silently generic popup line.
 */
describe('browserTakenMessage (the 4001 popup line)', () => {
  it('names the count from the gateway’s cap reason', () => {
    expect(browserTakenMessage('this account already has 4 browsers attached')).toBe(
      'This account already has 4 browsers connected; disconnect one in Settings',
    );
    expect(browserTakenMessage('this account already has 6 browsers attached')).toBe(
      'This account already has 6 browsers connected; disconnect one in Settings',
    );
  });

  it('says 4 when the reason does not parse', () => {
    for (const reason of ['', 'ROOM_FULL', 'this account already has many browsers attached', undefined]) {
      expect(browserTakenMessage(reason)).toBe(
        'This account already has 4 browsers connected; disconnect one in Settings',
      );
    }
  });

  it('does not claim four browsers when the gateway admits only one', () => {
    // A gateway before G1, or one with BRIDGE_MULTI_BROWSER off or managed
    // pins off, still sends today’s single-slot reason.
    expect(browserTakenMessage('another browser is attached to this account')).toBe(
      'Another browser is connected to this account; disconnect it in Settings',
    );
  });

  it('never lets a reason widen the count past a sane bound', () => {
    expect(browserTakenMessage('this account already has 99999 browsers attached')).toBe(
      'This account already has 4 browsers connected; disconnect one in Settings',
    );
    expect(browserTakenMessage('this account already has 0 browsers attached')).toBe(
      'This account already has 4 browsers connected; disconnect one in Settings',
    );
  });
});
