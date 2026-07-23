import { beforeEach, describe, expect, it } from 'vitest';
import {
  closeRunRecord,
  formatRunAge,
  formatRunDuration,
  freezeRunSnapshot,
  loadRunHistory,
  MAX_RUN_HISTORY,
  openRunRecord,
  persistRunHistory,
  RUN_HISTORY_STORAGE_KEY,
  runTriggerLabel,
  type RunGraphSnapshot,
  type RunRecord,
  type RunTrigger,
} from '../src/lib/runHistory';

function makeSnapshot(prompt = 'Alpha'): RunGraphSnapshot {
  return {
    nodes: [{
      id: 'node-a',
      definitionId: 'text-input',
      params: { value: prompt, nested: { keep: true } },
      outputs: {},
    }],
    edges: [],
  };
}

function open(
  history: RunRecord[],
  id: string,
  trigger: RunTrigger = 'graph',
  startedAt = 0,
): RunRecord[] {
  return openRunRecord(history, { id, trigger, startedAt, snapshot: makeSnapshot(id) });
}

describe('openRunRecord', () => {
  it('prepends a new running record (newest-first)', () => {
    const h0: RunRecord[] = [];
    const h1 = open(h0, 'a', 'graph', 100);
    expect(h1).toHaveLength(1);
    expect(h1[0]).toMatchObject({ id: 'a', trigger: 'graph', startedAt: 100, status: 'running' });

    const h2 = open(h1, 'b', 'node', 200);
    expect(h2.map((r) => r.id)).toEqual(['b', 'a']);
    expect(h2[0].status).toBe('running');
  });

  it('does not mutate the input array', () => {
    const h0: RunRecord[] = [];
    open(h0, 'a');
    expect(h0).toHaveLength(0);
  });

  it('caps the list at 100 records, dropping the oldest', () => {
    let h: RunRecord[] = [];
    for (let i = 0; i < MAX_RUN_HISTORY + 10; i += 1) {
      h = open(h, `r${i}`, 'graph', i);
    }
    expect(MAX_RUN_HISTORY).toBe(100);
    expect(h).toHaveLength(MAX_RUN_HISTORY);
    expect(h[0].id).toBe(`r${MAX_RUN_HISTORY + 9}`);
    expect(h[h.length - 1].id).toBe('r10');
  });

  it('captures an independent, deeply frozen graph snapshot', () => {
    const source = makeSnapshot('original');
    const history = openRunRecord([], {
      id: 'a',
      trigger: 'node',
      startedAt: 1,
      targetNodeId: 'node-a',
      snapshot: source,
    });

    source.nodes[0].params.value = 'mutated';
    (source.nodes[0].params.nested as { keep: boolean }).keep = false;

    expect(history[0].snapshot.nodes[0].params).toEqual({
      value: 'original',
      nested: { keep: true },
    });
    expect(Object.isFrozen(history[0].snapshot)).toBe(true);
    expect(Object.isFrozen(history[0].snapshot.nodes[0].params.nested)).toBe(true);
  });
});

describe('closeRunRecord', () => {
  it('patches the matching record with terminal status + metrics', () => {
    const h = open([], 'a');
    const closed = closeRunRecord(h, 'a', { status: 'complete', durationSec: 4.2, nodesExecuted: 3 });
    expect(closed[0]).toMatchObject({
      id: 'a',
      trigger: 'graph',
      startedAt: 0,
      status: 'complete',
      durationSec: 4.2,
      nodesExecuted: 3,
    });
  });

  it('marks runs failed or cancelled', () => {
    expect(closeRunRecord(open([], 'a', 'node'), 'a', { status: 'failed' })[0].status).toBe('failed');
    expect(closeRunRecord(open([], 'b', 'cluster'), 'b', { status: 'cancelled' })[0].status).toBe('cancelled');
  });

  it('is a no-op when the id is absent and only touches a matching record', () => {
    let history = open([], 'a');
    history = open(history, 'b', 'node', 1);
    expect(closeRunRecord(history, 'missing', { status: 'complete' })).toEqual(history);

    const closed = closeRunRecord(history, 'a', { status: 'complete', durationSec: 1 });
    expect(closed.find((r) => r.id === 'b')!.status).toBe('running');
    expect(closed.find((r) => r.id === 'a')!.status).toBe('complete');
  });
});

