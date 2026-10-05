import { describe, it, expect, vi, afterEach } from 'vitest';

import { RETIRED_ALARM_NAMES, clearRetiredAlarms } from '../src/retired-alarms.js';

/**
 * Up to 1.5.0 the Safari build registered a 5-minute alarm to ask the
 * ContextMint app for a bridge target. Alarms outlive the code that made
 * them, so an upgraded extension would keep being woken for nothing; the
 * first wake after the upgrade clears it.
 */

afterEach(() => vi.restoreAllMocks());

describe('clearRetiredAlarms', () => {
  it('names the retired ContextMint app alarm', () => {
    expect(RETIRED_ALARM_NAMES).toEqual(['contextmint-handoff']);
  });

  it('clears every retired alarm by name', async () => {
    const clear = vi.fn(async () => true);
    await clearRetiredAlarms({ clear });
    expect(clear.mock.calls).toEqual([['contextmint-handoff']]);
  });

  it('swallows a rejected or throwing clear (logged, never thrown)', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      clearRetiredAlarms({ clear: () => Promise.reject(new Error('nope')) }),
    ).resolves.toBeUndefined();
    await expect(
      clearRetiredAlarms({
        clear: () => {
          throw new Error('sync nope');
        },
      }),
    ).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a clear method', async () => {
    await expect(clearRetiredAlarms(undefined)).resolves.toBeUndefined();
    await expect(clearRetiredAlarms({})).resolves.toBeUndefined();
  });
});
