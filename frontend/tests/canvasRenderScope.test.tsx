/**
 * Each card on the canvas re-renders only when something it draws changes.
 *
 * Before 2026-10-20 every ModelNode subscribed to the whole `nodes` and
 * `edges` arrays (ModelNode.tsx ~191), so any store change re-rendered every
 * card: about 1 s per Accept on a 100-node canvas in dev. These tests render
 * the canvas's own node types (components/canvasTypes.ts) in a real React
 * Flow, count each card body's renders, and check that what a card shows
 * from other nodes and wires still updates.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memo, type ComponentType, type ReactNode } from 'react';
import { ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps, type NodeTypes } from '@xyflow/react';
import shared from '../../backend/tests/fixtures/jev_outputs.json';
import type { NodeData, PortValue } from '../src/types';
import type { ExecutionEvent } from '../src/lib/wsClient';

const socket = vi.hoisted(() => ({ handlers: [] as Array<(event: ExecutionEvent) => void> }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn((handler: (event: ExecutionEvent) => void) => { socket.handlers.push(handler); return () => {}; }),
} }));
const api = vi.hoisted(() => ({ lookupStoredAsset: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({ ...await importOriginal<object>(), lookupStoredAsset: api.lookupStoredAsset }));

import { CANVAS_CARDS, CANVAS_EDGE_TYPES } from '../src/components/canvasTypes';
import { withNodeCardBoundary } from '../src/components/nodes/withNodeCardBoundary';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useStoredAssetsStore } from '../src/store/storedAssetsStore';
import { setSelectionActionSlot } from '../src/lib/selectionActionSlot';
import { GRAPH_PARAMS_VERSION } from '../src/lib/savedParamsUpgrades';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { providerLabel, runRouteProvider } from '../src/lib/modelDiscovery';
import { withWiredBlockers } from '../src/lib/directRoute';
import { JEV_DECIDE, JEV_PICK_BEST } from '../src/lib/jev';

// React Flow measures with ResizeObserver; jsdom has none. Unmeasured nodes
// still render, hidden (visibility: hidden), and a hidden element has no
// accessible name, so buttons are found by their label (button() below).
class NoResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoResizeObserver as unknown as typeof ResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };

// ---- render counting -------------------------------------------------------

/** Renders of each card's own body, by node id. */
const renders = new Map<string, number>();
const MEMO = Symbol.for('react.memo');

/** The card component with a counter in its body. The body runs inside the
 * wrapper (its hooks become the wrapper's), so a re-render the card's own
 * store subscriptions cause is counted too, not only React Flow's. */
function counting(Component: ComponentType<NodeProps>): ComponentType<NodeProps> {
  const asMemo = Component as unknown as { $$typeof?: symbol; type?: (props: NodeProps) => ReactNode };
  const isMemo = asMemo.$$typeof === MEMO;
  const body = (isMemo ? asMemo.type : Component) as (props: NodeProps) => ReactNode;
  function Counted(props: NodeProps) {
    renders.set(props.id, (renders.get(props.id) ?? 0) + 1);
    return body(props);
  }
  return isMemo ? memo(Counted) : Counted;
}
// Each counted card inside its boundary, as CANVAS_NODE_TYPES draws it
// (PR #198 review 3, L4): the count stays the card's own.
const COUNTED_TYPES: NodeTypes = Object.fromEntries(
  Object.entries(CANVAS_CARDS).map(([type, Component]) => [type,
    withNodeCardBoundary(counting(Component as ComponentType<NodeProps>))]),
);

/** The canvas's controlled React Flow, as Canvas.tsx wires it. */
function Flow() {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const onNodesChange = useGraphStore((s) => s.onNodesChange);
  const onEdgesChange = useGraphStore((s) => s.onEdgesChange);
  return (
    <div style={{ width: 1200, height: 800 }}>
      <ReactFlow nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        nodeTypes={COUNTED_TYPES} edgeTypes={CANVAS_EDGE_TYPES} defaultEdgeOptions={{ type: 'typed-edge' }} />
    </div>
  );
}

