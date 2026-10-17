import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import * as api from '../src/lib/api';
import { useGraphStore } from '../src/store/graphStore';
import {
  RUN_HISTORY_STORAGE_KEY,
  loadRunHistory,
  openRunRecord,
  paperRecipeRevision,
  paperRunOutOfDateReasons,
  runParamsVersion,
  type RunGraphSnapshot,
  type RunHistoryStorage,
  type RunRecord,
} from '../src/lib/runHistory';
import { resultContextForNode } from '../src/lib/resultContext';
import { GRAPH_PARAMS_VERSION, upgradeRunSnapshot } from '../src/lib/savedParamsUpgrades';
import type { PaperSourceRecord } from '../src/lib/paperSource';

/**
 * Justin, 2026-10-17: a run record keeps what its run sent, and a recipe
 * saved before a params upgrade is upgraded when it is used again (replays,
 * Create's "Reuse settings", Paper freshness). The record carries the version
 * it was sent at; a record without one predates the stamp (version 0).
 */

const OLD = { model: 'claude-opus-4-6', extended_thinking: true, thinkingBudget: 2048, max_tokens: 4096, prompt: 'Hi' };
const UPGRADED = { ...OLD, max_tokens: 64000 };

function paperSource(hash = 'A'): PaperSourceRecord {
  const identity = {
    fileId: 'file', pageId: 'page', objectId: 'logo', fileName: 'Brand', pageName: 'Logos',
    objectName: 'Editable logo', openUrl: 'https://app.paper.design/file', navigation: 'file' as const,
  };
  const exportSettings = { format: 'png' as const, scale: '2x' as const, bounds: 'object' as const, background: 'artwork' as const };
  const snapshot = {
    id: `snapshot-${hash}`, hash, capturedAt: '2026-10-01T12:00:00Z',
    width: 400, height: 200, hasAlpha: true, hasTransparency: true,
    filePath: `/api/outputs/paper/${hash}.png`, previewUrl: `/api/outputs/paper/${hash}.png`,
    identity, exportSettings,
  };
  return { id: 'source', identity, exportSettings, snapshot, snapshots: [snapshot], state: 'current', sequence: 1 };
}

function recipe(params: Record<string, unknown> = OLD, withPaper = false): RunGraphSnapshot {
  return {
    nodes: [
      ...(withPaper ? [{ id: 'paper', definitionId: 'paper-source', params: { _paperSource: paperSource() }, outputs: {} }] : []),
      { id: 'chat', definitionId: 'claude-chat', params: { ...params }, outputs: {} },
    ],
    edges: withPaper ? [{ id: 'paper-chat', source: 'paper', sourceHandle: 'image', target: 'chat', targetHandle: 'images' }] : [],
  };
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return { id: 'source-run', trigger: 'graph', startedAt: 1, status: 'complete', snapshot: recipe(), ...overrides };
}

function memoryStorage(initial: Record<string, string> = {}): RunHistoryStorage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
  };
}

function chatParams(nodes: Array<{ id: string; params: Record<string, unknown> }>) {
  return nodes.find((node) => node.id === 'chat')!.params;
}

describe('upgradeRunSnapshot', () => {
  it('upgrades a copy of a version-0 recipe and never mutates the stored one', () => {
    const stored = Object.freeze(recipe());
    const before = JSON.stringify(stored);
    const upgraded = upgradeRunSnapshot(stored, 0);
    expect(chatParams(upgraded.nodes)).toEqual(UPGRADED);
    expect(JSON.stringify(stored)).toBe(before);
  });

  it('returns the same object when nothing changes', () => {
    const current = recipe();
    expect(upgradeRunSnapshot(current, GRAPH_PARAMS_VERSION)).toBe(current);
    const other = recipe({ ...OLD, max_tokens: 8192 });
    expect(upgradeRunSnapshot(other, 0)).toBe(other);
  });
});

