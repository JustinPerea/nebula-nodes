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
  WORLD_LABS_CANCELLATION_NOTE,
  WORLD_LABS_FAILURE_NOTE,
  WORLD_LABS_RECOVERY_READY_NOTE,
  WORLD_LABS_RECONNECTING_NOTE,
  applyProviderRecoveriesToHistory,
  isWorldLabsRecoveryReplayBlocked,
  isWorldLabsRecoveryReplayReady,
  runIncludesFreshPaidWorldLabsStart,
  runIncludesWorldLabs,
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

  it('attaches the truthful provider caveat only to cancelled World Labs snapshots', () => {
    const worldSnapshot: RunGraphSnapshot = {
      nodes: [{
        id: 'world',
        definitionId: 'worldlabs-environment',
        params: {},
        outputs: {},
      }],
      edges: [],
    };
    const worldRun = openRunRecord([], {
      id: 'world-run',
      trigger: 'graph',
      startedAt: 0,
      snapshot: worldSnapshot,
    });

    expect(closeRunRecord(worldRun, 'world-run', { status: 'cancelled' })[0].statusNote)
      .toBe(WORLD_LABS_CANCELLATION_NOTE);
    expect(closeRunRecord(open([], 'ordinary'), 'ordinary', { status: 'cancelled' })[0].statusNote)
      .toBeUndefined();
  });

  it('blocks any uncheckpointed World Labs replay, including an older completed run', () => {
    const snapshot: RunGraphSnapshot = {
      nodes: [
        { id: 'world', definitionId: 'worldlabs-environment', params: {}, outputs: {} },
        { id: 'target', definitionId: 'preview', params: {}, outputs: {} },
        { id: 'unrelated-world', definitionId: 'worldlabs-world-export', params: {}, outputs: {} },
      ],
      edges: [{
        id: 'world-target',
        source: 'world',
        sourceHandle: 'world',
        target: 'target',
        targetHandle: 'input',
      }],
    };
    expect(runIncludesWorldLabs(snapshot, 'target')).toBe(true);
    expect(runIncludesWorldLabs(snapshot, 'world')).toBe(true);

    const failed: RunRecord = {
      id: 'failed-world', trigger: 'node', startedAt: 0, status: 'failed',
      targetNodeId: 'target', snapshot,
    };
    const cancelled = { ...failed, id: 'cancelled-world', status: 'cancelled' as const };
    const complete = { ...failed, id: 'complete-world', status: 'complete' as const };
    expect(isWorldLabsRecoveryReplayBlocked(failed)).toBe(true);
    expect(isWorldLabsRecoveryReplayBlocked(cancelled)).toBe(true);
    expect(isWorldLabsRecoveryReplayBlocked(complete)).toBe(true);
    expect(isWorldLabsRecoveryReplayReady(complete)).toBe(false);

    const unrelatedTarget = { ...failed, targetNodeId: 'target-without-world' };
    expect(isWorldLabsRecoveryReplayBlocked(unrelatedTarget)).toBe(false);
  });

  it('hydrates the exact run/node checkpoint and makes its saved recovery replay-safe', () => {
    const source: RunRecord = {
      id: 'paid-run',
      trigger: 'node',
      startedAt: 0,
      status: 'cancelled',
      targetNodeId: 'world',
      statusNote: WORLD_LABS_CANCELLATION_NOTE,
      snapshot: {
        nodes: [
          {
            id: 'world',
            definitionId: 'worldlabs-environment',
            params: { resume_operation_id: 'stale-operation', model: 'marble-1.1' },
            outputs: {},
          },
          { id: 'other', definitionId: 'text-input', params: { value: 'keep' }, outputs: {} },
        ],
        edges: [],
      },
    };

    const [hydrated] = applyProviderRecoveriesToHistory([source], [{
      runId: 'paid-run',
      nodeId: 'world',
      resumeOperationId: null,
      existingWorldId: 'world-complete',
    }]);

    expect(hydrated.snapshot.nodes[0].params).toEqual({
      model: 'marble-1.1',
      existing_world_id: 'world-complete',
    });
    expect(hydrated.snapshot.nodes[1]).toEqual(source.snapshot.nodes[1]);
    expect(hydrated.statusNote).toBe(WORLD_LABS_RECOVERY_READY_NOTE);
    expect(isWorldLabsRecoveryReplayBlocked(hydrated)).toBe(false);
    expect(isWorldLabsRecoveryReplayReady(hydrated)).toBe(true);
    expect(source.snapshot.nodes[0].params).toEqual({
      resume_operation_id: 'stale-operation',
      model: 'marble-1.1',
    });
  });

  it('does not mark a mixed World Labs scope ready until every paid node is checkpointed', () => {
    const source: RunRecord = {
      id: 'mixed-run',
      trigger: 'graph',
      startedAt: 0,
      status: 'failed',
      snapshot: {
        nodes: [
          { id: 'environment', definitionId: 'worldlabs-environment', params: {}, outputs: {} },
          {
            id: 'export',
            definitionId: 'worldlabs-world-export',
            params: { format: 'glb' },
            outputs: {},
          },
        ],
        edges: [],
      },
    };
    const [partial] = applyProviderRecoveriesToHistory([source], [{
      runId: 'mixed-run',
      nodeId: 'environment',
      resumeOperationId: 'operation-1',
      existingWorldId: null,
    }]);
    expect(isWorldLabsRecoveryReplayBlocked(partial)).toBe(true);
    expect(isWorldLabsRecoveryReplayReady(partial)).toBe(false);

    const [ready] = applyProviderRecoveriesToHistory([partial], [{
      runId: 'mixed-run',
      nodeId: 'export',
      resumeOperationId: 'export-1',
      existingWorldId: null,
    }]);
    expect(isWorldLabsRecoveryReplayBlocked(ready)).toBe(false);
    expect(isWorldLabsRecoveryReplayReady(ready)).toBe(true);
  });

  it('adds recovery guidance to failed World Labs records', () => {
    const world = openRunRecord([], {
      id: 'world-failed',
      trigger: 'graph',
      startedAt: 0,
      snapshot: {
        nodes: [{
          id: 'world',
          definitionId: 'worldlabs-world-export',
          params: { format: 'glb' },
          outputs: {},
        }],
        edges: [],
      },
    });
    expect(closeRunRecord(world, 'world-failed', { status: 'failed' })[0].statusNote)
      .toBe(WORLD_LABS_FAILURE_NOTE);
  });

  it('allows a PLY-only run to replay without pretending it has paid recovery', () => {
    const plyOnly: RunRecord = {
      id: 'ply-only',
      trigger: 'node',
      startedAt: 0,
      status: 'failed',
      targetNodeId: 'export',
      snapshot: {
        nodes: [{
          id: 'export',
          definitionId: 'worldlabs-world-export',
          params: { format: 'ply' },
          outputs: {},
        }],
        edges: [],
      },
    };

    expect(isWorldLabsRecoveryReplayBlocked(plyOnly)).toBe(false);
    expect(isWorldLabsRecoveryReplayReady(plyOnly)).toBe(false);
    expect(closeRunRecord([plyOnly], plyOnly.id, { status: 'failed' })[0].statusNote)
      .toBeUndefined();
  });

  it('allows recovered environment plus PLY replay through the exact checkpoint', () => {
    const recoveredWithPly: RunRecord = {
      id: 'recovered-with-ply',
      trigger: 'graph',
      startedAt: 0,
      status: 'cancelled',
      snapshot: {
        nodes: [
          {
            id: 'environment',
            definitionId: 'worldlabs-environment',
            params: { existing_world_id: 'world-accepted' },
            outputs: {},
          },
          {
            id: 'export',
            definitionId: 'worldlabs-world-export',
            params: { format: 'ply' },
            outputs: {},
          },
        ],
        edges: [{
          id: 'world-to-export',
          source: 'environment',
          sourceHandle: 'world',
          target: 'export',
          targetHandle: 'world',
        }],
      },
    };

    expect(isWorldLabsRecoveryReplayBlocked(recoveredWithPly)).toBe(false);
    expect(isWorldLabsRecoveryReplayReady(recoveredWithPly)).toBe(true);
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

describe('fresh paid World Labs scope', () => {
  it('matches the backend billing boundary for generation and exports', () => {
    const snapshot = (definitionId: string, params: Record<string, unknown>): RunGraphSnapshot => ({
      nodes: [{ id: 'world', definitionId, params, outputs: {} }],
      edges: [],
    });

    expect(runIncludesFreshPaidWorldLabsStart(
      snapshot('worldlabs-environment', {}),
    )).toBe(true);
    expect(runIncludesFreshPaidWorldLabsStart(
      snapshot('worldlabs-environment', { resume_operation_id: 'operation-1' }),
    )).toBe(false);
    expect(runIncludesFreshPaidWorldLabsStart(
      snapshot('worldlabs-environment', { existing_world_id: 'world-1' }),
    )).toBe(false);
    expect(runIncludesFreshPaidWorldLabsStart(
      snapshot('worldlabs-world-export', { format: 'glb' }),
    )).toBe(true);
    expect(runIncludesFreshPaidWorldLabsStart(
      snapshot('worldlabs-world-export', {
        format: 'glb',
        resume_operation_id: 'export-1',
      }),
    )).toBe(false);
    expect(runIncludesFreshPaidWorldLabsStart(
      snapshot('worldlabs-world-export', { format: 'ply' }),
    )).toBe(false);
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

  it('preserves a running World Labs record for backend status reconciliation', () => {
    const world = openRunRecord([], {
      id: 'world-in-flight',
      trigger: 'node',
      startedAt: 1,
      targetNodeId: 'world',
      snapshot: {
        nodes: [{
          id: 'world',
          definitionId: 'worldlabs-environment',
          params: {},
          outputs: {},
        }],
        edges: [],
      },
    });
    persistRunHistory(world);

    const [loaded] = loadRunHistory();
    expect(loaded.status).toBe('running');
    expect(loaded.statusNote).toBe(WORLD_LABS_RECONNECTING_NOTE);
  });

  it('only preserves running World Labs records that could have started new paid work', () => {
    const safeWorldRuns: RunRecord[] = [
      {
        id: 'ply-export',
        trigger: 'node',
        startedAt: 1,
        status: 'running',
        startedFreshPaidWorldLabs: false,
        targetNodeId: 'export',
        snapshot: {
          nodes: [{
            id: 'export',
            definitionId: 'worldlabs-world-export',
            params: { format: 'ply' },
            outputs: {},
          }],
          edges: [],
        },
      },
      {
        id: 'pinned-world',
        trigger: 'node',
        startedAt: 2,
        status: 'running',
        startedFreshPaidWorldLabs: false,
        targetNodeId: 'world',
        snapshot: {
          nodes: [{
            id: 'world',
            definitionId: 'worldlabs-environment',
            params: { existing_world_id: 'world-already-accepted' },
            outputs: {},
          }],
          edges: [],
        },
      },
    ];
    persistRunHistory(safeWorldRuns);

    const loaded = loadRunHistory();
    expect(loaded.map((record) => record.status)).toEqual(['cancelled', 'cancelled']);
    expect(loaded.every((record) => (
      !runIncludesFreshPaidWorldLabsStart(record.snapshot, record.targetNodeId)
    ))).toBe(true);
  });

  it('preserves fresh-paid origin after a recovery checkpoint rewrites the snapshot', () => {
    const fresh = openRunRecord([], {
      id: 'fresh-then-checkpointed',
      trigger: 'node',
      startedAt: 1,
      targetNodeId: 'world',
      startedFreshPaidWorldLabs: true,
      snapshot: {
        nodes: [{
          id: 'world',
          definitionId: 'worldlabs-environment',
          params: {},
          outputs: {},
        }],
        edges: [],
      },
    });
    const checkpointed = applyProviderRecoveriesToHistory(fresh, [{
      runId: 'fresh-then-checkpointed',
      nodeId: 'world',
      resumeOperationId: 'operation-accepted',
      existingWorldId: null,
      durable: true,
    }]);
    expect(runIncludesFreshPaidWorldLabsStart(
      checkpointed[0].snapshot,
      checkpointed[0].targetNodeId,
    )).toBe(false);
    persistRunHistory(checkpointed);

    const [loaded] = loadRunHistory();
    expect(loaded).toMatchObject({
      id: 'fresh-then-checkpointed',
      status: 'running',
      startedFreshPaidWorldLabs: true,
      statusNote: WORLD_LABS_RECONNECTING_NOTE,
    });
    expect(loaded.snapshot.nodes[0].params).toEqual({
      resume_operation_id: 'operation-accepted',
    });
  });

  it('fails closed for a legacy running World Labs record with unknown origin', () => {
    const legacy: RunRecord = {
      id: 'legacy-checkpointed',
      trigger: 'node',
      startedAt: 1,
      status: 'running',
      targetNodeId: 'world',
      snapshot: {
        nodes: [{
          id: 'world',
          definitionId: 'worldlabs-environment',
          params: { existing_world_id: 'world-accepted-before-upgrade' },
          outputs: {},
        }],
        edges: [],
      },
    };
    persistRunHistory([legacy]);

    const [loaded] = loadRunHistory();
    expect(loaded).toMatchObject({
      id: 'legacy-checkpointed',
      status: 'running',
      statusNote: WORLD_LABS_RECONNECTING_NOTE,
    });
    expect(loaded.startedFreshPaidWorldLabs).toBeUndefined();
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
