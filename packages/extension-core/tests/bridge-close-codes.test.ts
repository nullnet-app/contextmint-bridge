import { describe, expect, it } from 'vitest';

import { ACCOUNT_CONFIRMED_CLOSE, FACTS_CHANGED_CLOSE } from '../src/bridge-close-codes.js';

describe('remote bridge close codes', () => {
  it('keeps the gateway codes used for immediate reattach', () => {
    expect(ACCOUNT_CONFIRMED_CLOSE).toBe(4005);
    expect(FACTS_CHANGED_CLOSE).toBe(4006);
  });
});
