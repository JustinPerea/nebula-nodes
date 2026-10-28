import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 4 of the Q133 confirm (Justin, 2026-10-25: a paid placeholder never
 * runs without the person's confirmation, and what runs never costs more than
 * they were shown), with GM - Design's round-5 rulings:
 * - H1: a price read from an input's size is measured for the dialog, which
 *   updates in place when it arrives;
 * - M1: Nebula's refusal carries its own estimate, and the canvas asks again
 *   with it ("This run changed since you last reviewed it."), never showing
 *   the refusal's "Click “Run” again" words, on a node's Run, a Cinema shot
 *   and a replay;
 * - GM 4: once the placeholder dialog showed, the browser's costly-run
 *   confirm never follows it for a run the person's confirmed total covers.
 */

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
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { usePricingStore } from '../src/store/pricingStore';
import { useUIStore } from '../src/store/uiStore';
import { useInputSizeStore } from '../src/store/inputSizeStore';
import * as api from '../src/lib/api';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';
import type { RunRecord } from '../src/lib/runHistory';

const initialCache = useUIStore.getState().settingsCache;
const initialThreshold = useUIStore.getState().runCostConfirmUsd;
const initialRequest = useInputSizeStore.getState().request;
const codexAgent = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const codex = { agent: codexAgent, at: 1 };
const CHANGED = { changed: true };
const scene = { version: 1, base: { model: 'nano-banana' }, aspectRatio: '16:9',
  shots: [{ id: 's1', prompt: 'a cat' }, { id: 's2', prompt: 'a dog' }] };

const imageNode = (id: string, pending = false) => ({ id, type: 'model-node', position: { x: 0, y: 0 },
  data: { definitionId: 'nano-banana', label: id === 'a' ? 'Hero still' : id, params: {}, state: 'idle', outputs: {},
    ...(pending ? { pending: codex } : {}) } });
const cinemaNode = () => ({ id: 'cine', type: 'cinema-scene', position: { x: 0, y: 0 },
  data: { definitionId: 'cinema-scene', label: 'Scene', params: { scene }, state: 'idle', outputs: {} } });

/** Nebula's refusal of the person's direct run (backend main._placeholder_confirm_refusal). */
function refusal(high: number, message = 'Nothing ran. This run includes 1 paid node Codex is still setting up, and Nebula asks before running those. Click “Run” again to review it.') {
  return new api.ExecutionStartRejectedError(message, 409, { detail: {
    code: 'placeholder_confirm_required', message, placeholders: ['a'], agents: { a: codexAgent },
    estimate: { low: high, high, nodes: { a: { low: high / 2, high: high / 2 }, b: { low: high / 2, high: high / 2 } },
      unpriced: [], plan: [], plus: [], unavailable: {}, awaitingInput: [] },
  } });
}

const errors = () => useGraphStore.getState().nodes.map((node) => node.data.error).filter(Boolean);

