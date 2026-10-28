import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 12, L-7, with GM - Design's round-13 rule (verbatim): a Krea node
 * whose required field has no default and nothing chosen (Krea 2's Aspect
 * ratio, a Flux 1.1 Pro's Width, Topaz Standard's Model) never reaches Krea:
 * the gateway refuses it. The canvas never fills a value in (a new node and a
 * loaded graph keep nothing; the field reads "Choose…"), so the run is
 * refused before any dialog: "Nothing ran. Choose an aspect ratio for “X”
 * first." When several fields are missing, only the first in the card's
 * field order is named, so the notice stays one line; the model and version
 * refusals follow the same rule.
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

import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { modelNotChosenText, requiredFieldInventory } from '../src/lib/placeholderRunConfirm';
import { useGraphStore } from '../src/store/graphStore';
import { usePricingStore } from '../src/store/pricingStore';
import { useUIStore } from '../src/store/uiStore';
import * as api from '../src/lib/api';

const node = (id: string, label: string, definitionId: string, params: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId, label, params, state: 'idle', outputs: {} } });
const KREA2 = 'krea-image-krea-krea-2-medium';
const TOPAZ = 'krea-enhance-topaz-standard-enhance';
/** Round 14 (review 13, M-1): the field is refused on the route that needs it, the Krea gateway here. */
const ON_KREA = { apiKeys: { KREA_API_TOKEN: '(set)' }, edges: [] };

/** The same inventory backend/tests/test_required_fields_round13.py pins. */
const WH = [['width', 'width'], ['height', 'height']];
const AR = [['aspect_ratio', 'aspect ratio'], ['resolution', 'resolution']];
const INVENTORY: Record<string, string[][]> = {
  'krea-enhance-magnific-creative-enhance': WH,
  'krea-enhance-magnific-precise-enhance': WH,
  'krea-enhance-topaz-bloom-2-enhance': WH,
  'krea-enhance-topaz-bloom-enhance': WH,
  'krea-enhance-topaz-generative-enhance': WH,
  [TOPAZ]: [...WH, ['model', 'model']],
  'krea-enhance-topaz-wonder-35-enhance': WH,
  'krea-image-bfl-flux-1-1-pro': WH,
  'krea-image-bytedance-seedream-4': WH,
  'krea-image-bytedance-seedream-5-lite': WH,
  'krea-image-bytedance-seedream-5-pro': WH,
  'krea-image-krea-krea-2-large': AR,
  [KREA2]: AR,
  'krea-image-krea-krea-2-medium-turbo': AR,
  'krea-image-openai-gpt-image-2-5-flare': AR,
  'krea-image-openai-gpt-image-2-5-sunburst': AR,
  'krea-image-recraft-recraft-v4-1-flash': AR,
  'krea-image-xai-grok-imagine-2': AR,
  'krea-image-z-image-z-image': AR,
  'krea-node-app': [['node_app_version_id', 'version']],
  'krea-style-train': [['name', 'name']],
  'krea-video-alibaba-wan-2-1': WH,
  'krea-video-alibaba-wan-2-2': WH,
};

