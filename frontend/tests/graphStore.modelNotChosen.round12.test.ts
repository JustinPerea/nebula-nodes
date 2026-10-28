import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GM - Design, round 12 addendum (b): Topaz Standard with no model chosen
 * can't run (Krea requires the model; the gateway refuses it). "If Nebula
 * can tell the run will be refused before the box opens, skip the box and
 * show the refusal straight away. Don't ask someone to approve a run that
 * can't go out." The refusal names the node and the field: "Nothing ran.
 * Choose a model for “Clean plate” first." Every run path: a node's Run (the
 * Inspector and the context menu call the same action), an accepted
 * proposal's run, Run selected, the toolbar's Run, Creator Studio's
 * concurrent cluster, and replays from Run history.
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

const TOPAZ = 'krea-enhance-topaz-standard-enhance';
const GM = 'Nothing ran. Choose a model for “Clean plate” first.';
/** Round 13 (GM: only the first missing field, in the card's order): Topaz
 * Standard's Width and Height come before its Model, so they are set. */
const SIZE = { width: 2048, height: 2048 };
const initialCache = useUIStore.getState().settingsCache;
const initialThreshold = useUIStore.getState().runCostConfirmUsd;
const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };

const node = (id: string, label: string, definitionId: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId, label, params, state: 'idle', outputs: {}, ...extra } });
const notice = () => useGraphStore.getState().undoNotice?.text ?? useGraphStore.getState().messageNotice?.text ?? null;

function setCanvas(topaz: ReturnType<typeof node>) {
  useGraphStore.setState({ nodes: [node('n1', 'Plate', 'image-input', { value: 'plate.png' }), topaz] as never,
    edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'image', targetHandle: 'image' }],
    undoStack: [], redoStack: [], runHistory: [], isExecuting: false, backendFreshStartPending: false,
    providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null, messageNotice: null } as never);
}

describe('a run with no model chosen is refused before any dialog (round 12 addendum b)', () => {
  let started: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useUIStore.setState({ settingsCache: { apiKeys: { KREA_API_TOKEN: 'set' }, loaded: true }, runCostConfirmUsd: 0 } as never);
    usePricingStore.setState({ table: { currencies: {}, nodes: {} } } as never);
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    askMock.mockReset();
    started = vi.fn();
    for (const call of ['executeNode', 'executeGraph', 'generateCinemaShot'] as const) {
      vi.spyOn(api, call).mockImplementation((async () => { started(call); return { status: 'started' }; }) as never);
    }
    vi.spyOn(window, 'confirm').mockReturnValue(true);
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

  it("an agent's paid placeholder: no dialog opens, GM's refusal shows, nothing is sent", async () => {
    setCanvas(node('n2', 'Clean plate', TOPAZ, { ...SIZE }, { pending: codex }));
    await useGraphStore.getState().executeNode('n2');
    expect(askMock).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(notice()).toBe(GM);
  });

  it.each([
    ["a node's Run (the Inspector and the context menu too)", () => useGraphStore.getState().executeNode('n2')],
    ["an accepted proposal's run", () => useGraphStore.getState().executeNode('n2', { approvalId: 'ap1' })],
    ['Run selected', () => useGraphStore.getState().executeCluster(['n1', 'n2'])],
    ["the toolbar's Run", () => useGraphStore.getState().executeGraph()],
    ["Creator Studio's run", () => useGraphStore.getState().executeClusterConcurrent(['n1', 'n2'])],
  ])('%s: refused with no costly-run confirm', async (_name, run) => {
    setCanvas(node('n2', 'Clean plate', TOPAZ, { ...SIZE }));
    await run();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(notice()).toBe(GM);
  });

  it('a replay from Run history: the saved node with no model is refused too', async () => {
    setCanvas(node('n2', 'Clean plate', TOPAZ, { ...SIZE }));
    const snapshot = { nodes: [{ id: 'n1', definitionId: 'image-input', params: { value: 'plate.png' } },
      { id: 'n2', definitionId: TOPAZ, params: { ...SIZE } }], edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'image', targetHandle: 'image' }] };
    for (const targetNodeId of ['n2', null]) {
      useGraphStore.setState({ runHistory: [{ id: 'r1', status: 'failed', startedAt: 1, endedAt: 2, snapshot, targetNodeId,
        nodeIds: ['n1', 'n2'] }] as never, undoNotice: null, messageNotice: null });
      await useGraphStore.getState().rerunHistoryRecord('r1');
      expect(started).not.toHaveBeenCalled();
      expect(notice()).toBe(GM);
    }
  });

  it('(control) a chosen model runs; a placeholder a whole-canvas run skips is not refused', async () => {
    setCanvas(node('n2', 'Clean plate', TOPAZ, { ...SIZE, model: 'CGI' }));
    await useGraphStore.getState().executeNode('n2');
    expect(started).toHaveBeenCalled();
    started.mockClear();
    useGraphStore.getState().resetExecution();
    setCanvas(node('n2', 'Clean plate', TOPAZ, { ...SIZE }, { pending: codex }));
    await useGraphStore.getState().executeGraph();
    expect(notice()).not.toBe(GM);
  });
});
