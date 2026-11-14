/**
 * The arrange path while the hold keeps a node back: an agent edit's layout
 * (ArrangeController) waits for its new nodes to be drawn and measured, so a
 * node the canvas has not handed to React Flow yet is not laid out as if it
 * had no size. The real Canvas and the real ArrangeController, with the Character
 * chunk under the test's control; completeArrange is a recorder.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// ---- chunks under the test's control ----------------------------------------

interface Load { resolve: (module: unknown) => void; reject: (error: Error) => void }
const chunkLoads = vi.hoisted(() => ({ character: [] as Load[], jev: [] as Load[], renew: (() => {}) as () => void }));
const fitView = vi.hoisted(() => vi.fn(async () => true));
const arranged = vi.hoisted(() => ({ calls: [] as Array<{ id: string; drawn: (string | null)[] }> }));

vi.mock('../src/store/graphStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/store/graphStore')>(),
  completeArrange: vi.fn(async (id: string) => {
    arranged.calls.push({ id, drawn: [...document.querySelectorAll('.react-flow__node')].map((element) => element.getAttribute('data-id')) });
    return 'arranged';
  }),
}));

// Each chunk is a stand-in that delegates to a fresh lazyWithPreload per test
// (a chunk that has loaded stays loaded), whose load is a promise the test settles.
vi.mock('../src/lib/deferredChunks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/deferredChunks')>();
  const { lazyWithPreload } = await import('../src/lib/lazyWithPreload');
  const { createElement } = await import('react');
  function controlled(loads: Load[], pick: string) {
    let current = lazyWithPreload(() => new Promise<Record<string, never>>((resolve, reject) => {
      loads.push({ resolve: resolve as Load['resolve'], reject });
    }), (module) => module[pick]);
    const renew = () => {
      current = lazyWithPreload(() => new Promise<Record<string, never>>((resolve, reject) => {
        loads.push({ resolve: resolve as Load['resolve'], reject });
      }), (module) => module[pick]);
    };
    const stand = Object.assign((props: object) => createElement(current as never, props), {
      preload: () => current.preload(),
      retry: (trigger: Parameters<typeof current.retry>[0]) => current.retry(trigger),
      isLoaded: () => current.isLoaded(),
      isSettled: () => current.isSettled(),
      onSettle: (listener: () => void) => current.onSettle(listener),
      failures: () => current.failures(),
      subscribe: (listener: () => void) => current.subscribe(listener),
    });
    return { stand, renew };
  }
  const character = controlled(chunkLoads.character, 'CharacterNode');
  const jev = controlled(chunkLoads.jev, 'JevResultView');
  chunkLoads.renew = () => { character.renew(); jev.renew(); };
  return { ...actual, DeferredCharacterNode: character.stand, DeferredJevResultView: jev.stand };
});

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), subscribe: vi.fn(() => () => {}) } }));
vi.mock('../src/lib/agentRoster', async (original) => ({
  ...await original<typeof import('../src/lib/agentRoster')>(),
  fetchAgentRoster: () => new Promise(() => {}),
}));
vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return { ...actual, useReactFlow: () => ({ ...actual.useReactFlow(), fitView }) };
});
vi.mock('../src/components/SelectionToolbar', () => ({ SelectionToolbar: () => null }));
vi.mock('../src/components/CanvasNavigation', () => ({ CanvasNavigation: () => null }));
vi.mock('../src/components/canvas/CanvasViewReporter', () => ({ CanvasViewReporter: () => null }));
vi.mock('../src/components/canvas/AgentCursorLayer', () => ({ AgentCursorLayer: () => null }));
vi.mock('../src/components/canvas/PinLayer', () => ({ PinLayer: () => null }));
vi.mock('../src/components/canvas/PinComposer', () => ({ PinComposer: () => null }));
vi.mock('../src/components/canvas/ProposalLayer', () => ({ ProposalLayer: () => null }));
vi.mock('../src/components/canvas/ProposalBar', () => ({ ProposalBar: () => null }));
vi.mock('../src/components/ContextMenu', () => ({ ContextMenu: () => null }));
vi.mock('../src/store/canvasPinsStore', () => ({ useCanvasPinsStore: { getState: () => ({ pins: [] }) } }));
vi.mock('../src/components/ConnectionPopup', () => ({ ConnectionPopup: () => null }));
vi.mock('../src/lib/canvasSelection', () => ({
  selectedNodeIds: (nodes: Node<NodeData>[]) => nodes.filter((node) => node.selected).map((node) => node.id),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { ReactFlowProvider } from '@xyflow/react';
import { Canvas } from '../src/components/Canvas';
import { useGraphStore } from '../src/store/graphStore';
import { useArrangeStore, selectMeasuring } from '../src/store/arrangeStore';
import { DeferredArrangeController } from '../src/lib/deferredChunks';
import { useUIStore } from '../src/store/uiStore';
import { useStoredAssetsStore } from '../src/store/storedAssetsStore';

// React Flow measures a node when its ResizeObserver reports it; jsdom has no
// layout, so every observed element reports 100 x 60.
class MeasuringObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    queueMicrotask(() => this.callback([{ target, contentRect: { width: 100, height: 60 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver));
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = MeasuringObserver as unknown as typeof ResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 100 });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 60 });
// jsdom never loads an image; the controller waits for them to have loaded.
Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });


function node(id: string, definitionId: string, type: string, patch: Partial<NodeData> = {}): Node<NodeData> {
  return { id, type, position: { x: Number(id.replace(/\D/g, '')) * 300, y: 0 },
    data: { definitionId, label: id, params: {}, state: 'idle', outputs: {}, ...patch } as NodeData };
}
const domNodes = () => [...document.querySelectorAll('.react-flow__node')].map((element) => element.getAttribute('data-id'));
const sleep = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
async function settle(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
const initialGraph = useGraphStore.getState();
const initialUI = useUIStore.getState();

beforeAll(async () => { await DeferredArrangeController.preload(); });
beforeEach(() => {
  chunkLoads.renew();
  chunkLoads.character.length = 0;
  chunkLoads.jev.length = 0;
  arranged.calls.length = 0;
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  useStoredAssetsStore.setState({ entries: { 'character:c1': { status: 'ready', summary: { id: 'c1', name: 'Mara', thumbnail: '/api/outputs/c1.png' } } } });
  useUIStore.setState({ skin: 'slava-restraint', viewMode: 'canvas', onboardingActive: false, selectedNodeId: null, canvasFocusRequest: null,
    canvasViewport: { x: 0, y: 0, zoom: 1 }, canvasPerfMode: false });
  useGraphStore.setState({ nodes: [], edges: [], isExecuting: false, undoStack: [], redoStack: [] });
  useArrangeStore.setState({ pending: [], finished: [] });
});
afterEach(() => {
  cleanup();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
  useArrangeStore.setState({ pending: [], finished: [] });
  vi.unstubAllGlobals();
});

describe('an agent edit whose new node the hold keeps back', () => {
  it('is laid out only once the node is drawn and measured', async () => {
    render(<ReactFlowProvider><div style={{ width: 1200, height: 800 }}><Canvas /></div></ReactFlowProvider>);
    act(() => useGraphStore.getState().loadGraph(
      [node('n1', 'text-input', 'model-node', { params: { value: 'a cat' } }), node('n2', 'character', 'characterNode', { params: { character: 'c1' } })], []));
    act(() => useArrangeStore.getState().setPending([{ id: 'a_1', nodeIds: ['n2'], direction: 'right', gap: 120 }]));
    await settle();
    expect(domNodes()).toEqual([]);
    expect(selectMeasuring(useArrangeStore.getState())).toBe(true);

    // Well past the settle time (300 ms) and the check interval (150 ms): still waiting.
    await sleep(900);
    expect(arranged.calls).toEqual([]);
    expect(useArrangeStore.getState().finished).toEqual([]);

    chunkLoads.character[0].resolve(await import('../src/components/nodes/CharacterNode'));
    await settle();
    expect(domNodes().sort()).toEqual(['n1', 'n2']);
    await vi.waitFor(() => expect(useArrangeStore.getState().finished).toEqual(['a_1']), { timeout: 8000, interval: 50 });
    // It ran with the node on screen, never before.
    expect(arranged.calls.length).toBeGreaterThan(0);
    for (const call of arranged.calls) expect(call.drawn.sort()).toEqual(['n1', 'n2']);
    expect(selectMeasuring(useArrangeStore.getState())).toBe(false);
  });
});
