/**
 * The hold at the canvas (lib/cardHold.ts): a node whose card chunks have not
 * settled is not handed to React Flow, so nothing in a canvas's first frame
 * pops in later. These tests mount the real Canvas in a real React Flow with
 * the card chunks under the test's control (each load is a promise the test
 * settles), and read the DOM and the graph store.
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Edge, Node } from '@xyflow/react';
import shared from '../../backend/tests/fixtures/jev_outputs.json';
import type { NodeData, PortValue } from '../src/types';

// ---- chunks under the test's control ----------------------------------------

interface Load { resolve: (module: unknown) => void; reject: (error: Error) => void }
const chunkLoads = vi.hoisted(() => ({ character: [] as Load[], jev: [] as Load[], renew: (() => {}) as () => void }));
const fitView = vi.hoisted(() => vi.fn(async () => true));

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
vi.mock('../src/components/canvas/ArrangeController', () => ({ ArrangeController: () => null }));
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
import { useUIStore } from '../src/store/uiStore';
import { useStoredAssetsStore } from '../src/store/storedAssetsStore';
import { JEV_DECIDE } from '../src/lib/jev';

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

const jevSample = (shared as unknown as { decide: Array<{ params?: Record<string, unknown>; outputs: Record<string, PortValue> }> }).decide[0];

function node(id: string, definitionId: string, type: string, patch: Partial<NodeData> = {}, extra: Partial<Node<NodeData>> = {}): Node<NodeData> {
  return { id, type, position: { x: Number(id.replace(/\D/g, '')) * 300, y: 0 },
    data: { definitionId, label: id, params: {}, state: 'idle', outputs: {}, ...patch } as NodeData, ...extra };
}
const wire = (source: string, sourceHandle: string, target: string, targetHandle: string): Edge => ({
  id: `${source}.${sourceHandle}->${target}.${targetHandle}`, source, sourceHandle, target, targetHandle, type: 'typed-edge' });

const text = () => node('n1', 'text-input', 'model-node', { params: { value: 'a cat' } });
const character = (id = 'n2') => node(id, 'character', 'characterNode', { params: { character: 'c1' } });
const shown = () => node('n3', 'preview', 'model-node');
const decided = (id = 'n3') => node(id, JEV_DECIDE, 'model-node', { state: 'complete', outputs: jevSample.outputs, params: jevSample.params ?? {} });

const domNodes = () => [...document.querySelectorAll('.react-flow__node')].map((element) => element.getAttribute('data-id'));
const domEdges = () => document.querySelectorAll('.react-flow__edge').length;
const splash = () => document.querySelector('.nn-splash');
const holdLine = () => document.querySelector('.workspace-loading--hold');

/** The counts of drawn nodes after each batch of DOM changes (one React commit is one batch). */
function watchNodeCounts(): { counts: number[]; stop: () => void } {
  const counts: number[] = [];
  const observer = new MutationObserver(() => { counts.push(domNodes().length); });
  observer.observe(document.body, { childList: true, subtree: true });
  return { counts, stop: () => observer.disconnect() };
}

async function settle(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }

const loadCharacter = async (index = 0) => { chunkLoads.character[index].resolve(await import('../src/components/nodes/CharacterNode')); await settle(); };
const loadJev = async (index = 0) => { chunkLoads.jev[index].resolve(await import('../src/components/nodes/JevResult')); await settle(); };

function mount() { return render(<ReactFlowProvider><div style={{ width: 1200, height: 800 }}><Canvas /></div></ReactFlowProvider>); }

const initialGraph = useGraphStore.getState();
const initialUI = useUIStore.getState();

beforeEach(() => {
  chunkLoads.renew();
  chunkLoads.character.length = 0;
  chunkLoads.jev.length = 0;
  fitView.mockClear();
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
  useStoredAssetsStore.setState({ entries: { 'character:c1': { status: 'ready', summary: { id: 'c1', name: 'Mara', thumbnail: '/api/outputs/c1.png' } } } });
  useUIStore.setState({ skin: 'slava-restraint', viewMode: 'canvas', onboardingActive: false, selectedNodeId: null, canvasFocusRequest: null,
    canvasViewport: { x: 0, y: 0, zoom: 1 }, canvasPerfMode: false });
  useGraphStore.setState({ nodes: [], edges: [], isExecuting: false, undoStack: [], redoStack: [] });
});
afterEach(() => {
  cleanup();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
  vi.unstubAllGlobals();
});

