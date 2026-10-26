import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 8 of the Q133 confirm (Justin, 2026-10-25: a paid placeholder never
 * runs without the person's confirmation, and what runs never costs more than
 * they were shown), with GM - Design's ruling on L-b (2026-10-26):
 * - L-a: a node whose model is a free-text param (OpenRouter, Nous Portal…)
 *   names the chosen model in its row, so a switch is a changed row: the open
 *   dialog redraws, and after the click it asks again.
 * - L-b: a replay whose placeholder the agent changed after the run was saved
 *   says the replay uses the saved settings ("Replay the saved version?").
 * - L-d: the wire-sync failure and the held-delete refusal never take an
 *   agent's Undo away (through notify).
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

const lines = () => {
  const state = useGraphStore.getState() as unknown as { undoNotice: { text: string } | null; messageNotice?: { text: string } | null };
  return [state.undoNotice?.text, state.messageNotice?.text].filter(Boolean);
};
const agentUndo = () => {
  const entry = { id: 'x' };
  useGraphStore.setState({ undoStack: [entry] as never,
    undoNotice: { id: 99, text: 'Codex changed the canvas', offer: 'undo', agentColor: '#F2C14E', entry } as never });
};

const OPENROUTER_EDGES = [{ id: 'e1', source: 'p', target: 'u', sourceHandle: 'image', targetHandle: 'images' }];

