import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fieldCases from '../../backend/tests/fixtures/required_field_cases.json';

/**
 * Review 13, M-1 and L-6, with GM - Design's round-14 lines (item 1,
 * verbatim). Round 13 refused a Krea node whose required field was empty
 * reading only its definition, so three Krea copies that run on their
 * maker's own API with the person's key (GPT Image 2.5 Flare and Sunburst
 * with an OpenAI key, Grok Imagine 2.0 with an xAI key) were refused though
 * the run would go. The refusal now follows the route the run takes
 * (lib/directRoute.ts selectRoute, the backend's rule): the Krea gateway
 * needs every field; a maker's API only what it sizes by (Seedream on
 * BytePlus: width and height). With no usable route the key line comes first
 * (the backend's), so no field is named. The backend reads the same cases
 * (backend/tests/fixtures/required_field_cases.json).
 * GM, round 14, item 1: "Set" for typed values (width, height, a name),
 * "Choose" for pickers.
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

import { modelNotChosenText, unchosenOnRoute } from '../src/lib/placeholderRunConfirm';
import { useGraphStore } from '../src/store/graphStore';
import { usePricingStore } from '../src/store/pricingStore';
import { useUIStore } from '../src/store/uiStore';
import * as api from '../src/lib/api';

const node = (id: string, label: string, definitionId: string, params: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId, label, params, state: 'idle', outputs: {} } });
const KREA2 = 'krea-image-krea-krea-2-medium';
const TOPAZ = 'krea-enhance-topaz-standard-enhance';
const FLARE = 'krea-image-openai-gpt-image-2-5-flare';
const GROK = 'krea-image-xai-grok-imagine-2';
const KREA = { KREA_API_TOKEN: '(set)' };

describe('the route decides which field is refused (one case list with the backend)', () => {
  type Case = { name: string; definitionId: string; params: Record<string, unknown>; apiKeys: Record<string, string>;
    wired?: string[]; planReady?: boolean; expect: [string, string] | null };
  it.each((fieldCases.cases as Case[]).map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    expect(unchosenOnRoute(entry.definitionId, entry.params, {
      apiKeys: entry.apiKeys, wired: entry.wired ?? [], planReady: entry.planReady ?? false,
    })).toEqual(entry.expect);
  });
});

describe("GM - Design, round 14, item 1: the lines, verbatim", () => {
  const krea = { apiKeys: KREA, edges: [] };
  it('"Set" for a typed value', () => {
    expect(modelNotChosenText([node('n1', 'Clean plate', TOPAZ) as never], undefined, krea))
      .toBe('Nothing ran. Set a width for “Clean plate” first.');
    expect(modelNotChosenText([node('n1', 'Clean plate', TOPAZ, { width: 2048 }) as never], undefined, krea))
      .toBe('Nothing ran. Set a height for “Clean plate” first.');
    expect(modelNotChosenText([node('n1', 'My style', 'krea-style-train') as never], undefined, krea))
      .toBe('Nothing ran. Set a name for “My style” first.');
  });
  it('"Choose" for a picker', () => {
    expect(modelNotChosenText([node('n1', 'Hero', KREA2) as never], undefined, krea))
      .toBe('Nothing ran. Choose an aspect ratio for “Hero” first.');
    expect(modelNotChosenText([node('n1', 'Clean plate', TOPAZ, { width: 2048, height: 2048 }) as never], undefined, krea))
      .toBe('Nothing ran. Choose a model for “Clean plate” first.');
    expect(modelNotChosenText([node('n1', 'Lab app', 'krea-node-app') as never], undefined, krea))
      .toBe('Nothing ran. Choose a version for “Lab app” first.');
  });
  it('a wire into a Krea-only port keeps Grok on Krea, so its field is named', () => {
    const both = { apiKeys: { ...KREA, XAI_API_KEY: '(set)' } };
    const grok = node('n2', 'Grok', GROK) as never;
    expect(modelNotChosenText([grok], undefined, { ...both, edges: [] })).toBeNull();
    expect(modelNotChosenText([grok], undefined, { ...both,
      edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'image', targetHandle: 'style_images' }] as never }))
      .toBe('Nothing ran. Choose an aspect ratio for “Grok” first.');
  });
});

describe('every run path follows the route (M-1, L-6)', () => {
  const initialCache = useUIStore.getState().settingsCache;
  const initialThreshold = useUIStore.getState().runCostConfirmUsd;
  const notice = () => useGraphStore.getState().undoNotice?.text ?? useGraphStore.getState().messageNotice?.text ?? null;
  let started: ReturnType<typeof vi.fn>;
  const setCanvas = (definitionId: string, params: Record<string, unknown> = {}) => useGraphStore.setState({
    nodes: [node('n1', 'Prompt', 'text-input', { value: 'a fox' }), node('n2', 'Hero', definitionId, params)] as never,
    edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'text', targetHandle: 'prompt' }],
    undoStack: [], redoStack: [], runHistory: [], isExecuting: false, backendFreshStartPending: false,
    providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null, messageNotice: null } as never);
  const keys = (apiKeys: Record<string, string>, extra: Record<string, unknown> = {}) =>
    useUIStore.setState({ settingsCache: { apiKeys, loaded: true, ...extra }, runCostConfirmUsd: 0 } as never);

  beforeEach(() => {
    useGraphStore.getState().resetExecution();
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

  const paths = [
    ["a node's Run", () => useGraphStore.getState().executeNode('n2')],
    ["an accepted proposal's run", () => useGraphStore.getState().executeNode('n2', { approvalId: 'ap1' })],
    ['Run selected', () => useGraphStore.getState().executeCluster(['n1', 'n2'])],
    ["the toolbar's Run", () => useGraphStore.getState().executeGraph()],
    ["Creator Studio's run", () => useGraphStore.getState().executeClusterConcurrent(['n1', 'n2'])],
  ] as const;

  it.each(paths)('%s: GPT Image 2.5 Flare with an OpenAI key goes out, no refusal', async (_name, run) => {
    keys({ OPENAI_API_KEY: '(set)' });
    setCanvas(FLARE);
    await run();
    expect(started).toHaveBeenCalled();
    expect(notice() ?? '').not.toMatch(/^Nothing ran\./);
  });

  it.each(paths)('%s: Grok Imagine 2.0 with an xAI key goes out, no refusal', async (_name, run) => {
    keys({ XAI_API_KEY: '(set)' });
    setCanvas(GROK);
    await run();
    expect(started).toHaveBeenCalled();
    expect(notice() ?? '').not.toMatch(/^Nothing ran\./);
  });

  it.each(paths)('%s: GPT Image 2.5 Flare on the Krea token is refused before any dialog', async (_name, run) => {
    keys(KREA);
    setCanvas(FLARE);
    await run();
    expect(started).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(askMock).not.toHaveBeenCalled();
    expect(notice()).toBe('Nothing ran. Choose an aspect ratio for “Hero” first.');
  });

  it.each(paths)('%s: Topaz on the Krea token says "Set a width"', async (_name, run) => {
    keys(KREA);
    setCanvas(TOPAZ);
    await run();
    expect(started).not.toHaveBeenCalled();
    expect(notice()).toBe('Nothing ran. Set a width for “Hero” first.');
  });

  it.each(paths)('%s: Krea 2 Medium with no Krea token: no field line, the backend names the key (L-6)', async (_name, run) => {
    keys({});
    setCanvas(KREA2);
    await run();
    expect(notice() ?? '').not.toMatch(/Choose an aspect ratio/);
  });

  it('the plan: refused once signed in, not before (the sign-in line comes first)', async () => {
    setCanvas(KREA2, { _kreaAuth: 'mcp' });
    keys({}, { kreaConnection: { status: 'connected' } });
    await useGraphStore.getState().executeNode('n2');
    expect(notice()).toBe('Nothing ran. Choose an aspect ratio for “Hero” first.');
    expect(started).not.toHaveBeenCalled();
    useGraphStore.setState({ undoNotice: null, messageNotice: null } as never);
    keys({}, { kreaConnection: { status: 'disconnected' } });
    await useGraphStore.getState().executeNode('n2');
    expect(notice() ?? '').not.toMatch(/Choose an aspect ratio/);
  });

  it('settings not loaded yet: no field refusal from the canvas (the backend refuses on the route it knows)', async () => {
    useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false }, runCostConfirmUsd: 0 } as never);
    setCanvas(FLARE);
    await useGraphStore.getState().executeNode('n2');
    expect(notice() ?? '').not.toMatch(/^Nothing ran\./);
  });

  it('a replay from Run history follows the route too', async () => {
    keys({ OPENAI_API_KEY: '(set)' });
    setCanvas(FLARE);
    const snapshot = { nodes: [{ id: 'n1', definitionId: 'text-input', params: { value: 'a fox' } },
      { id: 'n2', definitionId: FLARE, params: {} }], edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'text', targetHandle: 'prompt' }] };
    useGraphStore.setState({ runHistory: [{ id: 'r1', status: 'failed', startedAt: 1, endedAt: 2, snapshot, targetNodeId: 'n2',
      nodeIds: ['n1', 'n2'] }] as never });
    await useGraphStore.getState().rerunHistoryRecord('r1');
    expect(started).toHaveBeenCalled();
    expect(notice() ?? '').not.toMatch(/^Nothing ran\./);
  });
});