describe('the required-field refusal line (L-7, GM round 13)', () => {
  it('covers every Krea node with a required field that has no default (the backend pins the same list)', () => {
    expect(requiredFieldInventory()).toEqual(INVENTORY);
  });

  it("a new node of each keeps nothing in those fields: the canvas fills no value", () => {
    for (const [definitionId, fields] of Object.entries(INVENTORY)) {
      const definition = NODE_DEFINITIONS[definitionId];
      const specs = [...(definition.params ?? []), ...(definition.sharedParams ?? [])];
      for (const [key] of fields) {
        const spec = specs.find((param) => param.key === key);
        expect(spec, `${definitionId}.${key}`).toBeDefined();
        expect(spec?.default ?? null, `${definitionId}.${key}`).toBeNull();
      }
    }
  });

  it('names the aspect ratio, with "an"', () => {
    expect(modelNotChosenText([node('n2', 'Hero', KREA2, { aspect_ratio: null, resolution: null }) as never], undefined, ON_KREA))
      .toBe('Nothing ran. Choose an aspect ratio for “Hero” first.');
  });

  it('names only the first missing field, in the card order', () => {
    expect(modelNotChosenText([node('n2', 'Hero', KREA2, { aspect_ratio: '16:9' }) as never], undefined, ON_KREA))
      .toBe('Nothing ran. Choose a resolution for “Hero” first.');
    expect(modelNotChosenText([node('n3', 'Clean plate', TOPAZ, {}) as never], undefined, ON_KREA))
      // GM, round 14, item 1: a typed value is "Set".
      .toBe('Nothing ran. Set a width for “Clean plate” first.');
    expect(modelNotChosenText([node('n3', 'Clean plate', TOPAZ, { width: 2048, height: 2048 }) as never], undefined, ON_KREA))
      .toBe('Nothing ran. Choose a model for “Clean plate” first.');
    expect(modelNotChosenText([node('n4', 'Flare', 'krea-image-openai-gpt-image-2-5-flare', {}) as never], undefined, ON_KREA))
      .toBe('Nothing ran. Choose an aspect ratio for “Flare” first.');
  });

  it('nothing to say once every field has a value, or for a node outside the list', () => {
    expect(modelNotChosenText([node('n2', 'Hero', KREA2, { aspect_ratio: '16:9', resolution: '1K' }) as never], undefined, ON_KREA)).toBeNull();
    expect(modelNotChosenText([node('n5', 'Pic', 'nano-banana', {}) as never], undefined, ON_KREA)).toBeNull();
  });
});

describe('every run path refuses it before any dialog (L-7)', () => {
  const initialCache = useUIStore.getState().settingsCache;
  const initialThreshold = useUIStore.getState().runCostConfirmUsd;
  const notice = () => useGraphStore.getState().undoNotice?.text ?? useGraphStore.getState().messageNotice?.text ?? null;
  const GM = 'Nothing ran. Choose an aspect ratio for “Hero” first.';
  let started: ReturnType<typeof vi.fn>;
  const setCanvas = (params: Record<string, unknown>) => useGraphStore.setState({
    nodes: [node('n1', 'Prompt', 'text-input', { value: 'a fox' }), node('n2', 'Hero', KREA2, params)] as never,
    edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'text', targetHandle: 'prompt' }],
    undoStack: [], redoStack: [], runHistory: [], isExecuting: false, backendFreshStartPending: false,
    providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null, messageNotice: null } as never);

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

  it.each([
    ["a node's Run", () => useGraphStore.getState().executeNode('n2')],
    ["an accepted proposal's run", () => useGraphStore.getState().executeNode('n2', { approvalId: 'ap1' })],
    ['Run selected', () => useGraphStore.getState().executeCluster(['n1', 'n2'])],
    ["the toolbar's Run", () => useGraphStore.getState().executeGraph()],
    ["Creator Studio's run", () => useGraphStore.getState().executeClusterConcurrent(['n1', 'n2'])],
  ])('%s: refused, no dialog, nothing sent', async (_name, run) => {
    setCanvas({ aspect_ratio: null, resolution: null });
    await run();
    expect(askMock).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(notice()).toBe(GM);
  });

  it('a replay from Run history: refused too', async () => {
    setCanvas({ aspect_ratio: null, resolution: null });
    const snapshot = { nodes: [{ id: 'n1', definitionId: 'text-input', params: { value: 'a fox' } },
      { id: 'n2', definitionId: KREA2, params: {} }], edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'text', targetHandle: 'prompt' }] };
    useGraphStore.setState({ runHistory: [{ id: 'r1', status: 'failed', startedAt: 1, endedAt: 2, snapshot, targetNodeId: 'n2',
      nodeIds: ['n1', 'n2'] }] as never });
    await useGraphStore.getState().rerunHistoryRecord('r1');
    expect(started).not.toHaveBeenCalled();
    expect(notice()).toBe(GM);
  });

  it('(control) both fields chosen: the run goes out', async () => {
    setCanvas({ aspect_ratio: '16:9', resolution: '1K' });
    await useGraphStore.getState().executeNode('n2');
    expect(started).toHaveBeenCalled();
    expect(notice()).not.toBe(GM);
  });
});
