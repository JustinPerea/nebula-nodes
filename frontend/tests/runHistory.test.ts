import { describe, it, expect } from 'vitest';
import {
  openRunRecord,
  closeRunRecord,
  formatRunDuration,
  formatRunAge,
  runTriggerLabel,
  MAX_RUN_HISTORY,
  type RunRecord,
} from '../src/lib/runHistory';

describe('openRunRecord', () => {
  it('prepends a new running record (newest-first)', () => {
    const h0: RunRecord[] = [];
    const h1 = openRunRecord(h0, { id: 'a', trigger: 'graph', startedAt: 100 });
    expect(h1).toHaveLength(1);
    expect(h1[0]).toEqual({ id: 'a', trigger: 'graph', startedAt: 100, status: 'running' });

    const h2 = openRunRecord(h1, { id: 'b', trigger: 'node', startedAt: 200 });
    expect(h2.map((r) => r.id)).toEqual(['b', 'a']);
    expect(h2[0].status).toBe('running');
  });

  it('does not mutate the input array', () => {
    const h0: RunRecord[] = [];
    openRunRecord(h0, { id: 'a', trigger: 'graph', startedAt: 1 });
    expect(h0).toHaveLength(0);
  });

  it('caps the list at MAX_RUN_HISTORY, dropping the oldest', () => {
    let h: RunRecord[] = [];
    for (let i = 0; i < MAX_RUN_HISTORY + 10; i += 1) {
      h = openRunRecord(h, { id: `r${i}`, trigger: 'graph', startedAt: i });
    }
    expect(h).toHaveLength(MAX_RUN_HISTORY);
    // newest is the last inserted, oldest retained is index MAX-1 from the top
    expect(h[0].id).toBe(`r${MAX_RUN_HISTORY + 9}`);
    expect(h[h.length - 1].id).toBe(`r10`);
  });
});

describe('closeRunRecord', () => {
  it('patches the matching record with terminal status + metrics', () => {
    const h = openRunRecord([], { id: 'a', trigger: 'graph', startedAt: 0 });
    const closed = closeRunRecord(h, 'a', { status: 'complete', durationSec: 4.2, nodesExecuted: 3 });
    expect(closed[0]).toEqual({
      id: 'a',
      trigger: 'graph',
      startedAt: 0,
      status: 'complete',
      durationSec: 4.2,
      nodesExecuted: 3,
    });
  });

  it('marks a run failed', () => {
    const h = openRunRecord([], { id: 'a', trigger: 'node', startedAt: 0 });
    expect(closeRunRecord(h, 'a', { status: 'failed' })[0].status).toBe('failed');
  });

  it('marks a run cancelled (cancel path)', () => {
    const h = openRunRecord([], { id: 'a', trigger: 'cluster', startedAt: 0 });
    expect(closeRunRecord(h, 'a', { status: 'cancelled' })[0].status).toBe('cancelled');
  });

  it('is a no-op when the id is absent', () => {
    const h = openRunRecord([], { id: 'a', trigger: 'graph', startedAt: 0 });
    expect(closeRunRecord(h, 'missing', { status: 'complete' })).toEqual(h);
  });

  it('only touches the matching record', () => {
    let h = openRunRecord([], { id: 'a', trigger: 'graph', startedAt: 0 });
    h = openRunRecord(h, { id: 'b', trigger: 'node', startedAt: 1 });
    const closed = closeRunRecord(h, 'a', { status: 'complete', durationSec: 1 });
    expect(closed.find((r) => r.id === 'b')!.status).toBe('running');
    expect(closed.find((r) => r.id === 'a')!.status).toBe('complete');
  });
});

describe('full open→close lifecycle', () => {
  it('graph run that completes', () => {
    let h: RunRecord[] = [];
    h = openRunRecord(h, { id: 'run1', trigger: 'graph', startedAt: 1000 });
    expect(h[0].status).toBe('running');
    h = closeRunRecord(h, 'run1', { status: 'complete', durationSec: 2.5, nodesExecuted: 5 });
    expect(h[0].status).toBe('complete');
    expect(h[0].nodesExecuted).toBe(5);
  });

  it('graph run that fails validation', () => {
    let h: RunRecord[] = [];
    h = openRunRecord(h, { id: 'run1', trigger: 'graph', startedAt: 0 });
    h = closeRunRecord(h, 'run1', { status: 'failed' });
    expect(h[0].status).toBe('failed');
    expect(h[0].durationSec).toBeUndefined();
  });
});

describe('formatRunDuration', () => {
  it('shows one decimal under 10s', () => {
    expect(formatRunDuration(0.8)).toBe('0.8s');
    expect(formatRunDuration(9.4)).toBe('9.4s');
  });
  it('rounds to whole seconds from 10s–60s', () => {
    expect(formatRunDuration(12.6)).toBe('13s');
    expect(formatRunDuration(59)).toBe('59s');
  });
  it('uses m ss above a minute', () => {
    expect(formatRunDuration(65)).toBe('1m 05s');
    expect(formatRunDuration(125)).toBe('2m 05s');
  });
  it('returns a dash for missing/invalid', () => {
    expect(formatRunDuration(undefined)).toBe('—');
    expect(formatRunDuration(-1)).toBe('—');
    expect(formatRunDuration(NaN)).toBe('—');
  });
});

describe('formatRunAge', () => {
  it('says just now under 5s', () => {
    expect(formatRunAge(1000, 1000)).toBe('just now');
    expect(formatRunAge(4000, 1000)).toBe('just now');
  });
  it('counts seconds, minutes, hours', () => {
    expect(formatRunAge(30_000, 0)).toBe('30s ago');
    expect(formatRunAge(120_000, 0)).toBe('2m ago');
    expect(formatRunAge(2 * 3600_000, 0)).toBe('2h ago');
  });
  it('never goes negative', () => {
    expect(formatRunAge(0, 5000)).toBe('just now');
  });
});

describe('runTriggerLabel', () => {
  it('maps triggers to human labels', () => {
    expect(runTriggerLabel('graph')).toBe('Full graph');
    expect(runTriggerLabel('node')).toBe('Single node');
    expect(runTriggerLabel('cluster')).toBe('Selection');
  });
});