describe('persistent run history', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('round-trips records and exact target snapshots across reloads', () => {
    let history = openRunRecord([], {
      id: 'node-run',
      trigger: 'node',
      startedAt: 123,
      targetNodeId: 'node-a',
      snapshot: makeSnapshot('persist me'),
    });
    history = closeRunRecord(history, 'node-run', {
      status: 'complete',
      durationSec: 2.4,
      nodesExecuted: 1,
    });
    persistRunHistory(history);

    const loaded = loadRunHistory();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      id: 'node-run',
      trigger: 'node',
      targetNodeId: 'node-a',
      status: 'complete',
      durationSec: 2.4,
    });
    expect(loaded[0].snapshot.nodes[0].params.value).toBe('persist me');
    expect(Object.isFrozen(loaded[0].snapshot.nodes[0].params)).toBe(true);
  });

  it('recovers an orphaned running record as cancelled and persists recovery', () => {
    persistRunHistory(open([], 'interrupted'));

    expect(loadRunHistory()[0].status).toBe('cancelled');
    expect(loadRunHistory()[0].status).toBe('cancelled');
  });

  it('drops malformed individual records while preserving valid records', () => {
    persistRunHistory(closeRunRecord(open([], 'valid'), 'valid', { status: 'complete' }));
    const payload = JSON.parse(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)!);
    payload.records.push({ id: 'invalid-without-snapshot' });
    window.localStorage.setItem(RUN_HISTORY_STORAGE_KEY, JSON.stringify(payload));

    const loaded = loadRunHistory();
    expect(loaded.map((record) => record.id)).toEqual(['valid']);
    expect(JSON.parse(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)!).records).toHaveLength(1);
  });

  it('clears irrecoverably corrupt JSON instead of throwing on app load', () => {
    window.localStorage.setItem(RUN_HISTORY_STORAGE_KEY, 'not-json');

    expect(loadRunHistory()).toEqual([]);
    expect(window.localStorage.getItem(RUN_HISTORY_STORAGE_KEY)).toBeNull();
  });

  it('freezes an independently cloned snapshot helper result', () => {
    const source = makeSnapshot('helper');
    const frozen = freezeRunSnapshot(source);
    source.nodes[0].params.value = 'changed';
    expect(frozen.nodes[0].params.value).toBe('helper');
    expect(Object.isFrozen(frozen.edges)).toBe(true);
  });
});

describe('full open→close lifecycle', () => {
  it('records complete and failed runs', () => {
    let complete = open([], 'run1', 'graph', 1000);
    complete = closeRunRecord(complete, 'run1', { status: 'complete', durationSec: 2.5, nodesExecuted: 5 });
    expect(complete[0]).toMatchObject({ status: 'complete', nodesExecuted: 5 });

    let failed = open([], 'run2');
    failed = closeRunRecord(failed, 'run2', { status: 'failed' });
    expect(failed[0].status).toBe('failed');
    expect(failed[0].durationSec).toBeUndefined();
  });
});

describe('formatRunDuration', () => {
  it('formats seconds and minutes', () => {
    expect(formatRunDuration(0.8)).toBe('0.8s');
    expect(formatRunDuration(9.4)).toBe('9.4s');
    expect(formatRunDuration(12.6)).toBe('13s');
    expect(formatRunDuration(59)).toBe('59s');
    expect(formatRunDuration(65)).toBe('1m 05s');
    expect(formatRunDuration(125)).toBe('2m 05s');
  });

  it('returns a dash for missing/invalid values', () => {
    expect(formatRunDuration(undefined)).toBe('—');
    expect(formatRunDuration(-1)).toBe('—');
    expect(formatRunDuration(NaN)).toBe('—');
  });
});

describe('formatRunAge', () => {
  it('formats relative age without going negative', () => {
    expect(formatRunAge(1000, 1000)).toBe('just now');
    expect(formatRunAge(4000, 1000)).toBe('just now');
    expect(formatRunAge(30_000, 0)).toBe('30s ago');
    expect(formatRunAge(120_000, 0)).toBe('2m ago');
    expect(formatRunAge(2 * 3600_000, 0)).toBe('2h ago');
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
