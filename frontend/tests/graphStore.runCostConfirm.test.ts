import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiFetchMock,
  getCachedBackendBaseUrl: () => null,
}));
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
});