describe('a whole graph arrives while its card chunks are pending', () => {
  it('draws no node or wire and no empty-canvas splash, then everything in the same commit', async () => {
    mount();
    expect(splash()).not.toBeNull();
    act(() => useGraphStore.getState().loadGraph([text(), character(), decided()], [wire('n1', 'text', 'n3', 'state'), wire('n2', 'character', 'n3', 'through')]));
    await settle();

    expect(domNodes()).toEqual([]);
    expect(domEdges()).toBe(0);
    expect(splash()).toBeNull();
    expect(holdLine()).not.toBeNull();
    // The line the app shows while the workspace itself loads (App.tsx).
    expect(holdLine()?.textContent).toBe('Loading workspace…');
    expect(holdLine()?.getAttribute('role')).toBe('status');
    // Both chunks were asked for by the hold itself.
    expect(chunkLoads.character.length).toBeGreaterThan(0);
    expect(chunkLoads.jev.length).toBeGreaterThan(0);

    const watch = watchNodeCounts();
    await loadCharacter();
    // One chunk in is not enough: the Jev card's view is still on its way.
    expect(domNodes()).toEqual([]);
    expect(domEdges()).toBe(0);
    await loadJev();
    watch.stop();

    expect(domNodes().sort()).toEqual(['n1', 'n2', 'n3']);
    expect(holdLine()).toBeNull();
    expect(splash()).toBeNull();
    // No frame between nothing and everything.
    expect(watch.counts.filter((count) => count > 0 && count < 3)).toEqual([]);
    expect(watch.counts).toContain(3);
    expect(domEdges()).toBe(2);
    expect(document.querySelector('.character-node')).not.toBeNull();
  });

  it('a graph that needs nothing deferred is not held', async () => {
    mount();
    act(() => useGraphStore.getState().loadGraph([text()], []));
    await settle();
    expect(domNodes()).toEqual(['n1']);
    expect(holdLine()).toBeNull();
  });

  it('puts the fit that ran during the hold off until the graph is drawn', async () => {
    mount();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      act(() => useGraphStore.getState().loadGraph([text(), character()], []));
      await settle();
      act(() => { window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: 2 } })); vi.advanceTimersByTime(200); });
      expect(fitView).not.toHaveBeenCalled();
      await loadCharacter();
      act(() => { vi.advanceTimersByTime(200); });
      expect(fitView).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('a node added to a graph that is already shown', () => {
  it('stays out until its chunk lands; the others keep their DOM nodes', async () => {
    mount();
    act(() => useGraphStore.getState().loadGraph([text(), shown()], []));
    await settle();
    const before = document.querySelector('.react-flow__node[data-id="n1"]');
    expect(before).not.toBeNull();

    act(() => useGraphStore.setState((state) => ({ nodes: [...state.nodes, character('n2')], edges: [wire('n2', 'character', 'n3', 'input')] })));
    await settle();
    expect(domNodes().sort()).toEqual(['n1', 'n3']);
    expect(domEdges()).toBe(0);
    expect(document.querySelector('.react-flow__node[data-id="n1"]')).toBe(before);
    // Not a whole-graph hold: the canvas shows what it showed.
    expect(holdLine()).toBeNull();

    await loadCharacter();
    expect(domNodes().sort()).toEqual(['n1', 'n2', 'n3']);
    expect(document.querySelector('.react-flow__node[data-id="n1"]')).toBe(before);
    expect(domEdges()).toBe(1);
  });
});

describe('a chunk that fails to load', () => {
  it('ends the hold: the rest is drawn, the failed card draws nothing, a later retry that works draws it', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    mount();
    act(() => useGraphStore.getState().loadGraph([text(), character(), shown()], [wire('n2', 'character', 'n3', 'input')]));
    await settle();
    expect(domNodes()).toEqual([]);

    await act(async () => { chunkLoads.character[0].reject(new Error('offline')); await Promise.resolve(); });
    await settle();
    expect(domNodes().sort()).toEqual(['n1', 'n2', 'n3']);
    expect(holdLine()).toBeNull();
    expect(document.querySelector('.character-node')).toBeNull();
    expect(document.querySelector('.react-flow__node[data-id="n2"]')?.textContent ?? '').toBe('');

    // The boundary retries on mount and on focus; fail any attempt in flight, then focus once.
    await act(async () => { for (const load of chunkLoads.character.slice(1)) load.reject(new Error('still offline')); await Promise.resolve(); });
    const attempts = chunkLoads.character.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    expect(chunkLoads.character.length).toBeGreaterThan(attempts - 1);
    await loadCharacter(chunkLoads.character.length - 1);
    expect(document.querySelector('.character-node')).not.toBeNull();
    expect(domNodes().sort()).toEqual(['n1', 'n2', 'n3']);
    quiet.mockRestore();
  });
});

