import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 5 of the Q133 confirm (Justin, 2026-10-25: a paid placeholder never
 * runs without the person's confirmation, and what runs never costs more than
 * they were shown), with GM - Design's round-6 rulings:
 * - H1: once the dialog has shown for a run it stays the authority. An agent
 *   finishing its placeholders while it is open (and making the run pricier)
 *   asks again with "Run with Codex's changes?", never the costly-run setting
 *   or the browser's confirm; the run sends the total the person saw, which
 *   Nebula holds it to with no placeholder left, and its refusal re-asks.
 * - L2 / GM item 4: a refused or declined run leaves the canvas as it was:
 *   no Run history record, nothing Queued, no Stop, nothing streaming.
 * - GM item 3: from Cinema the button says Generate; the shot has its row.
 */

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiFetchMock,
  getCachedBackendBaseUrl: () => null,
}));
const askMock = vi.hoisted(() => vi.fn());
vi.mock('../src/components/askPlaceholderRun', () => ({ askPlaceholderRun: askMock }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { usePricingStore } from '../src/store/pricingStore';
import { useUIStore } from '../src/store/uiStore';
import * as api from '../src/lib/api';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';
import { MAX_RUN_HISTORY, type RunRecord } from '../src/lib/runHistory';

type Watch = (show: (next: PlaceholderRunConfirm) => void) => () => void;

const initialCache = useUIStore.getState().settingsCache;
const initialThreshold = useUIStore.getState().runCostConfirmUsd;
const codexAgent = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const codex = { agent: codexAgent, at: 1 };
const scene = { version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9',
  shots: [{ id: 's1', prompt: 'a cat' }, { id: 's2', prompt: 'a dog' }] };

/** The person clicks Run on the words the dialog showed. */
const yes = async (model: PlaceholderRunConfirm) => model;

const imageNode = (id: string, pending = false, extra: Record<string, unknown> = {}) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId: 'nano-banana', label: id === 'a' ? 'Hero still' : id, params: {}, state: 'idle', outputs: {},
    ...(pending ? { pending: codex } : {}), ...extra } });
const cinemaNode = () => ({ id: 'cine', type: 'cinema-scene', position: { x: 0, y: 0 },
  data: { definitionId: 'cinema-scene', label: 'Scene', params: { scene }, state: 'idle', outputs: {} } });

/** Codex finishes its node while the dialog is open, switching it to `model`. */
function codexFinishes(model?: string) {
  useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((node) => node.id === 'a'
    ? { ...node, data: { ...node.data, pending: undefined, params: model ? { model } : node.data.params } } : node) as never });
}

function refusal(high: number, placeholders: string[] = ['a'], message = 'Nothing ran. This run changed since you last reviewed it. Click “Run” again to review it.') {
  return new api.ExecutionStartRejectedError(message, 409, { detail: {
    code: 'placeholder_confirm_required', message, placeholders,
    agents: Object.fromEntries(placeholders.map((id) => [id, codexAgent])),
    estimate: { low: high, high, nodes: { a: { low: high - 0.6, high: high - 0.6 }, b: { low: 0.6, high: 0.6 } },
      unpriced: [], plan: [], plus: [], unavailable: {}, awaitingInput: [] },
  } });
}

const errors = () => useGraphStore.getState().nodes.map((node) => node.data.error).filter(Boolean);
const states = () => Object.fromEntries(useGraphStore.getState().nodes.map((node) => [node.id, node.data.state]));

