import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Review 14, M-B (probes D1-D5), round 15: never ask the person to approve a
 * run that can't go out (GM - Design). Before deciding, the canvas makes sure
 * it knows what the refusal reads: the keys (settings) and, for a run on the
 * Krea plan, the plan's sign-in, loading them when not loaded (a bounded
 * wait). Only when they still can't be known does it leave the refusal to the
 * backend, as before. On yes it checks the refusal again against the state at
 * that moment, and a route that changed while the dialog was open (so the
 * row's name or price) asks again with the new row rather than sending on
 * the old approval. Nebula's own refusal stays the last line.
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

const PRICING = JSON.parse(readFileSync(resolve(__dirname, '../../backend/data/model_pricing.json'), 'utf8'));
const codex = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };
const node = (id: string, label: string, definitionId: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  id, type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId, label, params, state: 'idle', outputs: {}, ...extra } });
const notice = () => useGraphStore.getState().undoNotice?.text ?? useGraphStore.getState().messageNotice?.text ?? null;
const GROK = 'krea-image-xai-grok-imagine-2';
const FLARE = 'krea-image-openai-gpt-image-2-5-flare';
const KREA2 = 'krea-image-krea-krea-2-medium';
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function setCanvas(target: ReturnType<typeof node>) {
  useGraphStore.setState({ nodes: [node('n1', 'Prompt', 'text-input', { value: 'a fox' }), node('n3', 'Ref', 'image-input', { value: 'a.png' }), target] as never,
    edges: [{ id: 'e1', source: 'n1', target: 'n2', sourceHandle: 'text', targetHandle: 'prompt' }],
    undoStack: [], redoStack: [], runHistory: [], isExecuting: false, backendFreshStartPending: false,
    providerRecoveries: [], providerStartAmbiguities: [], undoNotice: null, messageNotice: null } as never);
}
const wireStyle = () => useGraphStore.setState((s) => ({ edges: [...s.edges,
  { id: 'e2', source: 'n3', target: 'n2', sourceHandle: 'image', targetHandle: 'style_images' }] }) as never);

