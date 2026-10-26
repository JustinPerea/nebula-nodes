import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Review 15, round 16.
 * M-B (probe MB1): a run waiting for what its refusal reads (the settings,
 *   the Krea plan's sign-in: at most 4 s) counts as starting. A second Run
 *   while one waits does nothing, as a click during a run does today, on
 *   every entry: a node's Run, the canvas Run, Run selected, Creator's
 *   cluster, an accepted proposal's run, a Cinema shot. The Run controls
 *   show it as their disabled state (`runStarting`).
 * L-3 (MB5): the Krea plan's sign-in still "connecting" is not known yet:
 *   the run waits for it within the same 4 s.
 * L-4: a 409 re-ask that asks again after a route change prices at the
 *   409 answer's own estimate, so the confirmation it sends passes.
 * GM - Design round 16 (a): the re-ask after a route change says which
 *   nodes changed, and Run ignores clicks for its first 500 ms.
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
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import * as api from '../src/lib/api';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';

const PRICING = JSON.parse(readFileSync(resolve(__dirname, '../../backend/data/model_pricing.json'), 'utf8'));
const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };
const node = (id: string, label: string, definitionId: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId, label, params, state: 'idle', outputs: {}, ...extra } });
const notice = () => useGraphStore.getState().undoNotice?.text ?? useGraphStore.getState().messageNotice?.text ?? null;
const KREA2 = 'krea-image-krea-krea-2-medium';
const GROK = 'krea-image-xai-grok-imagine-2';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function setCanvas(target: ReturnType<typeof node>) {
  useGraphStore.setState({ nodes: [node('n1', 'Prompt', 'text-input', { value: 'a fox' }), node('n3', 'Ref', 'image-input', { value: 'a.png' }), target] as never,
    edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'text', targetHandle: 'prompt' }],
    undoStack: [], redoStack: [], runHistory: [], isExecuting: false, backendFreshStartPending: false,
    providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null, messageNotice: null } as never);
}
const wireStyle = () => useGraphStore.setState((s) => ({ edges: [...s.edges,
  { id: 'e2', source: 'n3', target: 'n2', sourceHandle: 'image', targetHandle: 'style_images' }] }) as never);
