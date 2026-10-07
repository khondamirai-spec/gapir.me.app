import { describe, expect, it } from 'vitest';
import { PAID_PLANS, toPlanId } from './types';

describe('toPlanId', () => {
  it('passes through every plan plan_limits holds', () => {
    expect(toPlanId('free')).toBe('free');
    expect(toPlanId('pro')).toBe('pro');
    expect(toPlanId('unlimited')).toBe('unlimited');
  });

  // A plan the app has never heard of must never be drawn as a paid one — the server is the
  // authority on access, and the UI erring towards "free" only ever under-promises.
  it('reads anything unknown as free', () => {
    for (const raw of ['Pro', 'enterprise', '', null, undefined, 1, {}]) {
      expect(toPlanId(raw)).toBe('free');
    }
  });

  it('sells exactly the two paid plans the checkout function accepts', () => {
    expect([...PAID_PLANS]).toEqual(['pro', 'unlimited']);
  });
});
