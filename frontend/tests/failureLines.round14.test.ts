import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Round 14 (review 13, L-5): the model picker's answer says which failure it
 * was. "Couldn't load the model settings for “X”." only when reading the
 * provider's settings failed; a missing key names the key to add, after
 * GM's "Couldn't set up “X”."; a malformed id is "Couldn't set up “X”.".
 *
 * (Round 13's header, kept below for the shared mocks:) Review 12, L-4, with GM - Design's round-13 lines (verbatim). A cancelled
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
import {
  MISSING_KEY_FAILURE, MODEL_SETTINGS_FAILURE, MODEL_SETTINGS_FAILURE_HEADER,
  modelKeyMissingText, modelSettingsFailedText,
} from '../src/lib/failureLines';

const initialGraph = useGraphStore.getState();
const store = () => useGraphStore.getState();
const shown = () => [store().undoNotice?.text, store().messageNotice?.text].filter(Boolean);
const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 5)); };
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function writer(id: string, definitionId: string, params: Record<string, unknown>) {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { label: 'Writer', definitionId, params, state: 'idle', outputs: {} } };
}

describe('the model picker names the failure (L-5)', () => {
  beforeEach(() => {
    net.calls.length = 0;
    net.reply = null;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); useGraphStore.setState(initialGraph, true); });
  const cases = [
    ['OpenRouter', 'openrouter-universal', { model: 'openai/gpt-4o-mini' }, 'OpenRouter API key',
      (id: string) => store().configureOpenRouterModel(id, 'anthropic/claude-x')],
    // GM - Design, round 15, item 1, then PR #203 r26 item 5: "Replicate token".
    ['Replicate', 'replicate-universal', { model_id: 'owner/old' }, 'Replicate token',
      (id: string) => store().fetchReplicateSchemaAndConfigure(id, 'owner', 'new')],
  ] as const;
  const set = (id: string, definitionId: string, params: Record<string, unknown>) => useGraphStore.setState({
    nodes: [writer(id, definitionId, { ...params })], edges: [], undoStack: [], redoStack: [], undoNotice: null,
    messageNotice: null, isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] } as never);
  for (const [name, definitionId, params, phrase, configure] of cases) {
    for (const id of ['n4', 'local-1']) {
      it(`${name} (${id}): a missing key names the key to add`, async () => {
        set(id, definitionId, params);
        net.reply = (path) => /model$|universal\/ports$/.test(path)
          ? json(400, { detail: 'Nebula can’t read it because the key isn’t set.' }, { [MODEL_SETTINGS_FAILURE_HEADER]: MISSING_KEY_FAILURE })
          : json(200, {});
        await configure(id);
        await settle();
        expect(shown()).toContain(`Couldn't set up “Writer”. Add your ${phrase} in Settings.`);
        expect(shown()).not.toContain(modelSettingsFailedText('Writer'));
        expect(store().nodes[0].data.params).toEqual(params);
      });
      it(`${name} (${id}): no header (a malformed id): "Couldn't change the model"`, async () => {
        set(id, definitionId, params);
        net.reply = (path) => /model$|universal\/ports$/.test(path)
          ? json(400, { detail: 'A Replicate model_id is owner/name.' }) : json(200, {});
        await configure(id);
        await settle();
        // Round 21 (the #114 merge): #114's GM line for a failed model change
        // (channel round 14) where neither of #195's two lines applies.
        expect(shown().join('\n')).toContain("Couldn't change the model for “Writer”.");
      });
      it(`${name} (${id}): a failed read: "Couldn't load the model settings"`, async () => {
        set(id, definitionId, params);
        net.reply = (path) => /model$|universal\/ports$/.test(path)
          ? json(400, { detail: 'Nebula couldn’t reach it.' }, { [MODEL_SETTINGS_FAILURE_HEADER]: MODEL_SETTINGS_FAILURE })
          : json(200, {});
        await configure(id);
        await settle();
        expect(shown()).toContain(modelSettingsFailedText('Writer'));
      });
    }
  }
  it('the key line', () => {
    expect(modelKeyMissingText('Writer', ['OPENROUTER_API_KEY'])).toBe("Couldn't set up “Writer”. Add your OpenRouter API key in Settings.");
    expect(MISSING_KEY_FAILURE).toBe('missing-key');
  });
});
