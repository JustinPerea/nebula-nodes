import { beforeEach, describe, expect, it, vi } from 'vitest';
import { noticeSpy } from '../helpers/noticeSpy';

/**
 * Round 14 of PR #114, GM's gap wording, verbatim:
 * - a failed param edit (an edit in flight when the connection drops, or a
 *   refused one): "Couldn't save “<param label>” for “<node>”. It's back to
 *   its last saved value." The second sentence goes when the value doesn't
 *   revert (a newer edit to the node is still on its way).
 * - a failed model change: "Couldn't change the model for “<node>”. It's
 *   still on <route label of current model>."
 * Until round 14 both went to the console only, and a failed param edit kept
 * the unsaved value on the card until the next sync silently replaced it.
 */

vi.mock('../../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(),
  getCachedBackendBaseUrl: () => 'http://localhost:8000',
}));

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as unknown as typeof fetch;
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
const alertMock = noticeSpy();

const { useGraphStore } = await import('../../src/store/graphStore');
const { setProjectContext } = await import('../../src/lib/projectContext');
const { resetBackendConnectionForTests } = await import('../../src/lib/backendConnection');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' } });
const textNode = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
  data: { label: 'Brief', definitionId: 'text-input', params: { value: 'saved' }, state: 'idle', outputs: {} } };
const router = { id: 'n4', type: 'dynamic-node', position: { x: 0, y: 600 },
  data: { label: 'Writer', definitionId: 'openrouter-universal', params: { model: 'openai/gpt-5' }, state: 'idle',
    outputs: {}, isDynamic: true } };
const value = () => useGraphStore.getState().nodes.find((node) => node.id === 'n1')?.data.params.value;
const alerted = () => alertMock.mock.calls.map(([text]) => text);
const edit = (text: string) => useGraphStore.getState().updateNodeData('n1', { params: { value: text } });

beforeEach(() => {
  vi.useRealTimers();
  fetchMock.mockReset();
  alertMock.mockClear();
  resetBackendConnectionForTests();
  setProjectContext({ id: 'A', revision: 'a' });
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [structuredClone(textNode), structuredClone(router)], edges: [], undoStack: [],
    redoStack: [], isExecuting: false, undoNotice: null, isImportingGraph: false } as never);
});

describe('a failed param edit', () => {
  it('the connection drops while it is sent: GM\'s line, and the value is back to the last saved one', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    edit('edited');
    expect(value()).toBe('edited');
    await vi.waitFor(() => expect(alerted()).toEqual(
      ["Couldn't save “Text” for “Brief”. It's back to its last saved value."]));
    expect(value()).toBe('saved');
  });

  it('a refused edit (409) reads the same and reverts', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'nope' }, 409));
    edit('edited');
    await vi.waitFor(() => expect(alerted()).toEqual(
      ["Couldn't save “Text” for “Brief”. It's back to its last saved value."]));
    expect(value()).toBe('saved');
  });

  it('the last saved value is the last one the backend took', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    edit('first');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    edit('second');
    await vi.waitFor(() => expect(alerted()).toHaveLength(1));
    expect(value()).toBe('first');
  });

  it('a newer edit is on its way: no revert, and the second sentence goes', async () => {
    let fail!: (reason: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    edit('first');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    edit('second'); // waits on the debounce
    fail(new TypeError('Failed to fetch'));
    await vi.waitFor(() => expect(alerted()).toEqual(["Couldn't save “Text” for “Brief”."]));
    expect(value()).toBe('second');
  });

  it('a saved edit says nothing', async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    edit('edited');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(alerted()).toEqual([]);
    expect(value()).toBe('edited');
  });
});

describe('a failed model change', () => {
  it('OpenRouter: GM\'s line names the node and the model it is still on', async () => {
    fetchMock.mockResolvedValueOnce(json({ detail: 'no key' }, 400));
    await useGraphStore.getState().configureOpenRouterModel('n4', 'anthropic/claude-x');
    expect(alerted()).toEqual(["Couldn't change the model for “Writer”. It's still on openai/gpt-5."]);
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'n4')?.data.params.model).toBe('openai/gpt-5');
  });

  it('Replicate: the same line', async () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => node.id !== 'n4' ? node
      : { ...node, data: { ...node.data, label: 'Upscaler', definitionId: 'replicate-universal', params: { model_id: 'acme/up' } } }) }));
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await useGraphStore.getState().fetchReplicateSchemaAndConfigure('n4', 'acme', 'other');
    expect(alerted()).toEqual(["Couldn't change the model for “Upscaler”. It's still on acme/up."]);
  });

  it('no model yet: only the first sentence', async () => {
    useGraphStore.setState((state) => ({ nodes: state.nodes.map((node) => node.id !== 'n4' ? node
      : { ...node, data: { ...node.data, params: {} } }) }));
    fetchMock.mockResolvedValueOnce(json({ detail: 'no key' }, 400));
    await useGraphStore.getState().configureOpenRouterModel('n4', 'anthropic/claude-x');
    expect(alerted()).toEqual(["Couldn't change the model for “Writer”."]);
  });
});