describe('run record stamp', () => {
  it('stamps new records current without changing the recipe hash', () => {
    const snapshot = recipe(OLD, true);
    const [opened] = openRunRecord([], { id: 'new', trigger: 'graph', startedAt: 1, snapshot });
    expect(opened.paramsVersion).toBe(GRAPH_PARAMS_VERSION);
    expect(opened.recipeRevision).toBe(paperRecipeRevision(snapshot));
    expect(chatParams(opened.snapshot.nodes)).toEqual(OLD);
  });

  it('keeps a stamp across a reload and reads a missing or malformed one as 0', () => {
    const storage = memoryStorage({ [RUN_HISTORY_STORAGE_KEY]: JSON.stringify({ version: 1, records: [
      record({ id: 'stamped', paramsVersion: 1 }),
      record({ id: 'unstamped' }),
      record({ id: 'text', paramsVersion: '1' as unknown as number }),
      record({ id: 'negative', paramsVersion: -1 }),
      record({ id: 'fraction', paramsVersion: 0.5 }),
    ] }) });
    const loaded = loadRunHistory(storage);
    expect(loaded.map((entry) => [entry.id, runParamsVersion(entry)])).toEqual([
      ['stamped', 1], ['unstamped', 0], ['text', 0], ['negative', 0], ['fraction', 0],
    ]);
    expect(loaded[0].paramsVersion).toBe(1);
    expect('paramsVersion' in loaded[2]).toBe(false);
  });
});

describe('Paper freshness', () => {
  const canvas = (params: Record<string, unknown>) => recipe(params, true);

  it('treats a version-0 4,096 as equal to the canvas upgraded to 64,000', () => {
    const saved = record({ snapshot: recipe(OLD, true) });
    expect(paperRunOutOfDateReasons(saved, canvas(UPGRADED))).toEqual([]);
  });

  it('still flags a real edit and a stamped 4,096', () => {
    const saved = record({ snapshot: recipe(OLD, true) });
    expect(paperRunOutOfDateReasons(saved, canvas({ ...UPGRADED, prompt: 'Edited' })))
      .toEqual(['Recipe settings or connections changed after this run was saved.']);
    expect(paperRunOutOfDateReasons(saved, canvas(OLD)))
      .toEqual(['Recipe settings or connections changed after this run was saved.']);
    const stamped = record({ snapshot: recipe(OLD, true), paramsVersion: 1 });
    expect(paperRunOutOfDateReasons(stamped, canvas(UPGRADED)))
      .toEqual(['Recipe settings or connections changed after this run was saved.']);
  });
});

describe('Create "Reuse settings"', () => {
  function result(paramsVersion?: number) {
    const output = { text: { type: 'Text' as const, value: 'Hello' } };
    const node: Node<NodeData> = { id: 'chat', position: { x: 0, y: 0 }, data: {
      label: 'Claude', definitionId: 'claude-chat', params: { ...UPGRADED, max_tokens: 1234 }, state: 'complete', outputs: output,
    } };
    const run = record({ resultOutputs: { chat: output }, ...(paramsVersion === undefined ? {} : { paramsVersion }) });
    return resultContextForNode(node, [run]);
  }

  it('starts a draft from a version-0 recipe upgraded, and shows what was sent', () => {
    const context = result();
    expect(context.params.max_tokens).toBe(4096);
    expect(context.reusableDraft?.params.max_tokens).toBe(64000);
  });

  it('keeps a stamped 4,096', () => {
    const context = result(1);
    expect(context.reusableDraft?.params.max_tokens).toBe(4096);
  });
});

