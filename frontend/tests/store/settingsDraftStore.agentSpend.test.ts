import { describe, expect, it } from 'vitest';
import { readAgentSpend } from '../../src/store/settingsDraftStore';

describe('readAgentSpend', () => {
  it('keeps the outside budget unset unless one was saved, as the backend does', () => {
    expect(readAgentSpend({ sessionUsd: 5 })).toEqual({ sessionUsd: 5, kreaPlanRuns: null, models: {} });
    expect(readAgentSpend({ sessionUsd: 5, outsideDailyUsd: null }).outsideDailyUsd).toBeNull();
    expect(readAgentSpend({ sessionUsd: 5, outsideDailyUsd: 2 }).outsideDailyUsd).toBe(2);
    // Unreadable falls back to the per-session amount, never to no limit.
    expect('outsideDailyUsd' in readAgentSpend({ sessionUsd: 5, outsideDailyUsd: 'lots' })).toBe(false);
  });

  it('reads Krea plan runs as a whole number of runs', () => {
    expect(readAgentSpend({ kreaPlanRuns: 25 }).kreaPlanRuns).toBe(25);
    for (const bad of [0, -3, 2.5, '10', true]) expect(readAgentSpend({ kreaPlanRuns: bad }).kreaPlanRuns).toBeNull();
  });
});
