import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({
  wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() },
}));
const net = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; body: unknown }>,
  restoreStatus: 200,
  restoreDetail: '',
}));
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: async (path: string, init?: RequestInit) => {
    net.calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (path === '/api/graph/restore' && net.restoreStatus !== 200) {
      return new Response(JSON.stringify({ detail: net.restoreDetail }), { status: net.restoreStatus });
    }
    return new Response('{}', { status: 200 });
  },
}));
vi.spyOn(console, 'warn').mockImplementation(() => {});

import { useGraphStore } from '../src/store/graphStore';
import { wsClient, type ExecutionEvent } from '../src/lib/wsClient';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { TAB_ID } from '../src/lib/tabId';

const CLAUDE = { actor: { kind: 'agent', id: 'claude', name: 'Claude', color: '#d97757' } };

function textNode(id: string, value: string, extra: Partial<NodeData> = {}, x = 0): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x, y: 0 },
    data: { label: 'Text Input', definitionId: 'text-input', params: { value }, state: 'idle', outputs: {}, ...extra },
  };
}
function imageNode(id: string): Node<NodeData> {
  return {
    id, type: 'model-node', position: { x: 400, y: 0 },
    data: { label: 'Nano Banana', definitionId: 'nano-banana', params: {}, state: 'idle', outputs: {} },
  };
}
function wire(source: string, target: string, id = `e-${source}-${target}`): Edge {
  return { id, source, sourceHandle: 'text', target, targetHandle: 'prompt', type: 'typed-edge' };
}

function sync(nodes: Node<NodeData>[], edges: Edge[], extra: Record<string, unknown> = {}) {
  const event = {
    type: 'graphSync', paramsVersion: GRAPH_PARAMS_VERSION, nodes: structuredClone(nodes),
    edges: structuredClone(edges), empty: nodes.length === 0, ...extra,
  } as unknown as ExecutionEvent;
  for (const [handler] of vi.mocked(wsClient.subscribe).mock.calls) (handler as (e: ExecutionEvent) => void)(event);
}

const restores = () => net.calls.filter((call) => call.path === '/api/graph/restore').map((call) => call.body as {
  action: string; nodes: Array<Record<string, unknown>>; remove: string[];
  wire: Array<Record<string, string>>; unwire: Array<Record<string, string>>;
});
const ids = () => useGraphStore.getState().nodes.map((node) => node.id).sort();
const nodeById = (id: string) => useGraphStore.getState().nodes.find((node) => node.id === id);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const start = () => {
  const lighthouse = textNode('n1', 'a lighthouse', {
    outputs: { text: { type: 'Text', value: 'a lighthouse' } }, state: 'complete',
  });
  return { nodes: [lighthouse, imageNode('n2')], edges: [wire('n1', 'n2')] };
};

beforeEach(() => {
  net.calls.length = 0;
  net.restoreStatus = 200;
  net.restoreDetail = '';
  const { nodes, edges } = start();
  useGraphStore.setState({ nodes, edges, undoStack: [], redoStack: [], undoNotice: null,
    isExecuting: false, providerRecoveries: [], providerStartAmbiguities: [] });
});

