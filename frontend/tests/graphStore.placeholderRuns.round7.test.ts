import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 6 of the Q133 confirm (Justin, 2026-10-25: a paid placeholder never
 * runs without the person's confirmation, and what runs never costs more than
 * they were shown), with GM - Design's round-7 answers:
 * - L-a: after a yes, the run goes ahead without asking again only if every
 *   row and every "Not included" note in it was on screen; anything new asks.
 * - L-b: the dialog tracks only this run's placeholders; one that left the
 *   run (deleted or disconnected) is never "finished".
 * - L-c: a yes dropped because another run started first says so.
 * - L-e: the confirmed amount is the one shown, rounded up to the cent.
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

type Watch = (show: (next: PlaceholderRunConfirm) => void) => () => void;

const initialCache = useUIStore.getState().settingsCache;
const initialThreshold = useUIStore.getState().runCostConfirmUsd;
const codexAgent = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const claudeAgent = { id: 'ext:claude', name: 'Claude Code', color: '#7AA2F7', verified: true };
const codex = { agent: codexAgent, at: 1 };
const claude = { agent: claudeAgent, at: 1 };
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
    { match: { model: 'pricey' }, price: 9 }, { match: { model: 'cheap' }, price: 0.1 }, { match: { model: 'odd' }, price: 0.201 },
    { match: {}, price: 0.6 }] },
  'flux-2-pro': { currency: 'usd', per: 'image', plus: 'input images', rows: [{ match: {}, price: 0.05 }] },
} };

const ANOTHER_RUN = 'Nothing ran. Another run started first. Click “Run” again when it finishes.';
const ANOTHER_RUN_CINEMA = 'Nothing ran. Another run started first. Generate again when it finishes.';
const notice = () => useGraphStore.getState().undoNotice?.text ?? null;

