import { describe, expect, it } from 'vitest';
import { readAgentSpend } from '../src/store/settingsDraftStore';
import { MAX_DAILY_TOTAL_USD } from '../src/lib/spendLimits';
import { MAX_DAILY_TOTAL_USD as FIELD_MAX, dailyLimit } from '../src/lib/dailyTotal';

/**
 * A saved daily total over the backend's maximum (only a hand-edited
 * settings file has one) reads as the backend reads it: unreadable, so the
 * $5 default. Shown as the big number and sent back with every agent-spend
 * save, it made validate_caps answer 400 (follow-up to PR #212, finding 3).
 */
describe('the daily total Settings reads', () => {
  it('reads an amount over the maximum as the default, never as itself', () => {
    const read = readAgentSpend({ dailyTotalUsd: MAX_DAILY_TOTAL_USD + 1 });
    expect(read.dailyTotalUsd).toBeUndefined();
    expect(dailyLimit(read.dailyTotalUsd)).toBe(5);
    expect(readAgentSpend({ dailyTotalUsd: 1e308 }).dailyTotalUsd).toBeUndefined();
  });

  it('keeps the maximum itself, a smaller amount and the person\'s null', () => {
    expect(readAgentSpend({ dailyTotalUsd: MAX_DAILY_TOTAL_USD }).dailyTotalUsd).toBe(MAX_DAILY_TOTAL_USD);
    expect(readAgentSpend({ dailyTotalUsd: 7.5 }).dailyTotalUsd).toBe(7.5);
    expect(readAgentSpend({ dailyTotalUsd: null }).dailyTotalUsd).toBeNull();
  });

  it('has one maximum for the store and the typed field', () => {
    expect(FIELD_MAX).toBe(MAX_DAILY_TOTAL_USD);
    expect(MAX_DAILY_TOTAL_USD).toBe(100_000);
  });
});