const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('round 16: a run waiting for its inputs counts as starting', () => {
  let started: ReturnType<typeof vi.fn>;
  const initialCache = useUIStore.getState().settingsCache;
  const initialThreshold = useUIStore.getState().runCostConfirmUsd;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    useGraphStore.getState().resetExecution();
    usePricingStore.setState({ table: { currencies: {}, nodes: {} } } as never);
    // The backend is slow: /api/settings never answers; anything else is offline.
    apiFetchMock.mockReset().mockImplementation((path: string) => path === '/api/settings'
      ? new Promise(() => {}) : Promise.reject(new TypeError('Offline fixture')));
    askMock.mockReset();
    started = vi.fn();
    for (const call of ['executeNode', 'executeGraph'] as const) {
      vi.spyOn(api, call).mockImplementation((async (...args: unknown[]) => { started(call, args); return { status: 'started' }; }) as never);
    }
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false }, runCostConfirmUsd: 0 } as never);
  });
  afterEach(async () => {
    await tick(5000);
    vi.useRealTimers();
    useGraphStore.getState().resetExecution();
    useUIStore.setState({ settingsCache: initialCache, runCostConfirmUsd: initialThreshold });
    usePricingStore.setState({ table: null });
    useCanvasProposalsStore.setState({ deferredRun: null });
    vi.restoreAllMocks();
  });

  it('MB1: Run clicked twice during the wait, the dialog left open: one dialog, one send', async () => {
    setCanvas(node('n2', 'Hero', KREA2, {}, { pending: codex }));
    const open: Array<() => void> = [];
    askMock.mockImplementation((model: unknown) => new Promise((resolve) => { open.push(() => resolve(model)); }));
    const first = useGraphStore.getState().executeNode('n2');
    await tick(300);
    const second = useGraphStore.getState().executeNode('n2');
    await tick(4600);
    expect(askMock).toHaveBeenCalledTimes(1);
    for (const yes of [...open]) yes();
    await Promise.all([first, second]);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('the wait shows on the Run controls (runStarting) and ends with it', async () => {
    setCanvas(node('n2', 'Hero', KREA2, {}, { pending: codex }));
    askMock.mockImplementation(async () => null);
    expect(useGraphStore.getState().runStarting).toBe(false);
    const run = useGraphStore.getState().executeNode('n2');
    await tick(10);
    expect(useGraphStore.getState().runStarting).toBe(true);
    await tick(4000);
    await run;
    expect(useGraphStore.getState().runStarting).toBe(false);
  });

  it.each([
    ['the canvas Run', () => useGraphStore.getState().executeGraph()],
    ['Run selected', () => useGraphStore.getState().executeCluster(['n1', 'n2'])],
    ["an accepted proposal's run", () => useGraphStore.getState().executeNode('n2', { approvalId: 'ap1' })],
  ] as const)('a node Run waits; %s meanwhile does nothing', async (_name, other) => {
    setCanvas(node('n2', 'Hero', KREA2));
    const first = useGraphStore.getState().executeNode('n2');
    await tick(300);
    const second = other();
    await tick(4000);
    await Promise.all([first, second]);
    expect(started.mock.calls.map((call) => call[0])).toEqual(['executeNode']);
  });

  it("Creator's concurrent cluster twice during the wait: one send, and the wait shows", async () => {
    // A control: two waits ended together, the second always met the first's
    // owner; it now does nothing at the click, as the others do.
    setCanvas(node('n2', 'Hero', KREA2));
    const first = useGraphStore.getState().executeClusterConcurrent(['n1', 'n2']);
    await tick(300);
    expect(useGraphStore.getState().runStarting).toBe(true);
    const second = useGraphStore.getState().executeClusterConcurrent(['n2']);
    await tick(4000);
    await Promise.all([first, second]);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it('MB3: the canvas Run twice during the wait: one confirm, one send', async () => {
    setCanvas(node('n2', 'Hero', KREA2));
    const first = useGraphStore.getState().executeGraph();
    await tick(300);
    const second = useGraphStore.getState().executeGraph();
    await tick(4000);
    await Promise.all([first, second]);
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("an agent's accepted run while a Run waits is kept for the person to run, as during a run", async () => {
    setCanvas(node('n2', 'Hero', KREA2));
    const first = useGraphStore.getState().executeNode('n2');
    await tick(300);
    useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n2'], approvalId: null } } as never);
    await useCanvasProposalsStore.getState().runDeferred();
    expect(useCanvasProposalsStore.getState().deferredRun).not.toBeNull();
    await tick(4000);
    await first;
  });

  it('a Cinema shot clicked twice during the wait: one dialog', async () => {
    // The shot waits because a Krea 2 node with no aspect ratio feeds its scene.
    const scene = { shots: [{ id: 's1', prompt: 'a fox', output: null }] };
    useGraphStore.setState({ nodes: [node('n2', 'Hero', KREA2, {}, { pending: codex }),
      node('c1', 'Scene', 'cinema-scene', { scene })] as never,
    edges: [{ id: 'e1', source: 'n2', target: 'c1', sourceHandle: 'image', targetHandle: 'character_refs' }],
    undoStack: [], redoStack: [], runHistory: [], isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] } as never);
    askMock.mockImplementation(async () => null);
    const first = useGraphStore.getState().executeShot('c1', 's1');
    await tick(300);
    expect(useGraphStore.getState().runStarting).toBe(true);
    const second = useGraphStore.getState().executeShot('c1', 's1');
    await tick(4000);
    await Promise.all([first, second]);
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().runStarting).toBe(false);
  });
});

describe('L-3: the Krea sign-in still connecting is waited for', () => {
  const initialCache = useUIStore.getState().settingsCache;
  let started: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    useGraphStore.getState().resetExecution();
    usePricingStore.setState({ table: { currencies: {}, nodes: {} } } as never);
    askMock.mockReset().mockImplementation(async (model: unknown) => model);
    started = vi.fn();
    vi.spyOn(api, 'executeNode').mockImplementation((async (...args: unknown[]) => { started(args); return { status: 'started' }; }) as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true, kreaConnection: { status: 'connecting' } }, runCostConfirmUsd: 0 } as never);
  });
  afterEach(async () => {
    await tick(5000);
    vi.useRealTimers();
    useGraphStore.getState().resetExecution();
    useUIStore.setState({ settingsCache: initialCache });
    usePricingStore.setState({ table: null });
    vi.restoreAllMocks();
  });

  it('MB5: connecting, then connected within the wait: the refusal shows with no dialog', async () => {
    let reads = 0;
    apiFetchMock.mockReset().mockImplementation(async (path: string) => {
      if (path === '/api/krea/connection') { reads += 1; return json({ status: reads < 2 ? 'connecting' : 'connected' }); }
      throw new TypeError('Offline fixture');
    });
    setCanvas(node('n2', 'Hero', KREA2, { _kreaAuth: 'mcp' }, { pending: codex }));
    const run = useGraphStore.getState().executeNode('n2');
    await tick(4100);
    await run;
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(askMock).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(notice()).toBe('Nothing ran. Choose an aspect ratio for “Hero” first.');
  });

  it('MB5 bound: still connecting after 4 s: asked as before (the backend refuses), never stuck', async () => {
    apiFetchMock.mockReset().mockImplementation(async (path: string) => {
      if (path === '/api/krea/connection') return json({ status: 'connecting' });
      throw new TypeError('Offline fixture');
    });
    setCanvas(node('n2', 'Hero', KREA2, { _kreaAuth: 'mcp' }, { pending: codex }));
    const run = useGraphStore.getState().executeNode('n2');
    await tick(4100);
    await run;
    expect(askMock).toHaveBeenCalledTimes(1);
    expect(useGraphStore.getState().runStarting).toBe(false);
  });
});