function renderCanvas() {
  const view = render(<ReactFlowProvider><Flow /></ReactFlowProvider>);
  renders.clear();
  return view;
}

/** Which cards rendered since the last reset, sorted. */
function rendered(): string[] {
  return [...renders.entries()].filter(([, count]) => count > 0).map(([id]) => id).sort();
}

/** A button by its aria-label or its text. */
function button(container: HTMLElement, label: string): HTMLButtonElement | null {
  return [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label
    || b.textContent?.trim() === label) ?? null;
}

function card(id: string): HTMLElement {
  const element = document.querySelector(`.react-flow__node[data-id="${id}"]`);
  if (!element) throw new Error(`no card ${id}`);
  return element as HTMLElement;
}

// ---- fixture ---------------------------------------------------------------

type Sample = { name: string; params?: Record<string, unknown>; outputs: Record<string, PortValue> };
const jev = shared as unknown as { decide: Sample[]; pickBest: Sample[] };
const pickSample = jev.pickBest.find((s) => s.name.includes('a clear winner'))!;
const decideSample = jev.decide.find((s) => s.name.includes('too close to call'))!;

function node(id: string, definitionId: string, patch: Partial<NodeData> = {}, type = 'model-node'): Node<NodeData> {
  return { id, type, position: { x: 0, y: 0 },
    data: { definitionId, label: id, params: {}, state: 'idle', outputs: {}, ...patch } as NodeData };
}
function wire(source: string, sourceHandle: string, target: string, targetHandle: string): Edge {
  return { id: `${source}.${sourceHandle}->${target}.${targetHandle}`, source, sourceHandle, target, targetHandle, type: 'typed-edge' };
}

const GROK = 'krea-video-xai-grok-video-1-5';
const PAPER_SNAPSHOT = (hash: string) => ({ id: `snap-${hash}`, hash, capturedAt: '2026-10-20T00:00:00Z', width: 10, height: 10,
  hasAlpha: false, hasTransparency: false, filePath: `/api/outputs/paper-${hash}.png`, previewUrl: `/api/outputs/paper-${hash}.png`,
  identity: { fileId: 'f', pageId: 'p', objectId: 'o' }, exportSettings: {} });

/** A canvas with one of each card kind, wired the way people wire them. */
function fixtureCanvas(): { nodes: Node<NodeData>[]; edges: Edge[] } {
  return {
    nodes: [
      node('prompt', 'text-input', { params: { value: 'a cat' } }),
      node('image', 'gpt-image-2-generate'),
      node('preview', 'preview'),
      node('photo', 'image-input', { params: { _previewUrl: '/api/outputs/photo.png' } }),
      node('mask', 'mask-painter'),
      node('refs', 'reference-set', {}, 'referenceSetNode'),
      node('board', 'nebula-moodboard', { params: { moodboard: 'b1' } }, 'moodboardNode'),
      node('person', 'character', { params: { character: 'c1' } }, 'characterNode'),
      node('pick', JEV_PICK_BEST, { state: 'complete', outputs: pickSample.outputs }),
      node('decide', JEV_DECIDE, { state: 'complete', outputs: decideSample.outputs, params: decideSample.params ?? {} }),
      node('grok', GROK, { state: 'executing', runStartedAt: Date.now() }),
      node('batch', 'batch', { params: { items_text: 'one\ntwo' } }, 'batchNode'),
      node('hop', 'reroute', {}, 'reroute-node'),
      node('dyn', 'dynamic-test', { isDynamic: true, dynamicInputPorts: [{ id: 'prompt', label: 'Prompt', dataType: 'Text', required: false }],
        dynamicOutputPorts: [{ id: 'image', label: 'Image', dataType: 'Image' }] } as unknown as Partial<NodeData>, 'dynamic-node'),
      node('paper', 'paper-source', { params: { _paperSource: { id: 's1', identity: { fileId: 'f', pageId: 'p', objectId: 'o' },
        exportSettings: {}, snapshot: PAPER_SNAPSHOT('h2'), snapshots: [], state: 'unavailable', sequence: 2 } } }, 'model-node'),
      node('framed', 'gpt-image-2-generate', { state: 'complete', outputs: { image: { type: 'Image', value: '/api/outputs/framed.png' } },
        outputFreshness: { runId: 'r-old', paperInputs: [{ nodeId: 'paper', sourceId: 's1', snapshot: PAPER_SNAPSHOT('h1') }],
          outOfDateReasons: ['Paper source paper updated after this input was captured.'] } } as Partial<NodeData>),
    ],
    edges: [
      wire('prompt', 'text', 'image', 'prompt'),
      wire('image', 'image', 'preview', 'input'),
      wire('photo', 'image', 'mask', 'image'),
      wire('photo', 'image', 'refs', 'style'),
    ],
  };
}