describe("review 4: the person's direct run over a paid placeholder", () => {
  beforeEach(() => {
    useGraphStore.getState().resetExecution();
    useGraphStore.setState({ nodes: [imageNode('a', true), imageNode('b'), cinemaNode()] as never,
      edges: [{ id: 'e1', source: 'a', target: 'b', sourceHandle: 'image', targetHandle: 'image_input' },
        { id: 'e2', source: 'a', target: 'cine', sourceHandle: 'image', targetHandle: 'character_refs' }],
      undoStack: [], redoStack: [], runHistory: [], isExecuting: false, backendFreshStartPending: false,
      providerRecoveries: [], providerStartAmbiguities: [] } as never);
    useUIStore.setState({ settingsCache: { apiKeys: { GOOGLE_API_KEY: 'set' }, loaded: true }, runCostConfirmUsd: null });
    usePricingStore.setState({ table: { currencies: {}, nodes: {
      'nano-banana': { currency: 'usd', per: 'image', rows: [{ match: {}, price: 0.6 }] },
    } } } as never);
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
    useInputSizeStore.setState({ sizes: {}, request: initialRequest });
    vi.restoreAllMocks();
  });

  describe("M1: Nebula's refusal re-opens the dialog with its own numbers", () => {
    it("a node's Run asks again with Nebula's total and the changed line, then runs at it, with no error", async () => {
      askMock.mockImplementation(yes);
      const execute = vi.spyOn(api, 'executeNode')
        .mockRejectedValueOnce(refusal(4.8)).mockResolvedValueOnce({ status: 'started' } as never);
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[0][1]?.changed).toBeFalsy();
      expect(askMock.mock.calls[1][1]).toMatchObject(CHANGED);
      expect(askMock.mock.calls[1][0]).toMatchObject({
        totalLine: 'This run could cost up to $4.80 at list prices.', runLabel: 'Run for $4.80', confirmIds: ['a'] });
      expect(execute).toHaveBeenCalledTimes(2);
      expect(execute.mock.calls[1][3]).toBe(execute.mock.calls[0][3]); // the same run, sent again
      expect(execute.mock.calls[1][6]).toEqual(['a']);
      expect(execute.mock.calls[1][7]).toBe(4.8);
      expect(errors()).toEqual([]);
    });

    it('Cancel on the re-ask runs nothing, shows no refusal and leaves the placeholder as it was', async () => {
      askMock.mockImplementationOnce(yes).mockResolvedValueOnce(null);
      const execute = vi.spyOn(api, 'executeNode').mockRejectedValueOnce(refusal(4.8));
      await useGraphStore.getState().executeNode('b');
      expect(execute).toHaveBeenCalledOnce();
      expect(errors()).toEqual([]);
      expect(useGraphStore.getState().isExecuting).toBe(false);
      expect(useGraphStore.getState().nodes.find((node) => node.id === 'a')!.data.pending).toBeTruthy();
      expect(useGraphStore.getState().nodes.every((node) => node.data.state !== 'queued')).toBe(true);
    });

    it('a run the tab thought had no paid placeholder asks first when Nebula says it has one (no changed line)', async () => {
      // The tab hasn't heard of the flag yet.
      useGraphStore.setState({ nodes: [imageNode('a'), imageNode('b'), cinemaNode()] as never });
      askMock.mockImplementation(yes);
      const execute = vi.spyOn(api, 'executeNode')
        .mockRejectedValueOnce(refusal(1.2)).mockResolvedValueOnce({ status: 'started' } as never);
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledOnce();
      expect(askMock.mock.calls[0][1]?.changed).toBeFalsy();
      expect(askMock.mock.calls[0][0]).toMatchObject({ heading: 'Run 1 node Codex is still setting up?', confirmIds: ['a'] });
      expect(execute.mock.calls[1][7]).toBe(1.2);
      expect(errors()).toEqual([]);
    });

    it('a Cinema shot asks again the same way, and the shot never shows the refusal', async () => {
      askMock.mockImplementation(yes);
      const shot = vi.spyOn(api, 'generateCinemaShot')
        .mockRejectedValueOnce(refusal(9.6, 'Nothing ran. This run includes 1 paid node Codex is still setting up, and Nebula asks before running those. Generate again to review it.'))
        .mockResolvedValueOnce({ status: 'started' });
      await useGraphStore.getState().executeShot('cine', 's1', undefined, 2);
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[1][1]).toMatchObject(CHANGED);
      expect(shot).toHaveBeenCalledTimes(2);
      expect(shot.mock.calls[1][8]).toBe(9.6);
      const cine = useGraphStore.getState().nodes.find((node) => node.id === 'cine')!;
      const s1 = (cine.data.params as { scene: { shots: Array<{ id: string; output?: { status?: string; error?: string } }> } })
        .scene.shots.find((candidate) => candidate.id === 's1');
      expect(s1?.output?.status).toBe('running');
      expect(s1?.output?.error).toBeUndefined();
    });

    it('a replay asks again the same way', async () => {
      const record: RunRecord = { id: 'saved-node', trigger: 'node', status: 'complete', startedAt: 1, targetNodeId: 'b',
        snapshot: { nodes: [
          { id: 'a', definitionId: 'nano-banana', params: {}, outputs: {} },
          { id: 'b', definitionId: 'nano-banana', params: {}, outputs: {} },
        ], edges: [{ id: 'e1', source: 'a', sourceHandle: 'image', target: 'b', targetHandle: 'image_input' }] } };
      useGraphStore.setState({ runHistory: [record] });
      askMock.mockImplementation(yes);
      const execute = vi.spyOn(api, 'executeNode')
        .mockRejectedValueOnce(refusal(4.8)).mockResolvedValueOnce({ status: 'started' } as never);
      await useGraphStore.getState().rerunHistoryRecord('saved-node');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[1][1]).toMatchObject(CHANGED);
      expect(execute.mock.calls[1][7]).toBe(4.8);
      expect(errors()).toEqual([]);
    });

    it('any other refusal still shows as before', async () => {
      askMock.mockImplementation(yes);
      vi.spyOn(api, 'executeNode').mockRejectedValueOnce(new api.ExecutionStartRejectedError('Busy.', 409, { detail: 'Busy.' }));
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledOnce();
      expect(errors().length).toBeGreaterThan(0);
    });
  });

  describe('M3 / GM: the dialog re-asked over a changed run says so', () => {
    it('the second ask after an agent changed the run carries the changed line', async () => {
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementationOnce(async (model: unknown) => {
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((node) => node.id === 'a'
          ? { ...node, data: { ...node.data, params: { model: 'gemini-3-pro-image' } } } : node) as never });
        return model;
      }).mockImplementationOnce(yes);
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledTimes(2);
      expect(askMock.mock.calls[0][1]?.changed).toBeFalsy();
      expect(askMock.mock.calls[1][1]).toMatchObject(CHANGED);
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  describe('H1: a price read from the input file', () => {
    beforeEach(() => {
      usePricingStore.setState({ table: JSON.parse(readFileSync(`${__dirname}/../../backend/data/model_pricing.json`, 'utf8')) } as never);
      useUIStore.setState({ settingsCache: { apiKeys: { BFL_API_KEY: 'set' }, loaded: true } } as never);
      useGraphStore.setState({ nodes: [
        { id: 'v', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'video-input', label: 'Clip',
          params: { filePath: '/clips/long-1080p.mp4' }, state: 'idle', outputs: {} } },
        { id: 'u', type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId: 'flux-video-upscale', label: 'Upscale',
          params: {}, state: 'idle', outputs: {}, pending: codex } },
      ] as never, edges: [{ id: 'e1', source: 'v', target: 'u', sourceHandle: 'video', targetHandle: 'video' }] });
    });

    it('asks for the clip\'s size, updates the open dialog when it arrives, and runs at the measured price', async () => {
      const request = vi.fn();
      useInputSizeStore.setState({ sizes: {}, request });
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      const shown: PlaceholderRunConfirm[] = [];
      askMock.mockImplementation(async (model: PlaceholderRunConfirm, options?: { watch?: (show: (next: PlaceholderRunConfirm) => void) => () => void }) => {
        shown.push(model);
        const stop = options?.watch?.((next) => shown.push(next));
        useInputSizeStore.setState({ sizes: { '/clips/long-1080p.mp4': { width: 1920, height: 1080, seconds: 60, frames: 1440 } } });
        stop?.();
        return shown[shown.length - 1]; // clicked on the measured words
      });
      await useGraphStore.getState().executeNode('u');
      expect(request).toHaveBeenCalledWith([{ ref: '/clips/long-1080p.mp4', kind: 'Video' }]);
      // GM - Design, round 6, item 2: the row says so while its input is measured.
      expect(shown[0].rows[0].price).toBe('price depends on its input');
      const measured = shown[shown.length - 1];
      expect(measured.rows[0].price).toMatch(/^\$\d/);
      expect(measured.confirmCost).toBeGreaterThan(1);
      // One dialog: the price changed in place, so no second ask.
      expect(askMock).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0][7]).toBe(measured.confirmCost);
    });
  });

  describe("GM 4: one dialog, never the browser's confirm after it", () => {
    it('an agent clearing its placeholder mid-dialog runs at the total the person confirmed, with no second dialog', async () => {
      useUIStore.setState({ runCostConfirmUsd: 0.01 });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      const execute = vi.spyOn(api, 'executeNode').mockResolvedValue({ status: 'started' } as never);
      askMock.mockImplementation(async (model: unknown) => {
        useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((node) => node.id === 'a'
          ? { ...node, data: { ...node.data, pending: undefined } } : node) as never });
        return model;
      });
      await useGraphStore.getState().executeNode('b');
      expect(askMock).toHaveBeenCalledOnce();
      expect(confirm).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledOnce();
    });

    it('a shot with a paid placeholder never also asks the browser', async () => {
      useUIStore.setState({ runCostConfirmUsd: 0.01 });
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      askMock.mockImplementation(yes);
      vi.spyOn(api, 'generateCinemaShot').mockResolvedValue({ status: 'started' });
      await useGraphStore.getState().executeShot('cine', 's1', undefined, 2);
      expect(askMock).toHaveBeenCalledOnce();
      expect(confirm).not.toHaveBeenCalled();
    });
  });

  describe("M1: the tab's keys are read again before it asks", () => {
    it('asks App for a fresh copy of the settings when the dialog opens', async () => {
      const refresh = vi.fn();
      window.addEventListener('nebula:settings-refresh', refresh);
      askMock.mockResolvedValue(null);
      await useGraphStore.getState().executeNode('b');
      window.removeEventListener('nebula:settings-refresh', refresh);
      expect(refresh).toHaveBeenCalledOnce();
    });
  });
});
