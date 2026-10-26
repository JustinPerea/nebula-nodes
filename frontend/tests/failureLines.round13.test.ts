import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Review 12, L-4, with GM - Design's round-13 lines (verbatim). A cancelled
 * step's held Cmd+Z goes to nothing, and the failure that cancelled it says
 * why. Three failures used to say nothing at all:
 * - chat /clear: "Couldn't clear the canvas. Nothing was removed." when the
 *   backend refused before clearing anything (a 4xx), else just "Couldn't
 *   clear the canvas." (a 5xx or no answer: the backend clears its graph
 *   before it saves it, so a failure there can come after the clear);
 * - the OpenRouter and Replicate model pickers: "Couldn't load the model
 *   settings for “X”." when reading the provider's settings failed (the
 *   backend marks that answer), else "Couldn't set up “X”.". The node's
 *   current settings stay as they were.
 */

const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; method: string }>,
  reply: null as null | ((path: string, method: string) => Response | Promise<Response>),
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    net.calls.push({ path, method });
    if (net.reply) return net.reply(path, method);
    return new Response('{}', { status: 200 });
  },
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn(), send: vi.fn() } }));

import { useGraphStore } from '../src/store/graphStore';
import { clearCanvasFromChat } from '../src/lib/chatCanvasClear';
import {
  CLEAR_FAILED_TEXT, CLEAR_REFUSED_TEXT, MODEL_SETTINGS_FAILURE, MODEL_SETTINGS_FAILURE_HEADER,
  modelSettingsFailedText, modelSetupFailedText,
} from '../src/lib/failureLines';

const initialGraph = useGraphStore.getState();
const store = () => useGraphStore.getState();
const shown = () => [store().undoNotice?.text, store().messageNotice?.text].filter(Boolean);
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function textNode(id: string) {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label: id, definitionId: 'text-input', params: { value: id }, state: 'idle', outputs: {} } };
}
function writer(id: string, definitionId: string, params: Record<string, unknown>) {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Writer', definitionId, params, state: 'idle', outputs: {} } };
}

describe("GM's failure lines (round 13), verbatim", () => {
  it('reads as GM wrote them', () => {
    expect(CLEAR_REFUSED_TEXT).toBe("Couldn't clear the canvas. Nothing was removed.");
    expect(CLEAR_FAILED_TEXT).toBe("Couldn't clear the canvas.");
    expect(modelSettingsFailedText('Writer')).toBe("Couldn't load the model settings for “Writer”.");
    expect(modelSetupFailedText('Writer')).toBe("Couldn't set up “Writer”.");
  });
});

describe('chat /clear that fails says so (L-4)', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.reply = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useGraphStore.setState({ nodes: [textNode('n1'), textNode('n2')], edges: [], undoStack: [], redoStack: [],
      undoNotice: null, messageNotice: null, isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] } as never);
  });
  afterEach(() => { vi.restoreAllMocks(); useGraphStore.setState(initialGraph, true); });

  it('refused before clearing (409, a run is going): both sentences; the canvas and the steps are as they were', async () => {
    net.reply = () => json(409, { detail: 'Stop the run first.' });
    await clearCanvasFromChat();
    await settle();
    expect(net.calls.some((call) => call.method === 'DELETE' && call.path === '/api/graph?force=true')).toBe(true);
    expect(shown()).toContain(CLEAR_REFUSED_TEXT);
    expect(store().nodes.map((node) => node.id)).toEqual(['n1', 'n2']);
    expect(store().undoStack).toHaveLength(0);
  });

  it('a server error (the graph may be cleared before its save failed): only the first sentence', async () => {
    net.reply = () => json(500, { detail: 'disk full' });
    await clearCanvasFromChat();
    await settle();
    expect(shown()).toContain(CLEAR_FAILED_TEXT);
    expect(shown()).not.toContain(CLEAR_REFUSED_TEXT);
  });

  it('no answer at all: only the first sentence', async () => {
    net.reply = () => { throw new TypeError('Failed to fetch'); };
    await clearCanvasFromChat();
    await settle();
    expect(shown()).toContain(CLEAR_FAILED_TEXT);
    expect(shown()).not.toContain(CLEAR_REFUSED_TEXT);
  });

  it('(control) a clear that goes through: no failure line, one step', async () => {
    net.reply = () => json(200, { status: 'cleared' });
    await clearCanvasFromChat();
    await settle();
    expect(shown().filter((text) => /Couldn't clear/.test(String(text)))).toEqual([]);
    expect(store().nodes).toEqual([]);
    expect(store().undoStack).toHaveLength(1);
  });

  it('ChatPanel clears through it', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const text = readFileSync(join(__dirname, '..', 'src', 'components', 'panels', 'ChatPanel.tsx'), 'utf8');
    expect(text).toMatch(/clearCanvasFromChat\(\)/);
    expect(text).not.toMatch(/api\/graph\?force=true/);
  });
});

describe('a model picker that fails says so, and the node keeps its settings (L-4)', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.reply = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); useGraphStore.setState(initialGraph, true); });

  const cases = [
    ['OpenRouter', 'openrouter-universal', { model: 'openai/gpt-4o-mini', temperature: 0.4 },
      (id: string) => store().configureOpenRouterModel(id, 'anthropic/claude-x')],
    ['Replicate', 'replicate-universal', { model_id: 'owner/old', prompt_strength: 0.8 },
      (id: string) => store().fetchReplicateSchemaAndConfigure(id, 'owner', 'new')],
  ] as const;

  for (const [name, definitionId, params, configure] of cases) {
    for (const id of ['n4', 'local-1']) {
      const where = id === 'n4' ? 'a backend node' : 'a node only this tab has';
      const set = () => useGraphStore.setState({ nodes: [writer(id, definitionId, { ...params })], edges: [],
        undoStack: [], redoStack: [], undoNotice: null, messageNotice: null, isExecuting: false,
        providerRecoveries: [], providerStartAmbiguities: [] } as never);

      it(`${name}, ${where}: reading the provider's settings failed: "Couldn't load the model settings"`, async () => {
        set();
        net.reply = (path) => /model$|universal\/ports$/.test(path)
          ? json(400, { detail: 'Nebula couldn’t reach the provider.' }, { [MODEL_SETTINGS_FAILURE_HEADER]: MODEL_SETTINGS_FAILURE })
          : json(200, {});
        await configure(id);
        await settle();
        expect(shown()).toContain(modelSettingsFailedText('Writer'));
        expect(store().nodes[0].data.params).toEqual(params);
        expect(store().undoStack).toHaveLength(0);
      });

      it(`${name}, ${where}: anything else: "Couldn't set up"`, async () => {
        set();
        net.reply = (path) => /model$|universal\/ports$/.test(path) ? json(409, { detail: 'It is running.' }) : json(200, {});
        await configure(id);
        await settle();
        expect(shown()).toContain(modelSetupFailedText('Writer'));
        expect(store().nodes[0].data.params).toEqual(params);
      });

      it(`${name}, ${where}: no answer: "Couldn't set up"`, async () => {
        set();
        net.reply = (path) => {
          if (/model$|universal\/ports$/.test(path)) throw new TypeError('Failed to fetch');
          return json(200, {});
        };
        await configure(id);
        await settle();
        expect(shown()).toContain(modelSetupFailedText('Writer'));
        expect(store().nodes[0].data.params).toEqual(params);
      });
    }
  }
});
