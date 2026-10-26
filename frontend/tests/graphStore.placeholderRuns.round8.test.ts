import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 7 of the Q133 confirm (Justin, 2026-10-25: a paid placeholder never
 * runs without the person's confirmation, and what runs never costs more than
 * they were shown), with the coordinator's decisions and GM - Design's round 8:
 * - L1: a replay's classification follows what runs: a placeholder deleted
 *   from the canvas, or turned into another type, is never "finished"; the
 *   replay's saved copy runs as a normal paid node. One still a placeholder
 *   by id is asked about, as Nebula does.
 * - L2: a row counts as seen only if its node, model and price all match.
 * - L3: a notice never takes an agent's Undo away.
 * - GM item 4: a yes dropped while a graph import runs says so.
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
const scene = { version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9', shots: [{ id: 's1', prompt: 'a cat' }] };

const yes = async (model: PlaceholderRunConfirm) => model;
const node = (id: string, definitionId = 'nano-banana', extra: Record<string, unknown> = {}, params: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId, label: id, params, state: 'idle', outputs: {}, ...extra } });
const cinemaNode = () => ({ id: 'cine', type: 'cinema-scene', position: { x: 0, y: 0 },
  data: { definitionId: 'cinema-scene', label: 'Scene', params: { scene }, state: 'idle', outputs: {} } });

function refusal(high: number, placeholders: string[] = ['a'], nodes: Record<string, { low: number; high: number }> = { a: { low: high, high } }) {
  const message = 'Nothing ran.';
  return new api.ExecutionStartRejectedError(message, 409, { detail: {
    code: 'placeholder_confirm_required', message, placeholders,
    agents: Object.fromEntries(placeholders.map((id) => [id, codexAgent])),
    estimate: { low: high, high, nodes, unpriced: [], plan: [], plus: [], unavailable: {}, awaitingInput: [] },
  } });
}

const TABLE = { currencies: {}, nodes: {
  'nano-banana': { currency: 'usd', per: 'image', priceParams: ['model'], rows: [
    { match: { model: 'pricey' }, price: 9 }, { match: { model: 'cheap' }, price: 0.1 }, { match: {}, price: 0.6 }] },
  'flux-2-pro': { currency: 'usd', per: 'image', rows: [{ match: {}, price: 0.05 }] },
} };

const ANOTHER_RUN = 'Nothing ran. Another run started first. Click “Run” again when it finishes.';
const IMPORTING = 'Nothing ran. Nebula is still importing. Click “Run” again when it finishes.';
const IMPORTING_CINEMA = 'Nothing ran. Nebula is still importing. Generate again when it finishes.';
/** Every written line on screen: the canvas notice's, and a line beside an Undo. */
const lines = () => {
  const state = useGraphStore.getState() as unknown as { undoNotice: { text: string } | null; messageNotice?: { text: string } | null };
  return [state.undoNotice?.text, state.messageNotice?.text].filter(Boolean);
};

const record = (): RunRecord => ({ id: 'saved', trigger: 'node', status: 'complete', startedAt: 1, targetNodeId: 'b',
  snapshot: { nodes: [
    { id: 'a', definitionId: 'nano-banana', params: {}, outputs: {} },
    { id: 'b', definitionId: 'nano-banana', params: {}, outputs: {} },
  ], edges: [{ id: 'e1', source: 'a', sourceHandle: 'image', target: 'b', targetHandle: 'images' }] } } as never);

