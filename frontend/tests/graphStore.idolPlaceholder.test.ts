import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GM, PR #203 r15 item 2, through the store: the person's run over an
 * agent's Idol placeholder reads the keys this tab loaded. With no token Idol
 * is free and the run goes ahead without the placeholder dialog; with one it
 * may cost, so the dialog asks first (graphStore directRunConfirm passes the
 * loaded keys to placeholderRunConfirm).
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

const PRICING = JSON.parse(readFileSync(resolve(__dirname, '../../backend/data/model_pricing.json'), 'utf8'));
const initialCache = useUIStore.getState().settingsCache;
const initialThreshold = useUIStore.getState().runCostConfirmUsd;
const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };

const nodes = [
  { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'image-input', label: 'Ref',
    params: { value: 'a.png' }, state: 'complete', outputs: { image: { type: 'Image', value: '/api/outputs/a.png' } } } },
  { id: 'n2', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'speridlabs-idol', label: 'Idol',
    params: {}, state: 'idle', outputs: {}, pending: codex } },
];
const edges = [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'image', targetHandle: 'image' }];

describe("the person's run over an agent's Idol placeholder, through the store", () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes, edges, undoStack: [], redoStack: [], runHistory: [], isExecuting: false,
      backendFreshStartPending: false, providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null } as never);
    useUIStore.setState({ runCostConfirmUsd: null } as never);
    usePricingStore.setState({ table: PRICING } as never);
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    askMock.mockReset().mockResolvedValue(null);
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

  it('no token: Idol is free, so no placeholder dialog; the run goes ahead', async () => {
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true } } as never);
    const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
    await useGraphStore.getState().executeNode('n2');
    expect(askMock).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('a token: Idol may cost, so the dialog asks first (and nothing runs on a no)', async () => {
    useUIStore.setState({ settingsCache: { apiKeys: { HF_TOKEN: 'set' }, loaded: true } } as never);
    const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
    await useGraphStore.getState().executeNode('n2');
    expect(askMock).toHaveBeenCalledOnce();
    expect(askMock.mock.calls[0][0].confirmIds).toEqual(['n2']);
    expect(execute).not.toHaveBeenCalled();
  });
});
