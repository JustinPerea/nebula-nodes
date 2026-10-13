import { describe, expect, it } from 'vitest';
import { readAgentSpend } from '../../src/store/settingsDraftStore';

describe('readAgentSpend', () => {
  it('keeps the outside budget unset unless one was saved, as the backend does', () => {
    expect(readAgentSpend({ sessionUsd: 5 })).toEqual({ sessionUsd: 5, models: {} });
    expect(readAgentSpend({ sessionUsd: 5, outsideDailyUsd: null }).outsideDailyUsd).toBeNull();
    expect(readAgentSpend({ sessionUsd: 5, outsideDailyUsd: 2 }).outsideDailyUsd).toBe(2);
    // Unreadable falls back to the per-session amount, never to no limit.
    expect('outsideDailyUsd' in readAgentSpend({ sessionUsd: 5, outsideDailyUsd: 'lots' })).toBe(false);
  });

  it('reads Krea plan runs as a whole number of runs, failing closed like the backend', () => {
    expect(readAgentSpend({ kreaPlanRuns: 25 }).kreaPlanRuns).toBe(25);
    expect(readAgentSpend({ kreaPlanRuns: 0 }).kreaPlanRuns).toBe(0);
    expect(readAgentSpend({ kreaPlanRuns: 100_000 }).kreaPlanRuns).toBe(100_000);
    // Only an explicit null is no limit; left out is the default.
    expect(readAgentSpend({ kreaPlanRuns: null }).kreaPlanRuns).toBeNull();
    expect('kreaPlanRuns' in readAgentSpend({ sessionUsd: 5 })).toBe(false);
    // Unreadable or past the backend's bound: every plan run asks (0), never no limit.
    for (const bad of [-3, 2.5, '10', true, 100_001]) expect(readAgentSpend({ kreaPlanRuns: bad }).kreaPlanRuns).toBe(0);
  });
});