describe("review 6: the person's direct run once the placeholder dialog has shown", () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [node('a', 'nano-banana', { pending: codex }), node('b')] as never,
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'image', targetHandle: 'images' }],
      undoStack: [], redoStack: [], runHistory: [], isExecuting: false, backendFreshStartPending: false,
      providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null } as never);
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
    useUIStore.setState({ settingsCache: initialCache, runCostConfirmUsd: initialThreshold });
    usePricingStore.setState({ table: null });
    vi.restoreAllMocks();
  });

  describe('L-a: a cheaper run goes ahead only if everything in it was on screen', () => {
    it('a new paid node with a "Not included" cost joins and Codex finishes on a cheaper model: asks again', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        const s = useGraphStore.getState();
        useGraphStore.setState({
          nodes: [...s.nodes.map((n) => n.id === 'a' ? { ...n, data: { ...n.data, pending: undefined, params: { model: 'cheap' } } } : n),
            node('f', 'flux-2-pro')] as never,
          edges: [...s.edges, { id: 'e9', source: 'f', target: 'b', sourceHandle: 'image', targetHandle: 'images' }] });
        return model; // the click landed on the words drawn before
      }).mockResolvedValueOnce(null);
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[1][1]).toMatchObject({ changed: true });
      expect(askMock.mock.calls[1][0].rows.map((row: { nodeId: string }) => row.nodeId)).toContain('f');
      expect(execute).not.toHaveBeenCalled();
    });

    it('a new priced paid node alone (no note) asks again too', async () => {
      useGraphStore.setState({ nodes: [node('a', 'nano-banana', { pending: codex }, { model: 'pricey' }), node('b', 'nano-banana', {}, { model: 'cheap' })] as never });
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        const s = useGraphStore.getState();
        useGraphStore.setState({
          nodes: [...s.nodes.map((n) => n.id === 'a' ? { ...n, data: { ...n.data, pending: undefined, params: { model: 'cheap' } } } : n),
            node('c', 'nano-banana', {}, { model: 'cheap' })] as never,
          edges: [...s.edges, { id: 'e8', source: 'c', target: 'b', sourceHandle: 'image', targetHandle: 'images' }] });
        return model;
      }).mockImplementationOnce(yes);
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][7]).toBe(0.3);
    });

    it('the same rows, cheaper: goes ahead without asking again, at the total shown', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'a'
          ? { ...n, data: { ...n.data, pending: undefined, params: { model: 'cheap' } } } : n) as never });
        return model;
      });
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][7]).toBe(1.2);
    });
  });

  describe('L-b: only this run\'s placeholders, and one that left is not "finished"', () => {
    beforeEach(() => {
      // Claude Code's unrelated placeholder elsewhere on the canvas.
      useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, node('z', 'nano-banana', { pending: claude })] as never });
    });

    it('Codex\'s placeholder deleted while the dialog is open: "Run without the node Codex was setting up?"', async () => {
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (_m: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        const stop = options?.watch?.((next) => pushed.push(next));
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.filter((n) => n.id !== 'a') as never, edges: [] });
        stop?.();
        return null;
      });
      await useGraphStore.getState().executeNode('b');
      expect(pushed.at(-1)).toMatchObject({ heading: 'Run without the node Codex was setting up?', intro: "It's no longer in this run.",
        leftLine: null, runLabel: 'Run for $0.60' });
    });

    it('disconnected: the same words, and a yes runs what was shown', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (_m: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        const stop = options?.watch?.((next) => pushed.push(next));
        useGraphStore.setState({ edges: [] });
        stop?.();
        return pushed.at(-1) ?? null;
      });
      await useGraphStore.getState().executeNode('b');
      expect(pushed.at(-1)).toMatchObject({ heading: 'Run without the node Codex was setting up?', intro: "It's no longer in this run." });
      expect(askMock).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][7]).toBe(0.6);
    });

    it('another agent finishing its unrelated placeholder changes nothing', async () => {
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (_m: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        const stop = options?.watch?.((next) => pushed.push(next));
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'z'
          ? { ...n, data: { ...n.data, pending: undefined } } : n) as never });
        stop?.();
        return null;
      });
      await useGraphStore.getState().executeNode('b');
      expect(pushed).toEqual([]);
    });

    it('one finished and one deleted: the changes heading, this node, and the left line', async () => {
      useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, node('g', 'nano-banana', { pending: codex })] as never,
        edges: [...useGraphStore.getState().edges, { id: 'e2', source: 'g', target: 'b', sourceHandle: 'image', targetHandle: 'images' }] });
      const pushed: PlaceholderRunConfirm[] = [];
      askMock.mockImplementationOnce(async (_m: PlaceholderRunConfirm, options?: { watch?: Watch }) => {
        const stop = options?.watch?.((next) => pushed.push(next));
        useGraphStore.setState({
          nodes: useGraphStore.getState().nodes.filter((n) => n.id !== 'g')
            .map((n) => n.id === 'a' ? { ...n, data: { ...n.data, pending: undefined } } : n) as never,
          edges: useGraphStore.getState().edges.filter((e) => e.source !== 'g') });
        stop?.();
        return null;
      });
      await useGraphStore.getState().executeNode('b');
      expect(pushed.at(-1)).toMatchObject({ heading: "Run with Codex's changes?", intro: 'Codex finished setting up this node.',
        leftLine: '1 node Codex was setting up is no longer in this run.' });
    });
  });

  describe('L-c: a yes dropped because another run started first says so', () => {
    it('on the re-ask after Nebula refused: the notice, and the other run is left alone', async () => {
      useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, cinemaNode()] as never,
        edges: [...useGraphStore.getState().edges, { id: 'e3', source: 'a', target: 'cine', sourceHandle: 'image', targetHandle: 'character_refs' }] });
      const shot = vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' } as never);
      const execute = vi.spyOn(api, 'executeNode').mockRejectedValueOnce(refusal(4.8)).mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(yes) // b's first ask
        .mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
          // While Nebula's re-ask is open, the person starts a Cinema shot (its own ask: yes).
          await useGraphStore.getState().executeShot('cine', 's1');
          return model;
        })
        .mockImplementationOnce(yes); // the shot's ask
      await useGraphStore.getState().executeNode('b');
      expect(execute).toHaveBeenCalledOnce();
      expect(shot).toHaveBeenCalledOnce();
      expect(useGraphStore.getState().runHistory.map((record) => record.trigger)).toEqual(['shot']);
      expect(notice()).toBe(ANOTHER_RUN);
    });

    it('on the first ask: a yes after another run started says so, and sends nothing', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        useGraphStore.setState({ isExecuting: true });
        return model;
      });
      await useGraphStore.getState().executeNode('b');
      expect(execute).not.toHaveBeenCalled();
      expect(notice()).toBe(ANOTHER_RUN);
    });

    it('Cancel says nothing', async () => {
      askMock.mockImplementationOnce(async () => { useGraphStore.setState({ isExecuting: true }); return null; });
      await useGraphStore.getState().executeNode('b');
      expect(notice()).toBeNull();
    });

    it('from Cinema: "Generate again when it finishes."', async () => {
      useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, cinemaNode()] as never,
        edges: [...useGraphStore.getState().edges, { id: 'e3', source: 'a', target: 'cine', sourceHandle: 'image', targetHandle: 'character_refs' }] });
      const shot = vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: PlaceholderRunConfirm) => {
        // Another click started this same shot first.
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => n.id === 'cine'
          ? { ...n, data: { ...n.data, params: { scene: { ...scene, shots: [{ ...scene.shots[0], output: { status: 'running' } }] } } } } : n) as never });
        return model;
      });
      await useGraphStore.getState().executeShot('cine', 's1');
      expect(shot).not.toHaveBeenCalled();
      expect(notice()).toBe(ANOTHER_RUN_CINEMA);
    });
  });

  describe('L-e: the amount confirmed is the one shown, rounded up to the cent', () => {
    it('$0.201 shows "Run for $0.21" and sends 0.21', async () => {
      useGraphStore.setState({ nodes: [node('a', 'nano-banana', { pending: codex }, { model: 'odd' })] as never, edges: [] });
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementation(yes);
      await useGraphStore.getState().executeNode('a');
      expect(askMock.mock.calls[0][0].runLabel).toBe('Run for $0.21');
      expect(execute.mock.calls[0][7]).toBe(0.21);
    });

    it("Nebula's refusal estimate is rounded up the same way before it is sent", async () => {
      const execute = vi.spyOn(api, 'executeNode').mockRejectedValueOnce(refusal(1.2001, ['a'], { a: { low: 0.6001, high: 0.6001 }, b: { low: 0.6, high: 0.6 } })).mockResolvedValueOnce({ status: 'started' } as never);
      askMock.mockImplementation(yes);
      await useGraphStore.getState().executeNode('b');
      expect(askMock.mock.calls[1][0].runLabel).toBe('Run for $1.21');
      expect(execute.mock.calls[1][7]).toBe(1.21);
    });
  });
});
