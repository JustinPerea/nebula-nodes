import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
import * as api from '../src/lib/api';
import { useGraphStore } from '../src/store/graphStore';
import { RUN_HISTORY_STORAGE_KEY, loadRunHistory, openRunRecord, type RunGraphSnapshot, type RunRecord,
} from '../src/lib/runHistory';
import {
  GRAPH_PARAMS_VERSION,
  KREA2_BOARD_STRENGTHS_CHANGED,
  KREA2_BOARD_STRENGTHS_REPLAY_NOTE,
  RUN_BEHAVIOUR_VERSION,
  runReplayNotes,
} from '../src/lib/savedParamsUpgrades';

/**
 * Q21 b (Justin, 2026-10-20; moodboard canvas PR13a): Krea 2's board
 * references now share out the board's strength. No saved param changes
 * meaning, so there is no params version bump; a replay of a record made
 * before the change says once that its image can differ (plan 4.8 item 7).
 * "Before" is the record's behaviour stamp, not its date: a record made on a
 * build without the change has no stamp, whenever the change merges.
 */

const BEFORE = 0;
const AFTER = RUN_BEHAVIOUR_VERSION;

function recipe(board: 'nebula-moodboard' | 'krea-moodboard' | null = 'nebula-moodboard',
  via: Array<'reroute' | 'router'> = []): RunGraphSnapshot {
  // board -> via[0] -> via[1] ... -> krea.moodboard
  const hops = via.map((kind, i) => ({ id: `hop${i}`, kind }));
  const chain = [{ id: 'board', out: 'moodboard' }, ...hops.map((hop) => ({ id: hop.id, out: hop.kind === 'router' ? 'out2' : 'output' }))];
  return {
    nodes: [
      { id: 'text', definitionId: 'text-input', params: { value: 'A lighthouse' }, outputs: {} },
      ...(board ? [{ id: 'board', definitionId: board, params: { moodboard: 'b1' }, outputs: {} }] : []),
      ...hops.map((hop) => ({ id: hop.id, definitionId: hop.kind, params: {}, outputs: {} })),
      { id: 'krea', definitionId: 'krea-2-generate', params: {}, outputs: {} },
    ],
    edges: [
      { id: 'p', source: 'text', sourceHandle: 'text', target: 'krea', targetHandle: 'prompt' },
      ...(board ? chain.map((from, i) => ({ id: `m${i}`, source: from.id, sourceHandle: from.out,
        target: chain[i + 1]?.id ?? 'krea', targetHandle: chain[i + 1] ? 'input' : 'moodboard' })) : []),
    ],
  };
}