describe("review 7: the person's direct run once the placeholder dialog has shown", () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [node('a', 'nano-banana', { pending: codex }), node('b')] as never,
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'image', targetHandle: 'images' }],
      undoStack: [], redoStack: [], runHistory: [], isExecuting: false, isImportingGraph: false, backendFreshStartPending: false,
      providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null, messageNotice: null } as never);
    useUIStore.setState({ settingsCache: { apiKeys: { GOOGLE_API_KEY: 'set', FAL_KEY: 'set', BFL_API_KEY: 'set' }, loaded: true },
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
    useGraphStore.setState({ isImportingGraph: false });
    useUIStore.setState({ settingsCache: initialCache, runCostConfirmUsd: initialThreshold });
    usePricingStore.setState({ table: null });
    vi.restoreAllMocks();
  });

  describe('L1: a replay follows what runs', () => {
    it('Codex deletes its placeholder while the dialog is open: "Run without…", the saved copy runs as a muted row', async () => {
      useGraphStore.setState({ runHistory: [record()] });
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (first: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        expect(first.heading).toBe('Run 1 node Codex is still setting up?');
        const stop = options?.watch?.((next) => pushed.push(next));
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.filter((n) => n.id !== 'a') as never, edges: [] });
        stop?.();
        return pushed.at(-1) ?? null;
      }).mockResolvedValue(null);
      await useGraphStore.getState().rerunHistoryRecord('saved');
      const last = pushed.at(-1)!;
      expect(last).toMatchObject({ heading: 'Run without the node Codex was setting up?', intro: "It's no longer in this run.",
        leftLine: null, runLabel: 'Run for $1.20' });
      // The row keeps the name the dialog showed, with no agent dot.
      expect(last.rows.map((row) => [row.nodeId, row.name, row.agent])).toEqual([['a', '“a”', null], ['b', '“b”', null]]);
      // What runs is what was shown: the saved copy, at the total shown, no re-ask.
      expect(askMock).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][0].map((n: { id: string }) => n.id)).toEqual(['a', 'b']);
      expect(execute.mock.calls[0][6]).toEqual([]);
      expect(execute.mock.calls[0][7]).toBe(1.2);
    });

    it('Codex turns it into another model and finishes it: never "finished", the replay runs its saved Nano Banana', async () => {
      useGraphStore.setState({ runHistory: [record()] });
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (_m: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        const stop = options?.watch?.((next) => pushed.push(next));
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'a'
          ? { ...n, data: { ...n.data, definitionId: 'flux-2-pro', pending: undefined, params: {} } } : n) as never });
        stop?.();
        return null;
      });
      await useGraphStore.getState().rerunHistoryRecord('saved');
      const last = pushed.at(-1)!;
      expect(last.heading).toBe('Run without the node Codex was setting up?');
      expect(last.rows.find((row) => row.nodeId === 'a')).toMatchObject({ agent: null, price: '$0.60' });
    });

    it('still a placeholder by id under another model: asked about from the first dialog, as Nebula holds it', async () => {
      useGraphStore.setState({ runHistory: [record()],
        nodes: [node('a', 'flux-2-pro', { pending: codex }), node('b')] as never });
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementation(yes);
      await useGraphStore.getState().rerunHistoryRecord('saved');
      expect(askMock).toHaveBeenCalledOnce();
      expect(askMock.mock.calls[0][0]).toMatchObject({ heading: 'Run 1 node Codex is still setting up?', confirmIds: ['a'] });
      expect(execute.mock.calls[0][6]).toEqual(['a']);
    });
  });

  describe('L2: a row counts as seen only if its node, model and price all match', () => {
    it('same node, another model, cheaper, no placeholder left: asks again with the changed line', async () => {
      useGraphStore.setState({ nodes: [node('a', 'nano-banana', { pending: codex }), node('b', 'nano-banana')] as never });
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'a'
          ? { ...n, data: { ...n.data, definitionId: 'flux-2-pro', pending: undefined, params: {} } } : n) as never });
        return model;
      }).mockResolvedValueOnce(null);
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[1][1]).toMatchObject({ changed: true });
      expect(execute).not.toHaveBeenCalled();
    });

    it('same node and model, a lower price: asks again', async () => {
      useGraphStore.setState({ nodes: [node('a', 'nano-banana', { pending: codex }, { model: 'pricey' }), node('b')] as never });
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'a'
          ? { ...n, data: { ...n.data, pending: undefined, params: { model: 'cheap' } } } : n) as never });
        return model;
      }).mockResolvedValueOnce(null);
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(execute).not.toHaveBeenCalled();
    });

    it('Codex finishes it unchanged: every row as shown, so it goes ahead at the total shown', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'a'
          ? { ...n, data: { ...n.data, pending: undefined } } : n) as never });
        return model;
      });
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][7]).toBe(1.2);
    });
  });

  describe("L3: a notice never takes an agent's Undo away", () => {
    const agentUndo = () => {
      const entry = { id: 'x' };
      useGraphStore.setState({ undoStack: [entry] as never,
        undoNotice: { id: 99, text: 'Codex changed the canvas', offer: 'undo', agentColor: '#F2C14E', entry } as never });
      return entry;
    };

    it('"Another run started first" shows beside "Codex changed the canvas", which keeps its Undo', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        agentUndo();
        useGraphStore.setState({ isExecuting: true });
        return model;
      });
      await useGraphStore.getState().executeNode('b');
      expect(execute).not.toHaveBeenCalled();
      expect(useGraphStore.getState().undoNotice).toMatchObject({ text: 'Codex changed the canvas', offer: 'undo' });
      expect(lines()).toEqual(['Codex changed the canvas', ANOTHER_RUN]);
    });

    it('every notice keeps an open Undo the same way', () => {
      agentUndo();
      useGraphStore.getState().notify("Couldn't save the file.");
      expect(useGraphStore.getState().undoNotice).toMatchObject({ offer: 'undo' });
      expect(lines()).toEqual(['Codex changed the canvas', "Couldn't save the file."]);
    });

    it('with no Undo showing, a notice is the canvas notice as before', () => {
      useGraphStore.getState().notify("Couldn't save the file.");
      expect(useGraphStore.getState().undoNotice).toMatchObject({ text: "Couldn't save the file.", offer: null, tone: 'error' });
      expect(lines()).toEqual(["Couldn't save the file."]);
    });
  });

  describe('GM round 8, item 4: a yes dropped while a graph import runs', () => {
    it('node Run: "Nothing ran. Nebula is still importing. Click “Run” again when it finishes."', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        useGraphStore.setState({ isImportingGraph: true });
        return model;
      });
      await useGraphStore.getState().executeNode('b');
      expect(execute).not.toHaveBeenCalled();
      expect(lines()).toEqual([IMPORTING]);
    });

    it("on Nebula's re-ask too", async () => {
      const execute = vi.spyOn(api, 'executeNode').mockRejectedValueOnce(refusal(4.8)).mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(yes).mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        useGraphStore.setState({ isImportingGraph: true });
        return model;
      });
      await useGraphStore.getState().executeNode('b');
      expect(execute).toHaveBeenCalledOnce();
      expect(lines()).toEqual([IMPORTING]);
    });

    it('a replay: the same words', async () => {
      useGraphStore.setState({ runHistory: [record()] });
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        useGraphStore.setState({ isImportingGraph: true });
        return model;
      });
      await useGraphStore.getState().rerunHistoryRecord('saved');
      expect(execute).not.toHaveBeenCalled();
      expect(lines()).toEqual([IMPORTING]);
    });

    it('from Cinema: "Nothing ran. Nebula is still importing. Generate again when it finishes."', async () => {
      useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, cinemaNode()] as never,
        edges: [...useGraphStore.getState().edges, { id: 'e3', source: 'a', target: 'cine', sourceHandle: 'image', targetHandle: 'character_refs' }] });
      const shot = vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        useGraphStore.setState({ isImportingGraph: true });
        return model;
      });
      await useGraphStore.getState().executeShot('cine', 's1');
      expect(shot).not.toHaveBeenCalled();
      expect(lines()).toEqual([IMPORTING_CINEMA]);
    });

    it('Cancel during an import says nothing', async () => {
      askMock.mockImplementationOnce(async () => { useGraphStore.setState({ isImportingGraph: true }); return null; });
      await useGraphStore.getState().executeNode('b');
      expect(lines()).toEqual([]);
    });

    it('another run still says "Another run started first"', async () => {
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        useGraphStore.setState({ isExecuting: true });
        return model;
      });
      await useGraphStore.getState().executeNode('b');
      expect(lines()).toEqual([ANOTHER_RUN]);
    });
  });
});