describe('what the hold leaves alone', () => {
  it('the store keeps the same nodes, positions and selection, and no remove change reaches it', async () => {
    const changes: Array<{ type: string; id?: string }> = [];
    const original = useGraphStore.getState().onNodesChange;
    useGraphStore.setState({ onNodesChange: (batch) => { changes.push(...(batch as typeof changes)); original(batch); } });
    mount();
    const first = text();
    const second = { ...character(), selected: true, position: { x: 123, y: 45 } };
    const third = decided();
    act(() => useGraphStore.getState().loadGraph([first, second, third], [wire('n2', 'character', 'n3', 'through')]));
    await settle();
    const held = useGraphStore.getState().nodes;
    expect(domNodes()).toEqual([]);

    await loadCharacter();
    await loadJev();
    await settle();

    const after = useGraphStore.getState().nodes;
    expect(after.map((n) => n.id)).toEqual(held.map((n) => n.id));
    expect(after.find((n) => n.id === 'n2')?.position).toEqual({ x: 123, y: 45 });
    expect(after.find((n) => n.id === 'n2')?.selected).toBe(true);
    expect(after.filter((n) => n.selected).map((n) => n.id)).toEqual(['n2']);
    expect(changes.filter((change) => change.type === 'remove')).toEqual([]);
    // Each node was measured once it was drawn.
    for (const n of after) expect(n.measured).toMatchObject({ width: 100, height: 60 });
    expect(useGraphStore.getState().edges).toHaveLength(1);
  });

  it('a node left out later and then shown keeps its position and is measured', async () => {
    const changes: Array<{ type: string }> = [];
    const original = useGraphStore.getState().onNodesChange;
    useGraphStore.setState({ onNodesChange: (batch) => { changes.push(...(batch as typeof changes)); original(batch); } });
    mount();
    act(() => useGraphStore.getState().loadGraph([text()], []));
    await settle();
    act(() => useGraphStore.setState((state) => ({ nodes: [...state.nodes, { ...character('n2'), position: { x: 700, y: 20 } }] })));
    await settle();
    await loadCharacter();
    const added = useGraphStore.getState().nodes.find((n) => n.id === 'n2')!;
    expect(added.position).toEqual({ x: 700, y: 20 });
    expect(added.measured).toMatchObject({ width: 100, height: 60 });
    expect(changes.filter((change) => change.type === 'remove')).toEqual([]);
  });

  it('a shown graph replaced by one that is held: nothing is removed from the store, and the new graph is drawn whole when it lands', async () => {
    const changes: Array<{ type: string }> = [];
    const original = useGraphStore.getState().onNodesChange;
    useGraphStore.setState({ onNodesChange: (batch) => { changes.push(...(batch as typeof changes)); original(batch); } });
    mount();
    act(() => useGraphStore.getState().loadGraph([text(), shown()], []));
    await settle();
    expect(domNodes().sort()).toEqual(['n1', 'n3']);

    act(() => useGraphStore.getState().loadGraph([node('n5', 'text-input', 'model-node'), character('n6')], []));
    await settle();
    expect(domNodes()).toEqual([]);
    expect(holdLine()).not.toBeNull();
    expect(useGraphStore.getState().nodes.map((n) => n.id).sort()).toEqual(['n5', 'n6']);

    await loadCharacter();
    expect(domNodes().sort()).toEqual(['n5', 'n6']);
    expect(holdLine()).toBeNull();
    expect(changes.filter((change) => change.type === 'remove')).toEqual([]);
    expect(useGraphStore.getState().nodes.map((n) => n.id).sort()).toEqual(['n5', 'n6']);
  });
});
