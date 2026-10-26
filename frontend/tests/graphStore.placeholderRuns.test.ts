import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Q133 (Justin, 2026-10-25, option b) on every way the canvas runs the
 * person's direct run (review 3, findings 1 and 7): a Cinema shot (the panel's
 * Generate) and a replay of a node run or a shot from Run history make the
 * placeholders feeding them run, so a paid one asks first in GM's dialog and
 * the run carries what the person confirmed. A shot is priced as the one shot
 * it generates, times its variations, as the backend checks it.
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
import type { RunRecord } from '../src/lib/runHistory';

const initialCache = useUIStore.getState().settingsCache;
const initialThreshold = useUIStore.getState().runCostConfirmUsd;
const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };
const scene = { version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9',
  shots: [{ id: 's1', prompt: 'a cat' }, { id: 's2', prompt: 'a dog' }] };

const imageNode = (id: string, pending = false) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId: 'nano-banana', label: id === 'a' ? 'Hero still' : id, params: {}, state: 'idle', outputs: {},
    ...(pending ? { pending: codex } : {}) } });
const cinemaNode = () => ({ id: 'cine', type: 'cinema-scene', position: { x: 0, y: 0 },
  data: { definitionId: 'cinema-scene', label: 'Scene', params: { scene }, state: 'idle', outputs: {} } });
const toCine = { id: 'e1', source: 'a', target: 'cine', sourceHandle: 'image', targetHandle: 'character_refs' };

function shotStatus(): string | undefined {
  const cine = useGraphStore.getState().nodes.find((node) => node.id === 'cine')!;
  return (cine.data.params as { scene: { shots: Array<{ id: string; output?: { status?: string } }> } })
    .scene.shots.find((shot) => shot.id === 's1')?.output?.status;
}

describe('the person\'s direct runs over a paid placeholder', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [imageNode('a', true), imageNode('b'), cinemaNode()] as never,
      edges: [toCine, { id: 'e2', source: 'a', target: 'b', sourceHandle: 'image', targetHandle: 'image_input' }],
      undoStack: [], redoStack: [], runHistory: [], isExecuting: false, backendFreshStartPending: false,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
    useUIStore.setState({ settingsCache: { apiKeys: { GOOGLE_API_KEY: 'set' }, loaded: true }, runCostConfirmUsd: null });
    usePricingStore.setState({ table: { currencies: {}, nodes: {
      'nano-banana': { currency: 'usd', per: 'image', rows: [{ match: {}, price: 0.6 }] },
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

  describe('a Cinema shot (finding 1)', () => {
    it('asks first, and Cancel generates nothing and leaves the shot as it was', async () => {
      askMock.mockResolvedValue(false);
      const shot = vi.spyOn(api, 'generateCinemaShot');
      await useGraphStore.getState().executeShot('cine', 's1', undefined, 2);
      expect(askMock).toHaveBeenCalledOnce();
      expect(askMock.mock.calls[0][0]).toMatchObject({
        heading: 'Run 1 node Codex is still setting up?', confirmIds: ['a'],
        // One shot of the base model plus the placeholder, twice (two variations).
        totalLine: 'This run could cost up to $2.40 at list prices.', runLabel: 'Run for $2.40',
      });
      expect(shot).not.toHaveBeenCalled();
      expect(shotStatus()).toBeUndefined();
    });

    it('a confirmed shot sends the placeholders and the total it confirmed', async () => {
      askMock.mockResolvedValue(true);
      const shot = vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' });
      await useGraphStore.getState().executeShot('cine', 's1', undefined, 2);
      expect(shot).toHaveBeenCalledOnce();
      expect(shot.mock.calls[0][7]).toEqual(['a']);
      expect(shot.mock.calls[0][8]).toBeCloseTo(2.4);
    });

    it('asks the costly-run question for a shot like any other run', async () => {
      useGraphStore.setState({ nodes: [imageNode('a'), imageNode('b'), cinemaNode()] as never });
      useUIStore.setState({ runCostConfirmUsd: 1 });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const shot = vi.spyOn(api, 'generateCinemaShot');
      await useGraphStore.getState().executeShot('cine', 's1', undefined, 2);
      expect(askMock).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledOnce();
      expect(confirm.mock.calls[0][0]).toContain('could cost up to $2.40');
      expect(shot).not.toHaveBeenCalled();
    });
  });

  describe('a replay from Run history (finding 7)', () => {
    const snapshotNodes = [
      { id: 'a', definitionId: 'nano-banana', params: {}, outputs: {} },
      { id: 'b', definitionId: 'nano-banana', params: {}, outputs: {} },
      { id: 'cine', definitionId: 'cinema-scene', params: { scene }, outputs: {} },
    ];
    const snapshotEdges = [
      { id: 'e2', source: 'a', sourceHandle: 'image', target: 'b', targetHandle: 'image_input' },
      { id: 'e1', source: 'a', sourceHandle: 'image', target: 'cine', targetHandle: 'character_refs' },
    ];
    const nodeRun: RunRecord = { id: 'saved-node', trigger: 'node', status: 'complete', startedAt: 1, targetNodeId: 'b',
      snapshot: { nodes: snapshotNodes, edges: snapshotEdges } };
    const shotRun: RunRecord = { id: 'saved-shot', trigger: 'shot', status: 'complete', startedAt: 1, targetNodeId: 'cine',
      snapshot: { nodes: snapshotNodes, edges: snapshotEdges }, cinemaShot: { nodeId: 'cine', shotId: 's1', variations: 2 } };

    it("a node run's replay asks over the placeholder that is still one, and Cancel runs nothing", async () => {
      useGraphStore.setState({ runHistory: [nodeRun] });
      askMock.mockResolvedValue(false);
      const execute = vi.spyOn(api, 'executeNode');
      await useGraphStore.getState().rerunHistoryRecord(nodeRun.id);
      expect(askMock).toHaveBeenCalledOnce();
      expect(askMock.mock.calls[0][0]).toMatchObject({ confirmIds: ['a'], runLabel: 'Run for $1.20' });
      expect(askMock.mock.calls[0][0].rows[0].name).toBe('“Hero still”');
      expect(execute).not.toHaveBeenCalled();
      expect(useGraphStore.getState().isExecuting).toBe(false);
    });

    it('a confirmed replay sends what the person confirmed', async () => {
      useGraphStore.setState({ runHistory: [nodeRun] });
      askMock.mockResolvedValue(true);
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      await useGraphStore.getState().rerunHistoryRecord(nodeRun.id);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][6]).toEqual(['a']);
      expect(execute.mock.calls[0][7]).toBeCloseTo(1.2);
    });

    it("a shot's replay asks too and sends the confirmation", async () => {
      useGraphStore.setState({ runHistory: [shotRun] });
      askMock.mockResolvedValue(true);
      const shot = vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' });
      await useGraphStore.getState().rerunHistoryRecord(shotRun.id);
      expect(askMock).toHaveBeenCalledOnce();
      expect(shot).toHaveBeenCalledOnce();
      expect(shot.mock.calls[0][7]).toEqual(['a']);
      expect(shot.mock.calls[0][8]).toBeCloseTo(2.4);
    });

    it('a replay with no placeholder left asks nothing, as before', async () => {
      useGraphStore.setState({ runHistory: [nodeRun], nodes: [imageNode('a'), imageNode('b'), cinemaNode()] as never });
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      await useGraphStore.getState().rerunHistoryRecord(nodeRun.id);
      expect(askMock).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][6]).toBeUndefined();
    });
  });
});