describe("an agent's edit is one undo step", () => {
  it('undoing an agent\'s new node removes it here and on the backend; redo brings it back', async () => {
    const { nodes, edges } = start();
    sync([...nodes, textNode('n3', 'fog', {}, 800)], [...edges, wire('n3', 'n2', 'e9')], { edit: CLAUDE });

    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    expect(useGraphStore.getState().undoNotice).toMatchObject({ text: 'Claude changed the canvas', offer: 'undo' });

    useGraphStore.getState().undo();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().edges.map((edge) => edge.source)).toEqual(['n1']);
    expect(useGraphStore.getState().undoNotice).toMatchObject({ text: 'Undid Claude’s edit', offer: 'redo' });
    await flush();
    expect(restores()).toEqual([{ action: 'undo', nodes: [], remove: ['n3'], wire: [], unwire: [] }]);

    useGraphStore.getState().redo();
    expect(ids()).toEqual(['n1', 'n2', 'n3']);
    expect(useGraphStore.getState().edges).toHaveLength(2);
    expect(useGraphStore.getState().undoNotice?.text).toBe('Redid Claude’s edit');
    await flush();
    expect(restores()[1]).toMatchObject({
      action: 'redo', remove: [],
      nodes: [{ id: 'n3', definitionId: 'text-input', params: { value: 'fog' } }],
      wire: [{ source: 'n3', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt' }],
    });
  });

  it('undoing an agent\'s deletion brings the node back with params, outputs and wires', async () => {
    sync([imageNode('n2')], [], { edit: CLAUDE });
    expect(ids()).toEqual(['n2']);

    useGraphStore.getState().undo();
    const back = nodeById('n1')!;
    expect(back.data.params).toEqual({ value: 'a lighthouse' });
    expect(back.data.outputs).toEqual({ text: { type: 'Text', value: 'a lighthouse' } });
    expect(useGraphStore.getState().edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual(['n1->n2']);
    await flush();
    expect(restores()).toEqual([{
      action: 'undo', remove: [], unwire: [],
      nodes: [{ id: 'n1', definitionId: 'text-input', params: { value: 'a lighthouse' }, label: 'Text Input',
        position: { x: 0, y: 0 }, outputs: { text: { type: 'Text', value: 'a lighthouse' } } }],
      wire: [{ source: 'n1', sourceHandle: 'text', target: 'n2', targetHandle: 'prompt' }],
    }]);
  });

  it('undoing an agent\'s param change keeps the outputs a run made since', async () => {
    const { nodes, edges } = start();
    sync([textNode('n1', 'fog'), nodes[1]], edges, { edit: CLAUDE });
    expect(nodeById('n1')!.data.params.value).toBe('fog');
    // A run result after the edit: not an undo step.
    sync([textNode('n1', 'fog', { outputs: { text: { type: 'Text', value: 'fog' } }, state: 'complete' }), nodes[1]], edges);
    expect(useGraphStore.getState().undoStack).toHaveLength(1);

    useGraphStore.getState().undo();
    expect(nodeById('n1')!.data.params.value).toBe('a lighthouse');
    expect(nodeById('n1')!.data.outputs).toEqual({ text: { type: 'Text', value: 'fog' } });
    await flush();
    expect(restores()).toEqual([{ action: 'undo', nodes: [{ id: 'n1', definitionId: 'text-input',
      params: { value: 'a lighthouse' } }], remove: [], wire: [], unwire: [] }]);
  });

  it('an agent clearing the canvas is one step, and undo puts every node back', () => {
    sync([], [], { edit: CLAUDE });
    expect(ids()).toEqual([]);
    useGraphStore.getState().undo();
    expect(ids()).toEqual(['n1', 'n2']);
    expect(useGraphStore.getState().edges).toHaveLength(1);
  });

  it('an agent\'s move is undone too', () => {
    const { nodes, edges } = start();
    sync([textNode('n1', 'a lighthouse', {}, 900), nodes[1]], edges, { edit: CLAUDE, moved: ['n1'] });
    expect(nodeById('n1')!.position).toEqual({ x: 900, y: 0 });
    useGraphStore.getState().undo();
    expect(nodeById('n1')!.position).toEqual({ x: 0, y: 0 });
  });
});

describe('what is not an undo step', () => {
  it('this tab\'s own echo, run results, and a project switch', () => {
    const { nodes, edges } = start();
    sync([...nodes, textNode('n3', 'mine')], edges, { edit: { actor: { kind: 'person' }, tab: TAB_ID } });
    sync([textNode('n1', 'a lighthouse', { outputs: { text: { type: 'Text', value: 'x' } } }), nodes[1]], edges);
    sync([textNode('n7', 'other project')], [], { graphReplaced: true, edit: CLAUDE });
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  it('an edit that changed nothing on this canvas', () => {
    const { nodes, edges } = start();
    sync(nodes, edges, { edit: CLAUDE });
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
  });
});

describe('the person\'s own steps and the agent\'s share one stack', () => {
  it('undo goes newest first, and each undo reaches the backend', async () => {
    useGraphStore.getState().updateNodeData('n1', { params: { value: 'a fort' } });
    const { edges } = start();
    sync([textNode('n1', 'a fort'), imageNode('n2'), textNode('n3', 'fog')], edges, { edit: CLAUDE });
    expect(useGraphStore.getState().undoStack).toHaveLength(2);

    useGraphStore.getState().undo(); // Claude's node
    expect(ids()).toEqual(['n1', 'n2']);
    expect(nodeById('n1')!.data.params.value).toBe('a fort');
    useGraphStore.getState().undo(); // the person's typing
    expect(nodeById('n1')!.data.params.value).toBe('a lighthouse');
    await flush();
    await flush();
    expect(restores().map((body) => [body.action, body.remove, body.nodes.map((n) => n.params)])).toEqual([
      ['undo', ['n3'], []],
      ['undo', [], [{ value: 'a lighthouse' }]],
    ]);
  });

  it('undoing the person\'s own deletion puts the node back on the backend with its outputs', async () => {
    useGraphStore.getState().onNodesChange([{ type: 'remove', id: 'n1' }]);
    // The delete's own graphSync can land before its reply: still one step.
    sync([imageNode('n2')], [], { edit: { actor: { kind: 'person' }, tab: TAB_ID } });
    await vi.waitFor(() => expect(net.calls.some((call) => call.path === '/api/graph/node/n1')).toBe(true));
    await flush();
    expect(ids()).toEqual(['n2']);
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    useGraphStore.getState().undo();
    expect(nodeById('n1')!.data.outputs).toEqual({ text: { type: 'Text', value: 'a lighthouse' } });
    await flush();
    expect(restores()[0]).toMatchObject({
      action: 'undo', nodes: [{ id: 'n1', outputs: { text: { type: 'Text', value: 'a lighthouse' } } }],
      wire: [{ source: 'n1', target: 'n2' }],
    });
  });

  it('a step started before a backend write stays one step when the echo lands first', () => {
    const step = useGraphStore.getState().beginUndoStep();
    const { nodes, edges } = start();
    // The upload's own echo adds the node: not a second step.
    sync([...nodes, textNode('n3', 'uploaded')], edges, { edit: { actor: { kind: 'person' }, tab: TAB_ID } });
    expect(useGraphStore.getState().undoStack).toEqual([step]);
    useGraphStore.getState().undo();
    expect(ids()).toEqual(['n1', 'n2']);
  });

  it('a step whose write failed is dropped', () => {
    const step = useGraphStore.getState().beginUndoStep();
    useGraphStore.getState().cancelUndoStep(step);
    expect(useGraphStore.getState().undoStack).toHaveLength(0);
  });
});

describe('an agent edit while the person is mid-change', () => {
  it('keeps what the person is typing and still applies the agent\'s other changes', () => {
    useGraphStore.getState().updateNodeData('n1', { params: { value: 'a lighthouse at dusk' } });
    // The agent's edit was made before the person's typing reached the backend.
    sync([textNode('n1', 'a lighthouse', { label: 'Hero' }), imageNode('n2')], start().edges, { edit: CLAUDE });

    expect(nodeById('n1')!.data.params.value).toBe('a lighthouse at dusk');
    expect(nodeById('n1')!.data.label).toBe('Hero');
    // The person's step stays under the agent's; the next keystroke starts its own.
    const stack = useGraphStore.getState().undoStack;
    expect(stack).toHaveLength(2);
    useGraphStore.getState().updateNodeData('n1', { params: { value: 'a lighthouse at night' } });
    expect(useGraphStore.getState().undoStack).toHaveLength(3);
  });

  it('a node the person is dragging stays put and its position is not part of the step', () => {
    useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((node) =>
      node.id === 'n1' ? { ...node, dragging: true, position: { x: 50, y: 50 } } : node) });
    const { edges } = start();
    sync([textNode('n1', 'a lighthouse', {}, 900), imageNode('n2'), textNode('n3', 'fog')], edges,
      { edit: CLAUDE, moved: ['n1'] });
    expect(nodeById('n1')!.position).toEqual({ x: 50, y: 50 });
    const entry = useGraphStore.getState().undoStack[0] as { before: { nodes: Record<string, unknown> } };
    expect(Object.keys(entry.before.nodes)).toEqual(['n3']);
  });
});

describe('when the backend refuses the undo', () => {
  it('puts the canvas and the stack back and says why', async () => {
    net.restoreStatus = 409;
    net.restoreDetail = 'n3 is a different node now, so this step can\'t be put back.';
    const { nodes, edges } = start();
    sync([...nodes, textNode('n3', 'fog')], edges, { edit: CLAUDE });
    const entry = useGraphStore.getState().undoStack[0];

    useGraphStore.getState().undo();
    expect(ids()).toEqual(['n1', 'n2']);
    await vi.waitFor(() => expect(ids()).toEqual(['n1', 'n2', 'n3']));
    expect(useGraphStore.getState().undoStack).toEqual([entry]);
    expect(useGraphStore.getState().redoStack).toEqual([]);
    expect(useGraphStore.getState().undoNotice?.text).toContain('different node now');
  });
});

describe('two open tabs', () => {
  it('another window\'s edit is a step here, named as such', () => {
    const { nodes, edges } = start();
    sync([...nodes, textNode('n3', 'fog')], edges, { edit: { actor: { kind: 'person' }, tab: 'tab-other-window' } });
    expect(useGraphStore.getState().undoStack).toHaveLength(1);
    // No notice when it lands: only agents' edits announce themselves.
    expect(useGraphStore.getState().undoNotice).toBeNull();
    useGraphStore.getState().undo();
    expect(useGraphStore.getState().undoNotice?.text).toBe('Undid an edit from another window');
  });
});