describe('replays', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    window.localStorage.removeItem(RUN_HISTORY_STORAGE_KEY);
    useGraphStore.setState({ nodes: [], edges: [], runHistory: [], isExecuting: false, isCancelling: false,
      providerRecoveries: [], providerStartAmbiguities: [], uncertainWorldLabsRunId: null, providerRecoveryWarning: null });
    vi.spyOn(api, 'executeGraph').mockResolvedValue({ status: 'started' });
    vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' });
    vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' } as never);
    vi.spyOn(api, 'getExecutionStatus').mockResolvedValue({ runId: '', status: 'running' });
    vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    useGraphStore.getState().resetExecution();
    vi.restoreAllMocks();
  });

  const origin = { genId: 'gen', sessionId: 'session', prompt: 'Hi', ts: 1, modelNodeIds: ['chat'], allNodeIds: ['chat'] };
  const cases: Array<{
    name: string;
    source: Partial<RunRecord>;
    replay: (id: string) => Promise<void>;
    sent: () => Array<{ id: string; params: Record<string, unknown> }>;
  }> = [
    { name: 'rerun', source: {}, replay: (id) => useGraphStore.getState().rerunHistoryRecord(id),
      sent: () => vi.mocked(api.executeGraph).mock.calls[0][0] },
    { name: 'retry', source: { status: 'failed' }, replay: (id) => useGraphStore.getState().retryFailedRun(id),
      sent: () => vi.mocked(api.executeGraph).mock.calls[0][0] },
    { name: 'node rerun', source: { trigger: 'node', targetNodeId: 'chat' },
      replay: (id) => useGraphStore.getState().rerunHistoryRecord(id),
      sent: () => vi.mocked(api.executeNode).mock.calls[0][0] },
    { name: 'latest Paper source', source: { snapshot: recipe(OLD, true) },
      replay: (id) => useGraphStore.getState().rerunHistoryWithLatestPaperSource(id),
      sent: () => vi.mocked(api.executeGraph).mock.calls[0][0] },
    { name: 'cluster', source: { trigger: 'cluster' }, replay: (id) => useGraphStore.getState().rerunHistoryRecord(id),
      sent: () => vi.mocked(api.executeGraph).mock.calls[0][0] },
    { name: 'Create', source: { trigger: 'cluster', createOrigin: origin },
      replay: (id) => useGraphStore.getState().rerunHistoryRecord(id),
      sent: () => vi.mocked(api.executeGraph).mock.calls[0][0] },
    { name: 'cinema shot', source: { trigger: 'shot', cinemaShot: { nodeId: 'chat', shotId: 'shot-1' } },
      replay: (id) => useGraphStore.getState().rerunHistoryRecord(id),
      sent: () => vi.mocked(api.generateCinemaShot).mock.calls[0][0] },
  ];

  function seed(source: RunRecord) {
    // The live Paper node is current for the latest-source replay; the canvas
    // never feeds a saved recipe otherwise.
    const paper = paperSource('B');
    useGraphStore.setState({
      runHistory: [source],
      nodes: [{ id: 'paper', type: 'paperSourceNode', position: { x: 0, y: 0 }, data: {
        label: 'Paper', definitionId: 'paper-source', params: { _paperSource: paper }, state: 'complete', outputs: {},
      } }],
    });
  }

  it.each(cases)('$name sends a version-0 recipe upgraded and keeps the source record as sent', async ({ source, replay, sent }) => {
    const stored = record(source);
    const before = JSON.parse(JSON.stringify(stored));
    seed(stored);
    await replay(stored.id);

    expect(chatParams(sent())).toEqual(UPGRADED);
    const [replayed, original] = useGraphStore.getState().runHistory;
    expect(replayed.sourceRunId).toBe(stored.id);
    expect(replayed.paramsVersion).toBe(GRAPH_PARAMS_VERSION);
    expect(chatParams(replayed.snapshot.nodes)).toEqual(UPGRADED);
    expect(original).toBe(stored);
    expect(JSON.parse(JSON.stringify(original))).toEqual(before);
  });

  it.each(cases)('$name sends a stamped 4,096 as set', async ({ source, replay, sent }) => {
    const stored = record({ ...source, paramsVersion: 1 });
    seed(stored);
    await replay(stored.id);
    expect(chatParams(sent())).toEqual(OLD);
  });
});