const ALL_IDS = fixtureCanvas().nodes.map((n) => n.id).sort();
const others = (...ids: string[]) => ALL_IDS.filter((id) => !ids.includes(id));

beforeEach(() => {
  api.lookupStoredAsset.mockReset().mockResolvedValue({ status: 'missing' });
  useStoredAssetsStore.setState({ entries: {
    'moodboard:b1': { status: 'ready', summary: { id: 'b1', name: 'Dusk', thumbnail: '/api/outputs/b1.png', imageCount: 3, mode: 'look' } },
    'character:c1': { status: 'ready', summary: { id: 'c1', name: 'Mara', thumbnail: '/api/outputs/c1.png' } },
  } });
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null, canvasZoomedOut: false,
    settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys: { XAI_API_KEY: 'k', KREA_API_TOKEN: 'k' } } });
  useGraphStore.setState({ ...fixtureCanvas(), isExecuting: false, runHistory: [], undoStack: [], redoStack: [] });
});
afterEach(() => {
  cleanup();
  setSelectionActionSlot(null);
});

// ---- render scope ----------------------------------------------------------

describe('a card re-renders only when something it draws changes', () => {
  it('a param change on one card re-renders only that card', () => {
    renderCanvas();
    act(() => useGraphStore.getState().updateNodeData('prompt', { params: { value: 'a dog' } }));
    expect(rendered()).toEqual(['prompt']);
  });

  it('a run event on one node re-renders only that card', () => {
    renderCanvas();
    act(() => useGraphStore.getState().handleExecutionEvent({ type: 'queued', nodeId: 'image' } as ExecutionEvent));
    act(() => useGraphStore.getState().handleExecutionEvent({ type: 'executing', nodeId: 'image' } as ExecutionEvent));
    act(() => useGraphStore.getState().handleExecutionEvent({ type: 'progress', nodeId: 'image', value: 0.5 } as ExecutionEvent));
    expect(rendered()).toEqual(['image']);
  });

  it('a node that errors re-renders only itself', () => {
    renderCanvas();
    act(() => useGraphStore.getState().handleExecutionEvent({ type: 'error', nodeId: 'image', error: 'boom' } as ExecutionEvent));
    expect(rendered()).toEqual(['image']);
  });

  it('adding a wire re-renders at most its two ends', () => {
    renderCanvas();
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'add', item: wire('photo', 'image', 'refs', 'pose') }]));
    expect(others('photo', 'refs').filter((id) => rendered().includes(id))).toEqual([]);
    expect(rendered()).toContain('refs');
  });

  it('removing a wire re-renders at most its two ends', () => {
    renderCanvas();
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'remove', id: 'photo.image->mask.image' }]));
    expect(others('photo', 'mask').filter((id) => rendered().includes(id))).toEqual([]);
    expect(rendered()).toContain('mask');
  });

  it('selecting a card re-renders only the cards whose selection changed', () => {
    renderCanvas();
    act(() => useUIStore.getState().selectNode('image'));
    expect(rendered()).toEqual(['image']);
    renders.clear();
    act(() => useUIStore.getState().selectNode('batch'));
    expect(rendered()).toEqual(['batch', 'image']);
    renders.clear();
    act(() => useGraphStore.getState().onNodesChange([{ type: 'select', id: 'dyn', selected: true }]));
    expect(rendered()).toEqual(['dyn']);
  });

  it("the selection toolbar's action slot re-renders only the card it belongs to", () => {
    renderCanvas();
    const slot = document.createElement('span');
    slot.dataset.nodeId = 'image';
    act(() => setSelectionActionSlot(slot));
    expect(rendered()).toEqual(['image']);
  });

  it('opening the Inspector re-renders only the selected card', () => {
    useUIStore.setState({ selectedNodeId: 'image' });
    renderCanvas();
    act(() => useUIStore.getState().setInspectorVisible(true));
    expect(rendered()).toEqual(['image']);
  });

  it('a run starting or stopping re-renders only the cards that change', () => {
    useGraphStore.setState({ nodes: useGraphStore.getState().nodes.map((n) => (n.id === 'image'
      ? { ...n, data: { ...n.data, state: 'queued' } } : n)) });
    renderCanvas();
    act(() => useGraphStore.setState({ isExecuting: true }));
    // Only a card with a button a run disables: framed's Rerun with latest source.
    expect(rendered()).toEqual(['framed']);
    renders.clear();
    act(() => useGraphStore.getState().resetExecution());
    // The two running nodes go idle; the run ending (isExecuting false) re-enables framed's Rerun.
    expect(rendered()).toEqual(['framed', 'grok', 'image']);
  });

  it('an upstream output reaches only the cards that draw it', () => {
    renderCanvas();
    act(() => useGraphStore.getState().updateNodeData('photo', { params: { _previewUrl: '/api/outputs/photo-2.png' } }));
    expect(rendered()).toEqual(['mask', 'photo']);
  });

  it('a graphSync that changes one node re-renders only that card', () => {
    const cli = (id: string, definitionId: string, params: Record<string, unknown> = {}) =>
      node(id, definitionId, { params });
    const nodes = [cli('n1', 'text-input', { value: 'a cat' }), cli('n2', 'gpt-image-2-generate'), cli('n3', 'preview')];
    const edges = [wire('n1', 'text', 'n2', 'prompt'), wire('n2', 'image', 'n3', 'input')];
    useGraphStore.setState({ nodes, edges });
    renderCanvas();
    const sync = (syncNodes: Node<NodeData>[]) => act(() => socket.handlers.forEach((handler) => handler({
      type: 'graphSync', nodes: structuredClone(syncNodes), edges: structuredClone(edges), empty: false,
      paramsVersion: GRAPH_PARAMS_VERSION,
    } as unknown as ExecutionEvent)));
    // The first sync adds what the canvas works out itself (the missing-key badge).
    sync(nodes);
    renders.clear();
    sync(nodes);
    expect(rendered()).toEqual([]);
    sync([cli('n1', 'text-input', { value: 'a dog' }), nodes[1], nodes[2]]);
    expect(rendered()).toEqual(['n1']);
  });

  it('a graphSync leaves alone a card the person deselected or dragged', () => {
    const nodes = [node('n1', 'text-input', { params: { value: 'a cat' } }), node('n2', 'preview'), node('n3', 'preview')];
    const edges = [wire('n1', 'text', 'n2', 'input')];
    useGraphStore.setState({ nodes, edges });
    renderCanvas();
    const sync = () => act(() => socket.handlers.forEach((handler) => handler({ type: 'graphSync',
      nodes: structuredClone(nodes), edges: structuredClone(edges), empty: false, paramsVersion: GRAPH_PARAMS_VERSION } as unknown as ExecutionEvent)));
    sync();
    // React Flow leaves `selected: false` and `dragging: false` on the node
    // (and the wire) once a selection or a drag ends.
    act(() => useGraphStore.getState().onNodesChange([{ type: 'select', id: 'n2', selected: true }]));
    act(() => useGraphStore.getState().onNodesChange([{ type: 'select', id: 'n2', selected: false }]));
    // (A drag's end, without the layout write it sends.)
    act(() => useGraphStore.setState((state) => ({ nodes: state.nodes.map((n) => (n.id === 'n3' ? { ...n, dragging: false } : n)) })));
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'select', id: edges[0].id, selected: true }]));
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'select', id: edges[0].id, selected: false }]));
    const before = useGraphStore.getState();
    renders.clear();
    sync();
    expect(rendered()).toEqual([]);
    expect(useGraphStore.getState().nodes).toBe(before.nodes);
    expect(useGraphStore.getState().edges).toBe(before.edges);
  });

  it('focusing a node re-renders only the cards whose selection changes', () => {
    act(() => useGraphStore.getState().onNodesChange([{ type: 'select', id: 'prompt', selected: true }]));
    renderCanvas();
    act(() => useUIStore.getState().requestCanvasNodeFocus('image'));
    expect(rendered()).toEqual(['image', 'prompt']);
  });

  it('duplicating or selecting every card re-renders only the cards whose selection changes', () => {
    act(() => useGraphStore.getState().onNodesChange([{ type: 'select', id: 'prompt', selected: true }]));
    renderCanvas();
    act(() => useGraphStore.getState().duplicateSelected());
    const copy = useGraphStore.getState().nodes.at(-1)!.id;
    expect(rendered()).toEqual([copy, 'prompt'].sort());
    act(() => useGraphStore.getState().onNodesChange([{ type: 'select', id: 'image', selected: true }]));
    renders.clear();
    act(() => useGraphStore.getState().selectAll());
    expect(rendered()).toEqual(others('image'));
  });

  it('a graphSync keeps what React Flow measured and selected on the cards it leaves alone', () => {
    const nodes = [node('n1', 'text-input', { params: { value: 'a cat' } }), node('n2', 'preview')];
    useGraphStore.setState({ nodes: nodes.map((n) => ({ ...n, measured: { width: 300, height: 120 }, selected: n.id === 'n2' })), edges: [] });
    renderCanvas();
    act(() => socket.handlers.forEach((handler) => handler({ type: 'graphSync', nodes: structuredClone(nodes), edges: [],
      empty: false, paramsVersion: GRAPH_PARAMS_VERSION } as unknown as ExecutionEvent)));
    const after = useGraphStore.getState().nodes;
    expect(after.map((n) => [n.id, n.measured, n.selected ?? false])).toEqual([
      ['n1', { width: 300, height: 120 }, false], ['n2', { width: 300, height: 120 }, true]]);
  });
});

