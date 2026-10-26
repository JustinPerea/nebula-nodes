import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 9 of the Q133 confirm (Justin, 2026-10-25: a paid placeholder never
 * runs without the person's confirmation, and what runs never costs more than
 * they were shown), with GM - Design's round-10 rulings:
 * - L-3: a node labelled with its model id still asks again when the model
 *   switches (the seen key is the raw model name, always).
 * - GM item 2: a Krea node's sub-model setting is named in its row, so a
 *   switch re-asks (Krea-plan rows have no dollar amount to change).
 * - GM item 1: the replay sentence names the changed nodes.
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
import type { RunRecord } from '../src/lib/runHistory';

type Watch = (show: (next: PlaceholderRunConfirm) => void) => () => void;

const initialCache = useUIStore.getState().settingsCache;
const initialThreshold = useUIStore.getState().runCostConfirmUsd;
const codexAgent = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const codex = { agent: codexAgent, at: 1 };
const node = (id: string, definitionId = 'nano-banana', extra: Record<string, unknown> = {}, params: Record<string, unknown> = {}, label = id) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId, label, params, state: 'idle', outputs: {}, ...extra } });

const TABLE = { currencies: {}, nodes: {
  'nano-banana': { currency: 'usd', per: 'image', priceParams: ['model'], rows: [
    { match: { model: 'pricey' }, price: 9 }, { match: { model: 'cheap' }, price: 0.1 }, { match: {}, price: 0.6 }] },
} };
const edit = (id: string, change: (data: Record<string, unknown>) => Record<string, unknown>) => {
  useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === id
    ? { ...n, data: change(n.data as unknown as Record<string, unknown>) } : n) as never });
};

describe('review 9 and GM round 10', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], runHistory: [], isExecuting: false, isImportingGraph: false,
      backendFreshStartPending: false, providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null, messageNotice: null } as never);
    useUIStore.setState({ settingsCache: { apiKeys: { GOOGLE_API_KEY: 'set', OPENROUTER_API_KEY: 'set', KREA_API_TOKEN: 'set' }, loaded: true },
      runCostConfirmUsd: null } as never);
    usePricingStore.setState({ table: TABLE } as never);
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

  it('L-3: labelled with its model id, switched (name and model) after the click: asks again, nothing runs unasked', async () => {
    useGraphStore.setState({ nodes: [node('p', 'nano-banana', {}, {}, 'Still'),
      node('u', 'openrouter-universal', { pending: codex }, { model: 'openai/gpt-4o-mini' }, 'openai/gpt-4o-mini')] as never,
    edges: [{ id: 'e1', source: 'p', target: 'u', sourceHandle: 'image', targetHandle: 'images' }] as never });
    const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
    askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
      edit('u', (data) => ({ ...data, pending: undefined, label: 'anthropic/claude-opus-4.1', params: { model: 'anthropic/claude-opus-4.1' } }));
      return model;
    }).mockResolvedValueOnce(null);
    await useGraphStore.getState().executeNode('u');
    expect(askMock).toHaveBeenCalledTimes(2);
    expect(askMock.mock.calls[1][1]).toMatchObject({ changed: true });
    expect(execute).not.toHaveBeenCalled();
  });

  describe('GM item 2: a Krea Variant switch', () => {
    beforeEach(() => {
      useGraphStore.setState({ nodes: [node('k', 'krea-2-generate', { pending: codex }, { _kreaAuth: 'mcp', variant: 'medium' }, 'Hero')] as never,
        edges: [] });
    });

    it('the row names it: “Hero” · Krea 2 · Variant: Medium · on your Krea plan', async () => {
      askMock.mockResolvedValueOnce(null);
      await useGraphStore.getState().executeNode('k');
      expect((askMock.mock.calls[0][0] as PlaceholderRunConfirm).rows[0]).toMatchObject({
        name: '“Hero”', model: 'Krea 2', setting: 'Variant: Medium', price: 'on your Krea plan' });
    });

    it('switched after the click: asks again over the new Variant, nothing runs unasked', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        edit('k', (data) => ({ ...data, pending: undefined, params: { _kreaAuth: 'mcp', variant: 'large' } }));
        return model;
      }).mockResolvedValueOnce(null);
      await useGraphStore.getState().executeNode('k');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[1][1]).toMatchObject({ changed: true });
      expect((askMock.mock.calls[1][0] as PlaceholderRunConfirm).rows[0].setting).toBe('Variant: Large');
      expect(execute).not.toHaveBeenCalled();
    });

    it('switched while open: the dialog redraws with it', async () => {
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (_model: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        const stop = options?.watch?.((next) => pushed.push(next));
        edit('k', (data) => ({ ...data, params: { _kreaAuth: 'mcp', variant: 'large' } }));
        stop?.();
        return null;
      });
      await useGraphStore.getState().executeNode('k');
      expect(pushed.at(-1)?.rows[0].setting).toBe('Variant: Large');
    });
  });

  it("GM item 1: a replay names the node Codex changed after the save", async () => {
    const record: RunRecord = { id: 'saved', trigger: 'node', status: 'complete', startedAt: 1, targetNodeId: 'b',
      snapshot: { nodes: [
        { id: 'a', definitionId: 'nano-banana', params: { model: 'cheap' }, outputs: {} },
        { id: 'b', definitionId: 'nano-banana', params: {}, outputs: {} },
      ], edges: [{ id: 'e1', source: 'a', sourceHandle: 'image', target: 'b', targetHandle: 'images' }] } } as never;
    useGraphStore.setState({ runHistory: [record], nodes: [node('a', 'nano-banana', { pending: codex }, { model: 'pricey' }, 'Grade'), node('b')] as never,
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'image', targetHandle: 'images' }] as never });
    askMock.mockResolvedValue(null);
    await useGraphStore.getState().rerunHistoryRecord('saved');
    expect(askMock.mock.calls[0][0]).toMatchObject({ heading: 'Run 1 node Codex is still setting up?',
      savedLine: 'Codex changed “Grade” after the run was saved. The replay uses the saved settings.' });
  });
});
