import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(), apiFetch: apiFetchMock, getCachedBackendBaseUrl: () => null }));
const askMock = vi.hoisted(() => vi.fn());
vi.mock('../src/components/askPlaceholderRun', () => ({ askPlaceholderRun: askMock }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { usePricingStore } from '../src/store/pricingStore';
import { useUIStore } from '../src/store/uiStore';
import * as api from '../src/lib/api';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';

/**
 * Review 17 (m2stale), decision: "the re-ask takes its label and its price
 * from the same route resolution, after the same bounded settings wait the
 * first ask uses." Nebula refuses a run at its own keys (the 409 estimate);
 * the tab named each row by the keys it read at load. Before the re-ask the
 * keys are read again, so a row never reads one route at another's price.
 */

const PRICING = JSON.parse(readFileSync(resolve(__dirname, '../../backend/data/model_pricing.json'), 'utf8'));
const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };
const GROK = 'krea-image-xai-grok-imagine-2';
const XAI = { XAI_API_KEY: 'x', KREA_API_TOKEN: 'k' };
const KREA = { KREA_API_TOKEN: 'k' };
const node = (id: string, label: string, definitionId: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId, label, params, state: 'idle', outputs: {}, ...extra } });
const estimate = (keys: Record<string, string>) => keys.XAI_API_KEY
  ? { low: 0.06, high: 0.06, nodes: { n2: { low: 0.06, high: 0.06 } }, unpriced: [], plan: [], plus: [], unavailable: {}, awaitingInput: [] }
  : { low: null, high: null, nodes: {}, unpriced: ['n2'], plan: [], plus: [], unavailable: {}, awaitingInput: [] };

const initialCache = useUIStore.getState().settingsCache;

async function run(tab: Record<string, string>, nebula: Record<string, string>, { settingsFail = false, maxAsks = 5 } = {}) {
  useUIStore.setState({ settingsCache: { apiKeys: tab, loaded: true }, runCostConfirmUsd: 0 } as never);
  useGraphStore.setState({
    nodes: [node('n1', 'Prompt', 'text-input', { value: 'a fox' }),
      node('n2', 'Alt still', GROK, { aspect_ratio: '1:1', resolution: '1K' }, { pending: codex })] as never,
    edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'text', targetHandle: 'prompt' }] as never,
    undoStack: [], redoStack: [], runHistory: [], isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [],
  } as never);
  apiFetchMock.mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/settings' && !settingsFail) return { ok: true, status: 200, json: async () => ({ apiKeys: nebula }) };
    throw new TypeError('Offline fixture');
  });
  const sends: { cost?: number; outcome: string }[] = [];
  vi.spyOn(api, 'executeNode').mockImplementation((async (...args: unknown[]) => {
    const placeholders = args[6] as string[] | undefined;
    const cost = args[7] as number | undefined;
    const e = estimate(nebula);
    // The first send is refused (as when the agent flagged its placeholder
    // after the first ask), then Nebula holds the run to its own numbers.
    const refuse = sends.length === 0 || !placeholders?.includes('n2') || (e.high !== null && (cost === undefined || e.high > cost));
    sends.push({ cost, outcome: refuse ? '409' : 'started' });
    if (refuse) {
      throw new api.ExecutionStartRejectedError('Nothing ran.', 409, { detail: { code: 'placeholder_confirm_required',
        message: 'Nothing ran.', placeholders: ['n2'], agents: { n2: codex.agent }, estimate: e } });
    }
    return { status: 'started' };
  }) as never);
  const asks: PlaceholderRunConfirm[] = [];
  askMock.mockImplementation(async (model: PlaceholderRunConfirm) => {
    asks.push(model);
    return asks.length > maxAsks ? null : model;
  });
  await useGraphStore.getState().executeNode('n2');
  const rows = asks.map((model) => model.rows.map((row) => `${row.model}|${row.price}`)[0]);
  return { asks, rows, sends };
}

beforeEach(() => {
  useGraphStore.getState().resetExecution();
  usePricingStore.setState({ table: PRICING } as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  useUIStore.setState({ settingsCache: initialCache });
  vi.restoreAllMocks();
});

describe('m2stale: the 409 re-ask names and prices each row on one route', () => {
  it('the tab read only Krea, Nebula has the xAI key: the re-ask reads via xAI at $0.06', async () => {
    const { rows, sends } = await run(KREA, XAI);
    expect(rows[0]).toBe('Grok Imagine 2.0 (Krea)|price not listed');
    expect(rows[1]).toBe('Grok Imagine 2.0 via xAI|$0.06');
    expect(sends.map((send) => send.outcome)).toEqual(['409', 'started']);
    expect(useUIStore.getState().settingsCache.apiKeys).toEqual(XAI);
  });

  it('the tab read xAI, Nebula has only Krea: the re-ask reads the Krea copy, price not listed', async () => {
    const { rows, sends } = await run(XAI, KREA);
    expect(rows[0]).toBe('Grok Imagine 2.0 via xAI|$0.06');
    expect(rows[1]).toBe('Grok Imagine 2.0 (Krea)|price not listed');
    expect(sends.map((send) => send.outcome)).toEqual(['409', 'started']);
  });

  it('keys that can’t be read: the re-ask keeps Nebula’s numbers, so the yes it sends passes', async () => {
    // Known residue (round 18 notes): with the keys unreadable, the row is
    // named by the route the tab last knew.
    const { rows, sends } = await run(KREA, XAI, { settingsFail: true, maxAsks: 2 });
    expect(rows[1]).toBe('Grok Imagine 2.0 (Krea)|$0.06');
    expect(sends.map((send) => send.outcome)).toEqual(['409', 'started']);
  });
});
