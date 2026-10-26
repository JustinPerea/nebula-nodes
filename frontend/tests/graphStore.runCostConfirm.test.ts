import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiFetchMock,
  getCachedBackendBaseUrl: () => null,
}));
const askMock = vi.hoisted(() => vi.fn());
vi.mock('../src/components/askPlaceholderRun', () => ({ askPlaceholderRun: askMock }));
/** The person clicks Run on the words the dialog showed (it hands them back: review 5, L6). */
const yes = async (model: unknown) => model;
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(),
} }));

import { useGraphStore } from '../src/store/graphStore';
import { usePricingStore } from '../src/store/pricingStore';
import { useUIStore } from '../src/store/uiStore';
import * as api from '../src/lib/api';

const initialCache = useUIStore.getState().settingsCache;
const initialThreshold = useUIStore.getState().runCostConfirmUsd;

const imageNode = (id: string) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId: 'nano-banana', label: id, params: {}, state: 'idle', outputs: {} } });

describe('run cost confirmation', () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [imageNode('a'), imageNode('b')], edges: [], undoStack: [], redoStack: [],
      runHistory: [], isExecuting: false, backendFreshStartPending: false,
      providerRecoveries: [], providerStartAmbiguities: [] });
    useUIStore.setState({ settingsCache: { apiKeys: { GOOGLE_API_KEY: 'set' }, loaded: true } });
    usePricingStore.setState({ table: { currencies: {}, nodes: {
      'nano-banana': { currency: 'usd', per: 'image', rows: [{ match: {}, price: 0.6 }] },
    } } });
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    useGraphStore.getState().resetExecution();
    useUIStore.setState({ settingsCache: initialCache, runCostConfirmUsd: initialThreshold });
    usePricingStore.setState({ table: null });
    vi.restoreAllMocks();
  });

  it('does not start a run the user declines', async () => {
    useUIStore.setState({ runCostConfirmUsd: 1 });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const execute = vi.spyOn(api, 'executeGraph');
    await useGraphStore.getState().executeGraph();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain('could cost up to $1.20');
    expect(execute).not.toHaveBeenCalled();
    expect(useGraphStore.getState().isExecuting).toBe(false);
    expect(useGraphStore.getState().runHistory).toEqual([]);
  });

  it('checks the narrower scope of a single node or a cluster', async () => {
    useUIStore.setState({ runCostConfirmUsd: 1 });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const executeNode = vi.spyOn(api, 'executeNode');
    await useGraphStore.getState().executeCluster(['a', 'b']);
    expect(confirm).toHaveBeenCalledOnce();
    // One node at $0.60 stays under the $1 threshold, so it runs without asking.
    await useGraphStore.getState().executeNode('a');
    expect(confirm).toHaveBeenCalledOnce();
    expect(executeNode).toHaveBeenCalled();
  });

  it('never asks when the threshold is off or no price table loaded', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    useUIStore.setState({ runCostConfirmUsd: null });
    await useGraphStore.getState().executeGraph();
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ isExecuting: false });
    useUIStore.setState({ runCostConfirmUsd: 1 });
    usePricingStore.setState({ table: null });
    await useGraphStore.getState().executeGraph();
    expect(confirm).not.toHaveBeenCalled();
  });

  // Q125 item 3, GM - Design 2026-10-25: the cost shown before a run counts
  // what that run will do with agents' placeholders.
  describe('with an agent\'s placeholder', () => {
    const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };
    beforeEach(() => {
      // a (Codex's placeholder) -> b; c stands alone.
      useGraphStore.setState({
        nodes: [{ ...imageNode('a'), data: { ...imageNode('a').data, pending: codex } }, imageNode('b'), imageNode('c')],
        edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'image', targetHandle: 'image_input' }],
      });
      useUIStore.setState({ runCostConfirmUsd: 0.5 });
    });

    it("the person's direct run over a free placeholder counts it and says so", async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      useGraphStore.setState({
        nodes: [{ id: 'a', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'text-input', label: 'a',
          params: { value: 'x' }, state: 'idle', outputs: {}, pending: codex } }, imageNode('b')],
      });
      await useGraphStore.getState().executeNode('b');
      expect(askMock).not.toHaveBeenCalled();
      expect(confirm).toHaveBeenCalledOnce();
      expect(confirm.mock.calls[0][0]).toContain('could cost up to $0.60');
      expect(confirm.mock.calls[0][0]).toContain('Includes 2 nodes Codex is still setting up.');
    });

    // Q133 (Justin, 2026-10-25): always ask first when a placeholder the run
    // makes normal calls a paid model, whatever the costly-run setting.
    describe('a paid placeholder in the run', () => {
      beforeEach(() => { askMock.mockReset(); });

      it('always asks, even with "Ask before costly runs" off, and Cancel runs and changes nothing', async () => {
        useUIStore.setState({ runCostConfirmUsd: null });
        askMock.mockResolvedValue(null);
        const confirm = vi.spyOn(window, 'confirm');
        const execute = vi.spyOn(api, 'executeNode');
        const before = useGraphStore.getState().nodes;
        await useGraphStore.getState().executeNode('b');
        expect(askMock).toHaveBeenCalledOnce();
        expect(askMock.mock.calls[0][0]).toMatchObject({
          heading: 'Run 1 node Codex is still setting up?',
          totalLine: 'This run could cost up to $1.20 at list prices.',
          runLabel: 'Run for $1.20',
          confirmIds: ['a'],
        });
        expect(confirm).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(useGraphStore.getState().nodes).toBe(before);
        expect(useGraphStore.getState().isExecuting).toBe(false);
        expect(useGraphStore.getState().runHistory).toEqual([]);
      });

      it('replaces the costly-run confirm when both apply: one dialog', async () => {
        useUIStore.setState({ runCostConfirmUsd: 0.01 });
        askMock.mockResolvedValue(null);
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        await useGraphStore.getState().executeNode('b');
        expect(askMock).toHaveBeenCalledOnce();
        expect(confirm).not.toHaveBeenCalled();
      });

      it('a confirmed run sends exactly the paid placeholders it confirmed', async () => {
        useUIStore.setState({ runCostConfirmUsd: 0.01 });
        askMock.mockImplementation(yes);
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
        await useGraphStore.getState().executeNode('b');
        expect(confirm).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][6]).toEqual(['a']);
        // The total the dialog showed: the backend refuses a run it prices higher.
        expect(execute.mock.calls[0][7]).toBeCloseTo(1.2);
      });

      // Review 3, finding 2: the re-check after the dialog compares the whole
      // confirmation, not only which placeholders are in it.
      const paidX = () => {
        const state = useGraphStore.getState();
        useGraphStore.setState({ nodes: [...state.nodes, imageNode('x')],
          edges: [...state.edges, { id: 'e2', source: 'x', target: 'b', sourceHandle: 'image', targetHandle: 'image_input' }] });
      };

      it('asks again when an agent made the run cost more while the dialog was open, same placeholders', async () => {
        useUIStore.setState({ runCostConfirmUsd: 0.01 });
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
        askMock.mockImplementationOnce(async (model: unknown) => { paidX(); return model; }).mockImplementationOnce(yes);
        await useGraphStore.getState().executeNode('b');
        expect(askMock).toHaveBeenCalledTimes(2);
        expect(askMock.mock.calls[0][0].runLabel).toBe('Run for $1.20');
        expect(askMock.mock.calls[1][0].runLabel).toBe('Run for $1.80');
        expect(confirm).not.toHaveBeenCalled();
        expect(execute).toHaveBeenCalledOnce();
        expect((execute.mock.calls[0][0] as Array<{ id: string }>).map((node) => node.id)).toContain('x');
        expect(execute.mock.calls[0][6]).toEqual(['a']);
        expect(execute.mock.calls[0][7]).toBeCloseTo(1.8);
      });

      it('asks again when an agent changed the placeholder\'s model while the dialog was open', async () => {
        usePricingStore.setState({ table: { currencies: {}, nodes: {
          'nano-banana': { currency: 'usd', per: 'image', rows: [
            { match: { model: 'gemini-3-pro-image' }, price: 0.9 }, { match: {}, price: 0.6 }] },
        } } });
        const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
        askMock.mockImplementationOnce(async (model: unknown) => {
          useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((node) => node.id === 'a'
            ? { ...node, data: { ...node.data, params: { model: 'gemini-3-pro-image' } } } : node) });
          return model;
        }).mockResolvedValueOnce(null);
        await useGraphStore.getState().executeNode('b');
        expect(askMock).toHaveBeenCalledTimes(2);
        expect(askMock.mock.calls[1][0].rows[0].model).not.toBe(askMock.mock.calls[0][0].rows[0].model);
        expect(execute).not.toHaveBeenCalled();
      });

      // Review 5, H1: once the dialog has shown it stays the authority; the
      // costly-run setting and the browser's confirm never take over.
      it('asks again in the dialog when an agent made it normal and added a paid node meanwhile', async () => {
        useUIStore.setState({ runCostConfirmUsd: 0.01 });
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
        const execute = vi.spyOn(api, 'executeNode');
        askMock.mockImplementationOnce(async (model: unknown) => {
          paidX();
          useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((node) => node.id === 'a'
            ? { ...node, data: { ...node.data, pending: undefined } } : node) });
          return model;
        }).mockResolvedValueOnce(null);
        await useGraphStore.getState().executeNode('b');
        expect(askMock).toHaveBeenCalledTimes(2);
        expect(askMock.mock.calls[1][0]).toMatchObject({ heading: "Run with Codex's changes?", runLabel: 'Run for $1.80' });
        expect(confirm).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
      });

      it('with nothing else changed, that run goes ahead held to the total the person confirmed', async () => {
        useUIStore.setState({ runCostConfirmUsd: null });
        const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
        askMock.mockImplementation(async (model: unknown) => {
          useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((node) => node.id === 'a'
            ? { ...node, data: { ...node.data, pending: undefined } } : node) });
          return model;
        });
        await useGraphStore.getState().executeNode('b');
        expect(execute).toHaveBeenCalledOnce();
        expect(execute.mock.calls[0][6]).toEqual([]);
        expect(execute.mock.calls[0][7]).toBeCloseTo(1.2);
      });

      it("an accepted proposal's run never asks (it skips the placeholder)", async () => {
        useUIStore.setState({ runCostConfirmUsd: null });
        vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
        await useGraphStore.getState().executeNode('b', { approvalId: 'ap1' });
        expect(askMock).not.toHaveBeenCalled();
      });
    });

    it("an accepted proposal's run skips it, so it is not priced", async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      useUIStore.setState({ runCostConfirmUsd: 0.1 });
      await useGraphStore.getState().executeNode('b', { approvalId: 'ap1' });
      expect(confirm).not.toHaveBeenCalled();
    });

    it('a whole-canvas Run leaves the skipped nodes out of its cost', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      await useGraphStore.getState().executeGraph();
      expect(confirm).toHaveBeenCalledOnce();
      expect(confirm.mock.calls[0][0]).toContain('could cost up to $0.60');
      expect(confirm.mock.calls[0][0]).not.toContain('Includes');
    });

    it('Run selected leaves them out too', async () => {
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      useUIStore.setState({ runCostConfirmUsd: 1 });
      await useGraphStore.getState().executeCluster(['a', 'b', 'c']);
      // Only c runs: $0.60, under the $1 threshold.
      expect(confirm).not.toHaveBeenCalled();
    });
  });
});