describe('review 8', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [], runHistory: [], isExecuting: false, isImportingGraph: false,
      backendFreshStartPending: false, providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null, messageNotice: null } as never);
    useUIStore.setState({ settingsCache: { apiKeys: { GOOGLE_API_KEY: 'set', OPENROUTER_API_KEY: 'set' }, loaded: true },
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

  describe('L-a: an OpenRouter row names its model', () => {
    beforeEach(() => {
      useGraphStore.setState({ nodes: [node('p', 'nano-banana', {}, {}, 'Still'),
        node('u', 'openrouter-universal', { pending: codex }, { model: 'openai/gpt-4o-mini' }, 'Writer')] as never,
      edges: OPENROUTER_EDGES as never });
    });

    it('switched to another model after the click: asks again, nothing runs unasked', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        expect(model.rows.find((row) => row.nodeId === 'u')?.model).toBe('openai/gpt-4o-mini');
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'u'
          ? { ...n, data: { ...n.data, pending: undefined, params: { model: 'anthropic/claude-opus-4.1' } } } : n) as never });
        return model;
      }).mockResolvedValueOnce(null);
      await useGraphStore.getState().executeNode('u');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[1][1]).toMatchObject({ changed: true });
      expect((askMock.mock.calls[1][0] as PlaceholderRunConfirm).rows.find((row) => row.nodeId === 'u')?.model)
        .toBe('anthropic/claude-opus-4.1');
      expect(execute).not.toHaveBeenCalled();
    });

    it('switched while still a placeholder, with the dialog open: the dialog redraws with the new model', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        const stop = options?.watch?.((next) => pushed.push(next));
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'u'
          ? { ...n, data: { ...n.data, params: { model: 'anthropic/claude-opus-4.1' } } } : n) as never });
        stop?.();
        return null;
      });
      await useGraphStore.getState().executeNode('u');
      expect(pushed.at(-1)?.rows.find((row) => row.nodeId === 'u')?.model).toBe('anthropic/claude-opus-4.1');
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("L-b (GM): a replay where the agent's version isn't what runs", () => {
    const record = (): RunRecord => ({ id: 'saved', trigger: 'node', status: 'complete', startedAt: 1, targetNodeId: 'b',
      snapshot: { nodes: [
        { id: 'a', definitionId: 'nano-banana', params: { model: 'cheap' }, outputs: {} },
        { id: 'b', definitionId: 'nano-banana', params: {}, outputs: {} },
      ], edges: [{ id: 'e1', source: 'a', sourceHandle: 'image', target: 'b', targetHandle: 'images' }] } } as never);
    const edges = [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'image', targetHandle: 'images' }];

    it('Codex finishes it with new settings while the dialog is open: "Replay the saved version?", the saved row runs', async () => {
      useGraphStore.setState({ runHistory: [record()], nodes: [node('a', 'nano-banana', { pending: codex }, { model: 'cheap' }), node('b')] as never,
        edges: edges as never });
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (first: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        expect(first.heading).toBe('Run 1 node Codex is still setting up?');
        expect(first.savedLine).toBeNull();
        const stop = options?.watch?.((next) => pushed.push(next));
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'a'
          ? { ...n, data: { ...n.data, pending: undefined, params: { model: 'pricey' } } } : n) as never });
        stop?.();
        return pushed.at(-1) ?? null;
      }).mockResolvedValue(null);
      await useGraphStore.getState().rerunHistoryRecord('saved');
      const last = pushed.at(-1)!;
      expect(last).toMatchObject({ heading: 'Replay the saved version?',
        intro: 'Codex changed “a” after the run was saved. The replay uses the saved settings.', runLabel: 'Run for $0.70' });
      // The saved version, muted: no dot, at the saved model's price.
      expect(last.rows.find((row) => row.nodeId === 'a')).toMatchObject({ agent: null, price: '$0.10' });
      // What was shown runs: the saved params.
      expect(askMock).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      const sent = execute.mock.calls[0][0] as Array<{ id: string; data?: { params?: Record<string, unknown> }; params?: Record<string, unknown> }>;
      const sentA = sent.find((n) => n.id === 'a');
      expect(sentA?.data?.params ?? sentA?.params).toEqual({ model: 'cheap' });
    });

    it('still a placeholder, already changed since the save: the sentence shows from the first dialog', async () => {
      useGraphStore.setState({ runHistory: [record()], nodes: [node('a', 'nano-banana', { pending: codex }, { model: 'pricey' }), node('b')] as never,
        edges: edges as never });
      askMock.mockResolvedValue(null);
      await useGraphStore.getState().rerunHistoryRecord('saved');
      expect(askMock.mock.calls[0][0]).toMatchObject({ heading: 'Run 1 node Codex is still setting up?',
        savedLine: 'Codex changed “a” after the run was saved. The replay uses the saved settings.' });
    });

    it('Codex finishes it with the saved settings: "Run with Codex\'s changes?" as before', async () => {
      useGraphStore.setState({ runHistory: [record()], nodes: [node('a', 'nano-banana', { pending: codex }, { model: 'cheap' }), node('b')] as never,
        edges: edges as never });
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (_m: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        const stop = options?.watch?.((next) => pushed.push(next));
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'a'
          ? { ...n, data: { ...n.data, pending: undefined } } : n) as never });
        stop?.();
        return null;
      });
      await useGraphStore.getState().rerunHistoryRecord('saved');
      expect(pushed.at(-1)).toMatchObject({ heading: "Run with Codex's changes?", savedLine: null });
    });
  });

  describe("L-d: the two direct writers never take an agent's Undo away", () => {
    it('a refused wire: the line shows beside "Codex changed the canvas", which keeps its Undo', async () => {
      // Canvas ids the backend knows (n1, n2): their wires are sent.
      useGraphStore.setState({ nodes: [node('n1'), node('n2')] as never, edges: [] });
      let answer!: (response: Response) => void;
      apiFetchMock.mockReset().mockReturnValue(new Promise<Response>((resolve) => { answer = resolve; }));
      useGraphStore.getState().onConnect({ source: 'n1', sourceHandle: 'image', target: 'n2', targetHandle: 'images' });
      // Codex's edit arrives (its notice with Undo) before the backend's refusal does.
      agentUndo();
      answer(new Response(JSON.stringify({ detail: 'Those ports do not fit.' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }));
      await vi.waitFor(() => expect(lines()).toHaveLength(2));
      expect(useGraphStore.getState().undoNotice).toMatchObject({ text: 'Codex changed the canvas', offer: 'undo' });
      expect(lines()[1]).toMatch(/^Couldn't make that connection\./);
    });

    it('a held delete: the refusal shows beside the Undo too', () => {
      useGraphStore.setState({ nodes: [node('w', 'worldlabs-environment')] as never, edges: [],
        providerRecoveries: [{ runId: 'r', nodeId: 'w', resumeOperationId: 'op', existingWorldId: null }] } as never);
      agentUndo();
      expect(useGraphStore.getState().allowCanvasDelete(['w'])).toBe(false);
      expect(useGraphStore.getState().undoNotice).toMatchObject({ text: 'Codex changed the canvas', offer: 'undo' });
      expect(lines()).toHaveLength(2);
    });
  });
});