describe('review 14, M-B: the refusal is checked on what is known, and again on yes', () => {
  let started: ReturnType<typeof vi.fn>;
  const initialCache = useUIStore.getState().settingsCache;
  const initialThreshold = useUIStore.getState().runCostConfirmUsd;
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    usePricingStore.setState({ table: { currencies: {}, nodes: {} } } as never);
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    askMock.mockReset();
    started = vi.fn();
    for (const call of ['executeNode', 'executeGraph'] as const) {
      vi.spyOn(api, call).mockImplementation((async (...args: unknown[]) => { started(call, args); return { status: 'started' }; }) as never);
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

  describe('(1) the inputs are made known before deciding', () => {
    it('D1: settings not loaded: they are loaded first, and the refusal shows with no dialog', async () => {
      useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false }, runCostConfirmUsd: 0 } as never);
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path === '/api/settings') return json({ apiKeys: { KREA_API_TOKEN: '••••' } });
        throw new TypeError('Offline fixture');
      });
      setCanvas(node('n2', 'Hero', KREA2, {}, { pending: codex }));
      askMock.mockImplementation(async (model: unknown) => model);
      await useGraphStore.getState().executeNode('n2');
      expect(askMock).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      expect(notice()).toBe('Nothing ran. Choose an aspect ratio for “Hero” first.');
      expect(useUIStore.getState().settingsCache.loaded).toBe(true);
    });

    it('D1 control: the settings still can\'t be read: the dialog asks as before and the backend refuses', async () => {
      useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false }, runCostConfirmUsd: 0 } as never);
      setCanvas(node('n2', 'Hero', KREA2, {}, { pending: codex }));
      askMock.mockImplementation(async (model: unknown) => model);
      await useGraphStore.getState().executeNode('n2');
      expect(askMock).toHaveBeenCalledTimes(1);
      expect(started).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["the toolbar's Run", () => useGraphStore.getState().executeGraph()],
      ["an accepted proposal's run", () => useGraphStore.getState().executeNode('n2', { approvalId: 'ap1' })],
      ['Run selected', () => useGraphStore.getState().executeCluster(['n1', 'n2'])],
      ["Creator Studio's run", () => useGraphStore.getState().executeClusterConcurrent(['n1', 'n2'])],
    ] as const)('D1 on %s: settings loaded first, refused, nothing asked or sent', async (_name, run) => {
      useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false }, runCostConfirmUsd: 0 } as never);
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path === '/api/settings') return json({ apiKeys: { KREA_API_TOKEN: '••••' } });
        throw new TypeError('Offline fixture');
      });
      setCanvas(node('n2', 'Hero', KREA2));
      await run();
      expect(window.confirm).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      expect(notice()).toBe('Nothing ran. Choose an aspect ratio for “Hero” first.');
    });

    it('D2: the Krea plan\'s sign-in not known yet: it is read first, and the refusal shows with no dialog', async () => {
      useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true }, runCostConfirmUsd: 0 } as never);
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path === '/api/krea/connection') return json({ status: 'connected' });
        throw new TypeError('Offline fixture');
      });
      setCanvas(node('n2', 'Hero', KREA2, { _kreaAuth: 'mcp' }, { pending: codex }));
      askMock.mockImplementation(async (model: unknown) => model);
      await useGraphStore.getState().executeNode('n2');
      expect(askMock).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      expect(notice()).toBe('Nothing ran. Choose an aspect ratio for “Hero” first.');
      expect(useUIStore.getState().settingsCache.kreaConnection?.status).toBe('connected');
    });

    it('D2 control: read as not signed in: no field line (the sign-in line is the backend\'s)', async () => {
      useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: true }, runCostConfirmUsd: 0 } as never);
      apiFetchMock.mockImplementation(async (path: string) => {
        if (path === '/api/krea/connection') return json({ status: 'disconnected' });
        throw new TypeError('Offline fixture');
      });
      setCanvas(node('n2', 'Hero', KREA2, { _kreaAuth: 'mcp' }, { pending: codex }));
      askMock.mockImplementation(async (model: unknown) => model);
      await useGraphStore.getState().executeNode('n2');
      expect(notice() ?? '').not.toMatch(/Choose an aspect ratio/);
    });

    it('nothing to refuse (every field set): no settings read, the run starts in the same turn as before', async () => {
      useUIStore.setState({ settingsCache: { apiKeys: {}, loaded: false }, runCostConfirmUsd: 0 } as never);
      setCanvas(node('n2', 'Hero', KREA2, { aspect_ratio: '1:1', resolution: '1K' }));
      await useGraphStore.getState().executeNode('n2');
      expect(apiFetchMock).not.toHaveBeenCalledWith('/api/settings', expect.anything());
      expect(started).toHaveBeenCalledTimes(1);
    });
  });

  describe('(2) on yes the refusal is checked again, and a changed route asks again', () => {
    it('D3: Codex wires Style images while the dialog is open (the run moves to Krea): the refusal, nothing sent', async () => {
      useUIStore.setState({ settingsCache: { apiKeys: { XAI_API_KEY: 'x', KREA_API_TOKEN: 'k' }, loaded: true }, runCostConfirmUsd: 0 } as never);
      setCanvas(node('n2', 'Alt still', GROK, {}, { pending: codex }));
      askMock.mockImplementationOnce(async (model: unknown) => { wireStyle(); return model; });
      await useGraphStore.getState().executeNode('n2');
      expect(askMock).toHaveBeenCalledTimes(1);
      expect(started).not.toHaveBeenCalled();
      expect(notice()).toBe('Nothing ran. Choose an aspect ratio for “Alt still” first.');
    });

    it('D4: the OpenAI key is removed while the dialog is open (Krea token left): the refusal, nothing sent', async () => {
      useUIStore.setState({ settingsCache: { apiKeys: { OPENAI_API_KEY: 'o', KREA_API_TOKEN: 'k' }, loaded: true }, runCostConfirmUsd: 0 } as never);
      setCanvas(node('n2', 'Hero still', FLARE, {}, { pending: codex }));
      askMock.mockImplementationOnce(async (model: unknown) => { useUIStore.getState().setSettingsCache({ KREA_API_TOKEN: 'k' }); return model; });
      await useGraphStore.getState().executeNode('n2');
      expect(askMock).toHaveBeenCalledTimes(1);
      expect(started).not.toHaveBeenCalled();
      expect(notice()).toBe('Nothing ran. Choose an aspect ratio for “Hero still” first.');
    });

    it('D5 control: refused before the dialog when the state is known', async () => {
      useUIStore.setState({ settingsCache: { apiKeys: { KREA_API_TOKEN: 'k' }, loaded: true }, runCostConfirmUsd: 0 } as never);
      setCanvas(node('n2', 'Hero still', FLARE, {}, { pending: codex }));
      await useGraphStore.getState().executeNode('n2');
      expect(askMock).not.toHaveBeenCalled();
      expect(started).not.toHaveBeenCalled();
      expect(notice()).toBe('Nothing ran. Choose an aspect ratio for “Hero still” first.');
    });

    it('the route changes while the dialog is open but nothing refuses: asked again with the new row, then sent', async () => {
      usePricingStore.setState({ table: PRICING } as never);
      useUIStore.setState({ settingsCache: { apiKeys: { XAI_API_KEY: 'x', KREA_API_TOKEN: 'k' }, loaded: true }, runCostConfirmUsd: 0 } as never);
      setCanvas(node('n2', 'Alt still', GROK, { aspect_ratio: '1:1', resolution: '1K' }, { pending: codex }));
      askMock.mockImplementationOnce(async (model: unknown) => { wireStyle(); return model; })
        .mockImplementationOnce(async (model: unknown) => model);
      await useGraphStore.getState().executeNode('n2');
      expect(askMock).toHaveBeenCalledTimes(2);
      const first = askMock.mock.calls[0][0] as PlaceholderRunConfirm;
      const second = askMock.mock.calls[1][0] as PlaceholderRunConfirm;
      expect(first.rows.find((row) => row.nodeId === 'n2')?.model).toBe('Grok Imagine 2.0 via xAI');
      expect(second.rows.find((row) => row.nodeId === 'n2')?.model).toBe('Grok Imagine 2.0 (Krea)');
      expect(askMock.mock.calls[1][1]).toMatchObject({ changed: true });
      expect(started).toHaveBeenCalledTimes(1);
    });

    it("Nebula's 409 asks again; the key removed while that dialog is open: the refusal, not a second send", async () => {
      useUIStore.setState({ settingsCache: { apiKeys: { OPENAI_API_KEY: 'o', KREA_API_TOKEN: 'k' }, loaded: true }, runCostConfirmUsd: 0 } as never);
      setCanvas(node('n2', 'Hero still', FLARE, {}, { pending: codex }));
      const message = 'Nothing ran. This run includes 1 paid node Codex is still setting up, and Nebula asks before running those. Click “Run” again to review it.';
      vi.spyOn(api, 'executeNode').mockImplementation((async (...args: unknown[]) => {
        started('executeNode', args);
        throw new api.ExecutionStartRejectedError(message, 409, { detail: {
          code: 'placeholder_confirm_required', message, placeholders: ['n2'], agents: { n2: codex.agent },
          estimate: { low: null, high: null, nodes: {}, unpriced: ['n2'], plan: [], plus: [], unavailable: {}, awaitingInput: [] },
        } });
      }) as never);
      askMock.mockImplementationOnce(async (model: unknown) => model)
        .mockImplementationOnce(async (model: unknown) => { useUIStore.getState().setSettingsCache({ KREA_API_TOKEN: 'k' }); return model; });
      await useGraphStore.getState().executeNode('n2');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(started).toHaveBeenCalledTimes(1);
      expect(notice()).toBe('Nothing ran. Choose an aspect ratio for “Hero still” first.');
    });
  });
});