// ---- what a card shows still updates ---------------------------------------

describe('what a card shows from the rest of the canvas still updates', () => {
  it('Mask Painter shows its wired source, and follows a new image and a rewire', () => {
    renderCanvas();
    const src = () => card('mask').querySelector('img[alt="Mask source preview"]')?.getAttribute('src') ?? null;
    expect(src()).toContain('photo.png');
    act(() => useGraphStore.getState().updateNodeData('photo', { params: { _previewUrl: '/api/outputs/photo-2.png' } }));
    expect(src()).toContain('photo-2.png');
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'remove', id: 'photo.image->mask.image' }]));
    expect(src()).toBeNull();
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'add', item: wire('image', 'image', 'mask', 'image') }]));
    expect(src()).toBeNull();
    act(() => useGraphStore.getState().updateNodeData('image', { state: 'complete', outputs: { image: { type: 'Image', value: '/api/outputs/gen.png' } } }));
    expect(src()).toContain('gen.png');
  });

  it('Pick Best draws the wired candidates and follows their outputs', () => {
    const urls = ['/api/outputs/a.png', '/api/outputs/jev-fixture/candidate-1.png', '/api/outputs/c.png'];
    const sources = urls.map((url, i) => node(`g${i}`, 'gpt-image-2-generate', { state: 'complete', outputs: { image: { type: 'Image', value: url } } }));
    useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, ...sources],
      edges: [...useGraphStore.getState().edges, ...sources.map((s) => wire(s.id, 'image', 'pick', 'candidates'))] });
    renderCanvas();
    const thumbs = () => [...card('pick').querySelectorAll('img.jev-result__thumb')].map((img) => img.getAttribute('src'));
    expect(thumbs()).toEqual(urls.map((url) => expect.stringContaining(url)));
    act(() => useGraphStore.getState().updateNodeData('g1', { outputs: { image: { type: 'Image', value: '/api/outputs/moved.png' } } }));
    // The wired candidates no longer line up with the result, so the card drops the thumbnails.
    expect(thumbs()).toEqual([]);
    act(() => useGraphStore.getState().updateNodeData('g1', { outputs: { image: { type: 'Image', value: urls[1] } } }));
    expect(thumbs()).toHaveLength(3);
  });

  it("Decide says which branch the verdict went out on once one is wired, and Jev's field notes a wired input", () => {
    renderCanvas();
    expect(within(card('decide')).queryByTestId('jev-branch')).toBeNull();
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'add', item: wire('decide', 'on_pass', 'preview', 'input') }]));
    expect(within(card('decide')).getByTestId('jev-branch')).toBeInTheDocument();
    expect(card('decide').querySelector('.model-node__jev-field-note')).toBeNull();
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'add', item: wire('prompt', 'text', 'decide', 'question') }]));
    // Decide's question has no input port, so nothing changes there; Box's target does.
    act(() => useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, node('box', 'jev-box')] }));
    expect(card('box').querySelector('.model-node__jev-field-note')).toBeNull();
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'add', item: wire('prompt', 'text', 'box', 'target') }]));
    expect(card('box').querySelector('.model-node__jev-field-note')).toHaveTextContent('Used when the');
  });

  it('a running node names the provider its wiring routes it to', () => {
    renderCanvas();
    const keys = useUIStore.getState().settingsCache.apiKeys;
    const def = NODE_DEFINITIONS[GROK];
    const label = (wired: string[]) => providerLabel(runRouteProvider(def, keys, withWiredBlockers(def, {}, wired))!);
    expect(label([])).not.toBe(label(['start_video']));
    expect(card('grok').querySelector('.model-node__loading-text')).toHaveTextContent(label([]));
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'add', item: wire('hop', 'output', 'grok', 'start_video') }]));
    expect(card('grok').querySelector('.model-node__loading-text')).toHaveTextContent(label(['start_video']));
  });

  it('"Rerun with latest source" follows the Paper source it was made from', () => {
    renderCanvas();
    const rerun = () => button(card('framed'), 'Rerun with latest source');
    expect(rerun()).toBeDisabled();
    const paper = useGraphStore.getState().nodes.find((n) => n.id === 'paper')!;
    act(() => useGraphStore.getState().updateNodeData('paper', { params: { ...paper.data.params,
      _paperSource: { ...(paper.data.params._paperSource as object), state: 'current' } } }));
    expect(rerun()).toBeEnabled();
    act(() => useGraphStore.setState({ isExecuting: true }));
    expect(rerun()).toBeDisabled();
  });

  it('Reference Set previews the roles wired into it', () => {
    renderCanvas();
    const roles = () => [...card('refs').querySelectorAll('.reference-set-node__preview-item .reference-set-node__role-badge')]
      .map((el) => el.textContent);
    expect(roles()).toEqual(['Style']);
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'add', item: wire('photo', 'image', 'refs', 'pose') }]));
    expect(roles()).toEqual(['Style', 'Pose']);
    act(() => useGraphStore.getState().onEdgesChange([{ type: 'remove', id: 'photo.image->refs.style' }]));
    expect(roles()).toEqual(['Pose']);
  });

  it('a card shows its run states, its error and its missing-key badge as they change', () => {
    useUIStore.setState({ settingsCache: { ...useUIStore.getState().settingsCache, loaded: true, apiKeys: {} } });
    renderCanvas();
    act(() => useGraphStore.getState().updateNodeData('image', { params: { size: '1024x1024' } }));
    expect(card('image').querySelector('.model-node__badge--warning')).not.toBeNull();
    act(() => useGraphStore.getState().handleExecutionEvent({ type: 'queued', nodeId: 'image' } as ExecutionEvent));
    expect(card('image').querySelector('.model-node__loading-text')).toHaveTextContent('Queued');
    act(() => useGraphStore.getState().handleExecutionEvent({ type: 'error', nodeId: 'image', error: 'Missing API key: OPENAI_API_KEY',
      friendly: 'Add an OpenAI key in Settings', category: 'auth' } as unknown as ExecutionEvent));
    expect(card('image').querySelector('.model-node--error')).not.toBeNull();
    expect(card('image')).toHaveTextContent('Add an OpenAI key in Settings');
    act(() => useGraphStore.getState().updateNodeData('image', { state: 'complete', error: undefined,
      outputs: { image: { type: 'Image', value: '/api/outputs/done.png' } } }));
    expect(card('image').querySelector('img[alt="Generated output"]')).toHaveAttribute('src', expect.stringContaining('done.png'));
  });

  it('selection shows the settings bar and the Inspector toggle on the selected card only', () => {
    renderCanvas();
    act(() => useUIStore.getState().selectNode('image'));
    expect(card('image').querySelector('.model-node__settings-bar')).not.toBeNull();
    expect(card('prompt').querySelector('.model-node__settings-bar')).toBeNull();
    const toggle = button(card('image'), 'Show node settings')!;
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    act(() => toggle.click());
    expect(useUIStore.getState().panels.inspector.visible).toBe(true);
    expect(button(card('image'), 'Show node settings')!).toHaveAttribute('aria-expanded', 'true');
    act(() => button(card('image'), 'Show node settings')!.click());
    expect(useUIStore.getState().panels.inspector.visible).toBe(false);
    act(() => useUIStore.getState().selectNode('batch'));
    expect(card('image').querySelector('.model-node__settings-bar')).toBeNull();
    expect(card('batch').querySelector('.batch-node--selected')).not.toBeNull();
  });

  it("the selection toolbar's slot gets the selected card's actions and loses them on a new selection", () => {
    renderCanvas();
    const slot = document.createElement('span');
    slot.dataset.nodeId = 'board';
    document.body.append(slot);
    act(() => setSelectionActionSlot(slot));
    expect(button(slot, 'Show node settings')).toBeInTheDocument();
    const next = document.createElement('span');
    next.dataset.nodeId = 'image';
    document.body.append(next);
    act(() => setSelectionActionSlot(next));
    expect(button(slot, 'Show node settings')).toBeNull();
    expect(button(next, 'Show node settings')).toBeInTheDocument();
    slot.remove();
    next.remove();
  });

  it('a graphSync still brings an agent\'s param change to its card', () => {
    const nodes = [node('n1', 'text-input', { params: { value: 'a cat' } })];
    useGraphStore.setState({ nodes, edges: [] });
    renderCanvas();
    act(() => socket.handlers.forEach((handler) => handler({ type: 'graphSync',
      nodes: [node('n1', 'text-input', { params: { value: 'a dog' } })], edges: [], empty: false,
      paramsVersion: GRAPH_PARAMS_VERSION } as unknown as ExecutionEvent)));
    expect(screen.getByDisplayValue('a dog')).toBeInTheDocument();
  });
});