describe('runReplayNotes', () => {
  it('names the change date in the line', () => {
    expect(KREA2_BOARD_STRENGTHS_REPLAY_NOTE).toBe(
      `Krea 2 board strengths now add up to the board's strength (changed ${KREA2_BOARD_STRENGTHS_CHANGED}), `
      + 'so this replay can differ from the original.');
    expect(KREA2_BOARD_STRENGTHS_CHANGED).toBe('2026-10-20');
  });

  it('gives the line to a Krea 2 node fed by a Nebula board, on a record from before the change', () => {
    expect(runReplayNotes(recipe(), BEFORE)).toEqual({ krea: [KREA2_BOARD_STRENGTHS_REPLAY_NOTE] });
  });

  it('says nothing for a record made after the change, a Krea 2 without a board, or a Krea moodboard id', () => {
    expect(runReplayNotes(recipe(), AFTER)).toEqual({});
    expect(runReplayNotes(recipe(null), BEFORE)).toEqual({});
    expect(runReplayNotes(recipe('krea-moodboard'), BEFORE)).toEqual({});
  });

  it('follows a board through reroute and router nodes, which hand it on unchanged', () => {
    expect(runReplayNotes(recipe('nebula-moodboard', ['reroute']), BEFORE)).toEqual({ krea: [KREA2_BOARD_STRENGTHS_REPLAY_NOTE] });
    expect(runReplayNotes(recipe('nebula-moodboard', ['router', 'reroute']), BEFORE))
      .toEqual({ krea: [KREA2_BOARD_STRENGTHS_REPLAY_NOTE] });
    expect(runReplayNotes(recipe('krea-moodboard', ['reroute']), BEFORE)).toEqual({});
    expect(runReplayNotes(recipe('nebula-moodboard', ['reroute']), AFTER)).toEqual({});
  });

  it('stops at a reroute loop', () => {
    const looped = recipe(null);
    looped.nodes.push({ id: 'a', definitionId: 'reroute', params: {}, outputs: {} },
      { id: 'b', definitionId: 'reroute', params: {}, outputs: {} });
    looped.edges.push({ id: 'ab', source: 'a', sourceHandle: 'output', target: 'b', targetHandle: 'input' },
      { id: 'ba', source: 'b', sourceHandle: 'output', target: 'a', targetHandle: 'input' },
      { id: 'bk', source: 'b', sourceHandle: 'output', target: 'krea', targetHandle: 'moodboard' });
    expect(runReplayNotes(looped, BEFORE)).toEqual({});
  });

  it('stamps every new record, and reads a record without a stamp as before the change', () => {
    const [opened] = openRunRecord([], { id: 'new', trigger: 'graph', startedAt: Date.UTC(2026, 9, 19), snapshot: recipe() });
    expect(opened.behaviourVersion).toBe(RUN_BEHAVIOUR_VERSION);
    const storage = new Map<string, string>();
    const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); } };
    const old = { id: 'old', trigger: 'graph', startedAt: Date.UTC(2026, 10, 30), status: 'complete', snapshot: recipe() };
    const bad = { ...old, id: 'bad', behaviourVersion: -1 };
    store.setItem(RUN_HISTORY_STORAGE_KEY, JSON.stringify({ version: 1, records: [{ ...opened, status: 'complete' }, old, bad] }));
    const loaded = loadRunHistory(store);
    expect(loaded.map((record) => record.behaviourVersion)).toEqual([RUN_BEHAVIOUR_VERSION, undefined, undefined]);
  });

  it('is not a params upgrade', () => {
    expect(GRAPH_PARAMS_VERSION).toBe(1);
  });
});

describe('replaying an old Krea 2 board recipe', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isCancelling: false,
      providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null, providerRecoveryWarning: null });
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'running' });
  });

  afterEach(() => {
    useGraphStore.getState().resetExecution();
    vi.restoreAllMocks();
  });

  async function replay(behaviourVersion: number | undefined): Promise<string[] | undefined> {
    // The date doesn't decide it: an unstamped record from after the planned
    // date still gets the line, a stamped one from before it doesn't.
    const startedAt = behaviourVersion === undefined ? Date.UTC(2026, 10, 30) : Date.UTC(2026, 9, 1);
    const source: RunRecord = { id: 'old', trigger: 'graph', startedAt, status: 'complete', snapshot: recipe('nebula-moodboard', ['reroute']),
      paramsVersion: GRAPH_PARAMS_VERSION, ...(behaviourVersion === undefined ? {} : { behaviourVersion }) };
    useGraphStore.setState({
      runHistory: [source],
      nodes: [{ id: 'krea', type: 'modelNode', position: { x: 0, y: 0 }, data: {
        label: 'Krea 2', definitionId: 'krea-2-generate', params: {}, state: 'idle', outputs: {},
      } }],
    });
    await useGraphStore.getState().rerunHistoryRecord('old');
    const [replayed] = useGraphStore.getState().runHistory;
    expect(replayed.sourceRunId).toBe('old');
    useGraphStore.getState().handleExecutionEvent({ type: 'executed', runId: replayed.id, nodeId: 'krea', outputs: {},
      notes: ["Board 'Dusk' sent 2 images; their strengths add up to the board's 0.70 (#1 0.47, #2 0.23)."] });
    return useGraphStore.getState().nodes.find((node) => node.id === 'krea')!.data.runNotes;
  }

  it('adds the one-time line after the run notes on a record from before the change', async () => {
    expect(await replay(undefined)).toEqual([
      "Board 'Dusk' sent 2 images; their strengths add up to the board's 0.70 (#1 0.47, #2 0.23).",
      KREA2_BOARD_STRENGTHS_REPLAY_NOTE,
    ]);
  });

  it('adds nothing on a record made after it', async () => {
    expect(await replay(AFTER)).toEqual([
      "Board 'Dusk' sent 2 images; their strengths add up to the board's 0.70 (#1 0.47, #2 0.23).",
    ]);
  });
});