describe("review 5: the person's direct run once the placeholder dialog has shown", () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [imageNode('a', true), imageNode('b'), cinemaNode()] as never,
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'image', targetHandle: 'image_input' },
        { id: 'e2', source: 'a', target: 'cine', sourceHandle: 'image', targetHandle: 'character_refs' }],
      undoStack: [], redoStack: [], runHistory: [], isExecuting: false, backendFreshStartPending: false,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
    useUIStore.setState({ settingsCache: { apiKeys: { GOOGLE_API_KEY: 'set' }, loaded: true }, runCostConfirmUsd: null });
    usePricingStore.setState({ table: { currencies: {}, nodes: {
      'nano-banana': { currency: 'usd', per: 'image', priceParams: ['model'], rows: [
        { match: { model: 'pricey' }, price: 9 }, { match: { model: 'cheap' }, price: 0.1 }, { match: {}, price: 0.6 }] },
    } } } as never);
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    askMock.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    window.localStorage.clear();
  });

  afterEach(() => {
    useGraphStore.getState().resetExecution();
    useUIStore.setState({ settingsCache: initialCache, runCostConfirmUsd: initialThreshold });
    usePricingStore.setState({ table: null });
    vi.restoreAllMocks();
  });

  describe('H1: the agent finishes its placeholder and makes the run pricier while the dialog is open', () => {
    it.each([
      ['off', null],
      ['on', 0.01],
    ])('with "Ask before costly runs" %s: asks again in the dialog, never the browser, and sends the new total', async (_label, threshold) => {
      useUIStore.setState({ runCostConfirmUsd: threshold });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => { codexFinishes('pricey'); return model; })
        .mockImplementationOnce(yes);
      await useGraphStore.getState().executeNode('b');
      expect(askMock.mock.calls[0][0].runLabel).toBe('Run for $1.20');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[1][1]).toMatchObject({ changed: true });
      expect(askMock.mock.calls[1][0]).toMatchObject({
        heading: "Run with Codex's changes?", intro: 'Codex finished setting up this node.',
        runLabel: 'Run for $9.60', confirmIds: [] });
      expect(confirm).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][6]).toEqual([]);
      expect(execute.mock.calls[0][7]).toBe(9.6);
    });

    it('Cancel on that second ask runs nothing', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => { codexFinishes('pricey'); return model; })
        .mockResolvedValueOnce(null);
      await useGraphStore.getState().executeNode('b');
      expect(execute).not.toHaveBeenCalled();
    });

    it('the open dialog updates in place to the new heading and price (the watch)', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (_model: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        const stop = options?.watch?.((next) => pushed.push(next));
        codexFinishes('pricey');
        stop?.();
        return pushed[pushed.length - 1];
      });
      await useGraphStore.getState().executeNode('b');
      expect(pushed.at(-1)).toMatchObject({ heading: "Run with Codex's changes?", runLabel: 'Run for $9.60' });
      expect(askMock).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][6]).toEqual([]);
      expect(execute.mock.calls[0][7]).toBe(9.6);
    });

    // Review 7, L2 (coordinator's decision): a row counts as seen only if its
    // node, model and price all match, so a row now at another price asks
    // again, even when cheaper (this test said "goes ahead" until round 8).
    it('a run that got cheaper asks again: its row changed price', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => { codexFinishes('cheap'); return model; })
        .mockImplementationOnce(yes);
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[1][1]).toMatchObject({ changed: true });
      expect(execute.mock.calls[0][6]).toEqual([]);
      expect(execute.mock.calls[0][7]).toBe(0.7);
    });

    it('a Cinema shot asks again the same way, with the Generate button', async () => {
      const shot = vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' });
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => { codexFinishes('pricey'); return model; })
        .mockImplementationOnce(yes);
      await useGraphStore.getState().executeShot('cine', 's1');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[1][0]).toMatchObject({ heading: "Run with Codex's changes?", runLabel: 'Generate for $9.60' });
      expect(shot.mock.calls[0][7]).toEqual([]);
      expect(shot.mock.calls[0][8]).toBe(9.6);
    });

    it("Nebula's refusal with no placeholder left re-asks with its numbers and sends them", async () => {
      const execute = vi.spyOn(api, 'executeNode')
        .mockRejectedValueOnce(refusal(9.6, [])).mockResolvedValueOnce({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => { codexFinishes(); return model; })
        .mockImplementationOnce(yes);
      await useGraphStore.getState().executeNode('b');
      expect(execute.mock.calls[0][6]).toEqual([]);
      expect(execute.mock.calls[0][7]).toBe(1.2);
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[1][1]).toMatchObject({ changed: true });
      expect(askMock.mock.calls[1][0]).toMatchObject({ heading: "Run with Codex's changes?", runLabel: 'Run for $9.60', confirmIds: [] });
      expect(execute.mock.calls[1][6]).toEqual([]);
      expect(execute.mock.calls[1][7]).toBe(9.6);
      expect(errors()).toEqual([]);
    });
  });

  describe('L2 / GM item 4: a refused run leaves the canvas exactly as it was', () => {
    beforeEach(() => {
      useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((node) => node.id === 'b'
        ? { ...node, data: { ...node.data, state: 'complete', outputs: { image: { type: 'Image', value: '/api/outputs/x.png' } } } }
        : node) as never });
    });

    it('behind the re-ask nothing is queued, running or streaming, and Cancel leaves no history', async () => {
      let behind: { isExecuting: boolean; states: Record<string, unknown>; history: number; activeRuns: number } | null = null;
      askMock.mockImplementationOnce(yes).mockImplementationOnce(async () => {
        const state = useGraphStore.getState();
        behind = { isExecuting: state.isExecuting, states: states(), history: state.runHistory.length, activeRuns: state.activeRuns.length };
        return null;
      });
      vi.spyOn(api, 'executeNode').mockRejectedValueOnce(refusal(4.8));
      await useGraphStore.getState().executeNode('b');
      expect(behind).toEqual({ isExecuting: false, states: { a: 'idle', b: 'complete', cine: 'idle' }, history: 0, activeRuns: 0 });
      const after = useGraphStore.getState();
      expect(after.runHistory).toEqual([]);
      expect(states()).toEqual({ a: 'idle', b: 'complete', cine: 'idle' });
      expect(after.isExecuting).toBe(false);
      expect(errors()).toEqual([]);
    });

    it('a full Run history keeps every record it had', async () => {
      const full: RunRecord[] = Array.from({ length: MAX_RUN_HISTORY }, (_, i) => ({ id: `old-${i}`, trigger: 'node',
        status: 'complete', startedAt: i, targetNodeId: 'b', snapshot: { nodes: [], edges: [] } }));
      useGraphStore.setState({ runHistory: full });
      askMock.mockImplementationOnce(yes).mockResolvedValueOnce(null);
      vi.spyOn(api, 'executeNode').mockRejectedValueOnce(refusal(4.8));
      await useGraphStore.getState().executeNode('b');
      expect(useGraphStore.getState().runHistory.map((run) => run.id)).toEqual(full.map((run) => run.id));
    });

    it('a yes on the re-ask starts the run then, as one record', async () => {
      askMock.mockImplementation(yes);
      const execute = vi.spyOn(api, 'executeNode')
        .mockRejectedValueOnce(refusal(4.8)).mockResolvedValueOnce({ status: 'started' } as never);
      await useGraphStore.getState().executeNode('b');
      expect(execute).toHaveBeenCalledTimes(2);
      const { runHistory, isExecuting } = useGraphStore.getState();
      expect(runHistory).toHaveLength(1);
      expect(runHistory[0].status).toBe('running');
      expect(isExecuting).toBe(true);
    });

    it('a Cinema shot declined on the re-ask keeps its shot as it was', async () => {
      askMock.mockImplementationOnce(yes).mockResolvedValueOnce(null);
      vi.spyOn(api, 'generateCinemaShot').mockRejectedValueOnce(refusal(9.6));
      await useGraphStore.getState().executeShot('cine', 's1');
      const cine = useGraphStore.getState().nodes.find((node) => node.id === 'cine')!;
      const s1 = (cine.data.params as { scene: { shots: Array<{ id: string; output?: unknown }> } }).scene.shots[0];
      expect(s1.output).toBeUndefined();
      expect(useGraphStore.getState().runHistory).toEqual([]);
      expect(useGraphStore.getState().activeRuns).toEqual([]);
    });

    it('a replay declined on the re-ask adds no record', async () => {
      const record: RunRecord = { id: 'saved-node', trigger: 'node', status: 'complete', startedAt: 1, targetNodeId: 'b',
        snapshot: { nodes: [
          { id: 'a', definitionId: 'nano-banana', params: {}, outputs: {} },
          { id: 'b', definitionId: 'nano-banana', params: {}, outputs: {} },
        ], edges: [{ id: 'e1', source: 'a', sourceHandle: 'image', target: 'b', targetHandle: 'image_input' }] } };
      useGraphStore.setState({ runHistory: [record] });
      askMock.mockImplementationOnce(yes).mockResolvedValueOnce(null);
      vi.spyOn(api, 'executeNode').mockRejectedValueOnce(refusal(4.8));
      await useGraphStore.getState().rerunHistoryRecord('saved-node');
      expect(useGraphStore.getState().runHistory.map((run) => run.id)).toEqual(['saved-node']);
      expect(states()).toEqual({ a: 'idle', b: 'complete', cine: 'idle' });
    });
  });

  describe('GM item 3: from Cinema the button says Generate, and the shot has its own row', () => {
    it('Generate shot: “Shot 1” · Nano Banana, and "Generate for $X"', async () => {
      askMock.mockResolvedValue(null);
      await useGraphStore.getState().executeShot('cine', 's1', undefined, 2);
      const model = askMock.mock.calls[0][0] as PlaceholderRunConfirm;
      expect(model.heading).toBe('Run 1 node Codex is still setting up?');
      expect(model.rows.map((row) => [row.name, row.model, row.price, row.agent?.name ?? null])).toEqual([
        ['“Hero still”', 'Nano Banana 2 (3.1 Flash)', '$1.20', 'Codex'],
        ['“Shot 1”', 'Nano Banana', '$1.20', null],
      ]);
      expect(model.runLabel).toBe('Generate for $2.40');
    });

    it('Generate all says Generate too; a node\'s Run keeps Run', async () => {
      askMock.mockResolvedValue(null);
      await useGraphStore.getState().executeNode('cine', { verb: 'Generate' });
      expect((askMock.mock.calls[0][0] as PlaceholderRunConfirm).runLabel).toMatch(/^Generate for /);
      await useGraphStore.getState().executeNode('b');
      expect((askMock.mock.calls[1][0] as PlaceholderRunConfirm).runLabel).toBe('Run for $1.20');
    });
  });
});