describe("L-4 and GM (a): a 409 re-ask after a route change prices at Nebula's own numbers and says what changed", () => {
  const initialCache = useUIStore.getState().settingsCache;
  let sends: Array<{ placeholders?: string[]; cost?: number }>;
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    usePricingStore.setState({ table: PRICING } as never);
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    askMock.mockReset();
    sends = [];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    useUIStore.setState({ settingsCache: { apiKeys: { XAI_API_KEY: 'x', KREA_API_TOKEN: 'k' }, loaded: true }, runCostConfirmUsd: 0 } as never);
  });
  afterEach(() => {
    useGraphStore.getState().resetExecution();
    useUIStore.setState({ settingsCache: initialCache });
    usePricingStore.setState({ table: null });
    vi.restoreAllMocks();
  });

  it('the second re-ask carries the 409 estimate and the send carries its amount', async () => {
    setCanvas(node('n2', 'Alt still', GROK, { aspect_ratio: '1:1', resolution: '1K' }, { pending: codex }));
    const message = 'Nothing ran. This run costs more than you confirmed.';
    vi.spyOn(api, 'executeNode').mockImplementation((async (...args: unknown[]) => {
      sends.push({ placeholders: args[6] as string[] | undefined, cost: args[7] as number | undefined });
      if (sends.length === 1) {
        throw new api.ExecutionStartRejectedError(message, 409, { detail: {
          code: 'placeholder_confirm_required', message, placeholders: ['n2'], agents: { n2: codex.agent },
          estimate: { low: 0.07, high: 0.07, nodes: { n2: { low: 0.07, high: 0.07 } }, unpriced: [], plan: [], plus: [], unavailable: {}, awaitingInput: [] },
        } });
      }
      return { status: 'started' };
    }) as never);
    // The re-ask's own canvas is the one the refused run sent; what moves its
    // route while it is open is the keys (the xAI key taken out: Krea's plan).
    const dropXai = () => useUIStore.setState({ settingsCache: { apiKeys: { KREA_API_TOKEN: 'k' }, loaded: true } } as never);
    askMock.mockImplementationOnce(async (model: unknown) => model)
      .mockImplementationOnce(async (model: unknown) => { dropXai(); return model; })
      .mockImplementationOnce(async (model: unknown) => model);
    await useGraphStore.getState().executeNode('n2');
    expect(askMock).toHaveBeenCalledTimes(3);
    const third = askMock.mock.calls[2][0] as PlaceholderRunConfirm;
    expect(third.rows.find((row) => row.nodeId === 'n2')?.price).toBe('$0.07');
    expect(third.confirmCost).toBe(0.07);
    expect(askMock.mock.calls[2][1]).toMatchObject({ changed: true, movedLine: '“Alt still” changed while this was open.' });
    expect(sends).toHaveLength(2);
    expect(sends[1].cost).toBe(0.07);
  });

  it('the other way: the 409 re-ask on Krea, an xAI key added meanwhile: asked again via xAI at the estimate', async () => {
    useUIStore.setState({ settingsCache: { apiKeys: { KREA_API_TOKEN: 'k' }, loaded: true } } as never);
    setCanvas(node('n2', 'Alt still', GROK, { aspect_ratio: '1:1', resolution: '1K' }, { pending: codex }));
    const message = 'Nothing ran. This run costs more than you confirmed.';
    vi.spyOn(api, 'executeNode').mockImplementation((async (...args: unknown[]) => {
      sends.push({ placeholders: args[6] as string[] | undefined, cost: args[7] as number | undefined });
      if (sends.length === 1) {
        throw new api.ExecutionStartRejectedError(message, 409, { detail: {
          code: 'placeholder_confirm_required', message, placeholders: ['n2'], agents: { n2: codex.agent },
          estimate: { low: 0.06, high: 0.06, nodes: { n2: { low: 0.06, high: 0.06 } }, unpriced: [], plan: [], plus: [], unavailable: {}, awaitingInput: [] },
        } });
      }
      return { status: 'started' };
    }) as never);
    const addXai = () => useUIStore.setState({ settingsCache: { apiKeys: { XAI_API_KEY: 'x', KREA_API_TOKEN: 'k' }, loaded: true } } as never);
    askMock.mockImplementationOnce(async (model: unknown) => model)
      .mockImplementationOnce(async (model: unknown) => { addXai(); return model; })
      .mockImplementationOnce(async (model: unknown) => model);
    await useGraphStore.getState().executeNode('n2');
    expect(askMock).toHaveBeenCalledTimes(3);
    const third = askMock.mock.calls[2][0] as PlaceholderRunConfirm;
    expect(third.rows.find((row) => row.nodeId === 'n2')?.model).toContain('Grok Imagine 2.0 via xAI');
    expect(third.rows.find((row) => row.nodeId === 'n2')?.price).toBe('$0.06');
    expect(askMock.mock.calls[2][1]).toMatchObject({ changed: true, movedLine: '“Alt still” changed while this was open.' });
  });

  it("the dialog's own re-ask after a route change names the node", async () => {
    setCanvas(node('n2', 'Alt still', GROK, { aspect_ratio: '1:1', resolution: '1K' }, { pending: codex }));
    vi.spyOn(api, 'executeNode').mockImplementation((async () => ({ status: 'started' })) as never);
    askMock.mockImplementationOnce(async (model: unknown) => { wireStyle(); return model; })
      .mockImplementationOnce(async (model: unknown) => model);
    await useGraphStore.getState().executeNode('n2');
    expect(askMock).toHaveBeenCalledTimes(2);
    expect(askMock.mock.calls[1][1]).toMatchObject({ changed: true, movedLine: '“Alt still” changed while this was open.' });
  });
});
