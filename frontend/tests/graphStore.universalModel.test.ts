/**
 * The universal-node model pickers ask the backend (POST
 * /api/graph/node/{id}/model) for the model's ports and params, and a sync
 * from the backend keeps what it doesn't hold (the Inspector's Replicate
 * controls). The backend's own rules are pinned in
 * backend/tests/test_universal_ports.py.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { DynamicNodeData, NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
const backend = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: unknown }>,
  answer: null as null | ((path: string, body: unknown) => Response),
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    backend.calls.push({ path, body });
    if (backend.answer) return Promise.resolve(backend.answer(path, body));
    return Promise.reject(new Error('offline'));
  },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

function universal(id: string, definitionId: string, params: Record<string, unknown>,
  extra: Partial<DynamicNodeData> = {}): Node<NodeData> {
  return {
    id, type: 'dynamic-node', position: { x: 0, y: 0 },
    data: {
      label: definitionId, definitionId, params, state: 'idle', outputs: {}, isDynamic: true,
      providerType: definitionId === 'replicate-universal' ? 'replicate' : 'openrouter',
      dynamicInputPorts: [], dynamicOutputPorts: [], dynamicParams: [], providerMeta: {}, ...extra,
    } as unknown as NodeData,
  };
}
const edge = (id: string, source: string, sourceHandle: string, target: string, targetHandle: string): Edge => ({
  id, source, sourceHandle, target, targetHandle, type: 'typed-edge',
});
const dataOf = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)?.data as unknown as DynamicNodeData;

function sync(nodes: Node<NodeData>[], edges: Edge[] = []) {
  const event = { type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes, edges, empty: false } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}

const VISION = {
  params: { model: 'openai/gpt-4o', temperature: 0.4, _output_image: false,
    _model_ports: { model: 'openai/gpt-4o', inputs: [], outputs: [] } },
  dynamicInputPorts: [
    { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
    { id: 'images', label: 'Images', dataType: 'Image', required: false, multiple: true },
  ],
  dynamicOutputPorts: [{ id: 'text', label: 'Text', dataType: 'Text', required: false }],
  dynamicParams: [], providerMeta: {}, removedEdges: [],
};

beforeEach(() => {
  backend.calls.length = 0;
  backend.answer = null;
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [] });
});

describe('the OpenRouter / Nous picker', () => {
  it('asks the backend and draws the ports it answers', async () => {
    useGraphStore.setState({
      nodes: [universal('n3', 'openrouter-universal', { model: 'anthropic/claude-sonnet-4.5', temperature: 0.4 })],
      edges: [edge('e1', 'n1', 'text', 'n3', 'messages'), edge('e2', 'n3', 'image', 'n4', 'image')],
    });
    backend.answer = () => json(VISION);

    await useGraphStore.getState().configureOpenRouterModel('n3', 'openai/gpt-4o');

    expect(backend.calls).toEqual([{ path: '/api/graph/node/n3/model', body: { model: 'openai/gpt-4o' } }]);
    const data = dataOf('n3');
    expect(data.params).toEqual(VISION.params);
    expect(data.modelId).toBe('openai/gpt-4o');
    expect(data.dynamicInputPorts.map((p) => p.id)).toEqual(['messages', 'images']);
    // The wire from a port the model doesn't have goes, as the backend dropped it.
    expect(useGraphStore.getState().edges.map((e) => e.id)).toEqual(['e1']);
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
  });

  it('leaves the node as it was when the backend refuses', async () => {
    const before = universal('n3', 'openrouter-universal', { model: '' });
    useGraphStore.setState({ nodes: [before], edges: [] });
    backend.answer = () => json({ detail: "Nebula can't read OpenRouter's model list" }, 400);

    await useGraphStore.getState().configureOpenRouterModel('n3', 'openai/gpt-4o');

    expect(dataOf('n3').params).toEqual({ model: '' });
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
  });

  it('works out a node the backend lacks with the ports route', async () => {
    useGraphStore.setState({ nodes: [universal('tmp-1', 'openrouter-universal', { model: '' })], edges: [] });
    backend.answer = () => json({ inputs: VISION.dynamicInputPorts, outputs: VISION.dynamicOutputPorts,
      nodeParams: VISION.params, providerMeta: {} });

    await useGraphStore.getState().configureOpenRouterModel('tmp-1', 'openai/gpt-4o');

    expect(backend.calls[0]).toEqual({ path: '/api/universal/ports',
      body: { definitionId: 'openrouter-universal', model: 'openai/gpt-4o', params: { model: '' } } });
    expect(dataOf('tmp-1').dynamicInputPorts.map((p) => p.id)).toEqual(['messages', 'images']);
  });
});

describe('the Replicate picker', () => {
  const answer = {
    params: { model_id: 'black-forest-labs/flux-kontext-pro', prompt: 'dusk', _version_id: 'v1', _schema_fetched: true },
    dynamicInputPorts: [{ id: 'input_image', label: 'Input Image', dataType: 'Image', required: false }],
    dynamicOutputPorts: [{ id: 'image', label: 'Output', dataType: 'Image', required: false }],
    dynamicParams: [{ key: 'prompt', label: 'Prompt', type: 'string', required: true, placeholder: '' }],
    providerMeta: { version_id: 'v1', description: 'Edit images' },
    removedEdges: [],
  };

  it('sets the schema from the backend and keeps its controls through a sync', async () => {
    const start = universal('n7', 'replicate-universal', { model_id: 'black-forest-labs/flux-kontext-pro' },
      { providerMeta: { note: 'kept' } });
    useGraphStore.setState({ nodes: [start], edges: [edge('e1', 'n2', 'image', 'n7', 'old_input')] });
    backend.answer = () => json(answer);

    await useGraphStore.getState().fetchReplicateSchemaAndConfigure('n7', 'black-forest-labs', 'flux-kontext-pro');

    expect(backend.calls[0]).toEqual({ path: '/api/graph/node/n7/model',
      body: { model: 'black-forest-labs/flux-kontext-pro' } });
    expect(dataOf('n7').dynamicParams).toEqual(answer.dynamicParams);
    expect(dataOf('n7').providerMeta).toEqual({ note: 'kept', version_id: 'v1', description: 'Edit images' });
    expect(useGraphStore.getState().edges).toEqual([]);

    // The backend's sync carries the ports but no Inspector controls.
    sync([universal('n7', 'replicate-universal', answer.params, {
      dynamicInputPorts: answer.dynamicInputPorts, dynamicOutputPorts: answer.dynamicOutputPorts })]);
    expect(dataOf('n7').dynamicParams).toEqual(answer.dynamicParams);
    expect(dataOf('n7').dynamicInputPorts.map((p) => p.id)).toEqual(['input_image']);

    // An agent moved it to another model: the old model's controls go.
    sync([universal('n7', 'replicate-universal', { model_id: 'someone/else' })]);
    expect(dataOf('n7').dynamicParams).toEqual([]);
  });
});

describe('a sync after the picker', () => {
  it('drops a wire on a port the node no longer has before anything saves it', () => {
    useGraphStore.setState({
      nodes: [universal('n3', 'openrouter-universal', VISION.params, {
        dynamicInputPorts: VISION.dynamicInputPorts as DynamicNodeData['dynamicInputPorts'],
        dynamicOutputPorts: VISION.dynamicOutputPorts as DynamicNodeData['dynamicOutputPorts'] }),
      { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
        data: { label: 'Image', definitionId: 'image-input', params: {}, state: 'idle', outputs: {} } }],
      edges: [edge('e1', 'n1', 'image', 'n3', 'images')],
    });
    // The backend changed the model and dropped e1; its sync lands before the
    // route's answer does.
    sync([
      { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
        data: { label: 'Image', definitionId: 'image-input', params: {}, state: 'idle', outputs: {} } },
      universal('n3', 'openrouter-universal', { model: 'anthropic/claude-sonnet-4.5' }, {
        dynamicInputPorts: [VISION.dynamicInputPorts[0]] as DynamicNodeData['dynamicInputPorts'],
        dynamicOutputPorts: VISION.dynamicOutputPorts as DynamicNodeData['dynamicOutputPorts'] }),
    ]);
    expect(useGraphStore.getState().edges).toEqual([]);
  });
});

describe('a saved output on a port the node no longer has', () => {
  // A project save refuses an output on a port the node doesn't declare
  // (backend _validate_imported_outputs), so a re-typed node keeps only the
  // outputs its new ports take (2026-10-21 review).
  const ran = { video: { type: 'Video', value: 'https://replicate.delivery/x/out.mp4' } };
  const stamp = (model: string, port: string, dataType: string) => ({
    model, inputs: [], outputs: [{ id: port, label: 'Output', dataType, required: false }], rev: 2 });

  it('goes when the picker sets a model whose ports don\'t take it', async () => {
    const start = universal('n7', 'replicate-universal',
      { model_id: 'acme/clipmaker', _model_ports: stamp('acme/clipmaker', 'video', 'Video') });
    (start.data as unknown as DynamicNodeData).outputs = ran as DynamicNodeData['outputs'];
    useGraphStore.setState({ nodes: [start], edges: [] });
    backend.answer = () => json({
      params: { model_id: 'acme/voicebox', _model_ports: stamp('acme/voicebox', 'audio', 'Audio') },
      dynamicInputPorts: [], dynamicOutputPorts: [{ id: 'audio', label: 'Output', dataType: 'Audio', required: false }],
      dynamicParams: [], providerMeta: {}, removedEdges: [] });

    await useGraphStore.getState().fetchReplicateSchemaAndConfigure('n7', 'acme', 'voicebox');

    expect(dataOf('n7').outputs).toEqual({});
  });

  it('goes when an agent re-typed the node and the backend sync has no outputs', () => {
    const start = universal('n7', 'replicate-universal',
      { model_id: 'acme/clipmaker', _model_ports: stamp('acme/clipmaker', 'video', 'Video') });
    (start.data as unknown as DynamicNodeData).outputs = ran as DynamicNodeData['outputs'];
    useGraphStore.setState({ nodes: [start], edges: [] });

    // The same ports: the canvas keeps its outputs, as before.
    sync([universal('n7', 'replicate-universal',
      { model_id: 'acme/clipmaker', _model_ports: stamp('acme/clipmaker', 'video', 'Video') })]);
    expect(dataOf('n7').outputs).toEqual(ran);

    sync([universal('n7', 'replicate-universal',
      { model_id: 'acme/voicebox', _model_ports: stamp('acme/voicebox', 'audio', 'Audio') })]);
    expect(dataOf('n7').outputs).toEqual({});
  });
});

describe('the picker and the person\'s unsent edits', () => {
  it('sends a waiting edit before the model and keeps one typed while the model is read', async () => {
    vi.useFakeTimers();
    try {
      useGraphStore.setState({
        nodes: [universal('n3', 'openrouter-universal', { model: 'anthropic/claude-sonnet-4.5', temperature: 1 })],
        edges: [],
      });
      const order: string[] = [];
      backend.answer = (path, body) => {
        order.push(`${path} ${JSON.stringify(body)}`);
        return json(path.endsWith('/model') ? {
          ...VISION,
          // The backend configured the params it had (the edit sent first).
          params: { model: 'openai/gpt-4o', temperature: 0.2, _output_image: false,
            _model_ports: { model: 'openai/gpt-4o', inputs: [], outputs: [] } },
        } : {});
      };
      // The person sets the temperature, then picks a model inside the
      // 250 ms param debounce.
      useGraphStore.getState().updateNodeData('n3', { params: { ...dataOf('n3').params, temperature: 0.2 } });
      const picked = useGraphStore.getState().configureOpenRouterModel('n3', 'openai/gpt-4o');
      // While the model is read, the person types a max_tokens value.
      useGraphStore.getState().updateNodeData('n3', { params: { ...dataOf('n3').params, max_tokens: 99 } });
      await vi.advanceTimersByTimeAsync(400);
      await picked;
      // The waiting temperature edit reached the backend before the model,
      // so the backend configured over it.
      expect(order[0]).toBe('/api/graph/node/n3 {"params":{"model":"anthropic/claude-sonnet-4.5","temperature":0.2}}');
      expect(order[1]).toBe('/api/graph/node/n3/model {"model":"openai/gpt-4o"}');
      // max_tokens, typed while the model was read, stays and is sent with the new model.
      expect(dataOf('n3').params).toMatchObject({ model: 'openai/gpt-4o', temperature: 0.2, max_tokens: 99 });
      await vi.advanceTimersByTimeAsync(400);
      const puts = order.filter((line) => line.startsWith('/api/graph/node/n3 '));
      expect(puts).toHaveLength(2);
      expect(JSON.parse(puts[1].slice('/api/graph/node/n3 '.length)).params)
        .toMatchObject({ model: 'openai/gpt-4o', max_tokens: 99, _output_image: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
