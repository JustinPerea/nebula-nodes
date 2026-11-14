/**
 * The hold at the canvas (lib/cardHold.ts): a node whose card chunks have not
 * settled is not handed to React Flow, so nothing in a canvas's first frame
 * pops in later. These tests mount the real Canvas in a real React Flow with
 * the card chunks under the test's control (each load is a promise the test
 * settles), and read the DOM and the graph store.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { useCanvasRevealStore } from '../src/store/canvasRevealStore';
import { JEV_DECIDE } from '../src/lib/jev';
import { HOLD_CEILING_MS } from '../src/lib/cardHold';

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
const holdLine = () => document.querySelector('.canvas-hold-line');
const holdStatus = () => document.querySelector('.canvas-hold-status');
const wrapper = () => document.querySelector('.canvas-wrapper') as HTMLElement;
const fallbacks = () => [...document.querySelectorAll('[data-card-fallback=""]')].map((el) => el.closest('.react-flow__node')?.getAttribute('data-id'));
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

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
  useCanvasRevealStore.setState({ covered: false });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  useGraphStore.setState(initialGraph, true);
  useUIStore.setState(initialUI, true);
  vi.unstubAllGlobals();
});

describe('a whole graph arrives while its card chunks are pending', () => {
  it('draws no node or wire and no empty-canvas splash, then everything in the same commit', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      expect(splash()).not.toBeNull();
      act(() => useGraphStore.getState().loadGraph([text(), character(), decided()], [wire('n1', 'text', 'n3', 'state'), wire('n2', 'character', 'n3', 'through')]));
      await settle();

      expect(domNodes()).toEqual([]);
      expect(domEdges()).toBe(0);
      expect(splash()).toBeNull();
      // The live region is in the DOM and empty from the start of the cover; the line waits out its 400 ms, then reads "Loading canvas…".
      expect(holdStatus()).not.toBeNull();
      expect(holdStatus()?.textContent).toBe('');
      expect(holdLine()).toBeNull();
      advance(399);
      expect(holdLine()).toBeNull();
      advance(1);
      expect(holdLine()).not.toBeNull();
      expect(holdLine()?.textContent).toBe('Loading canvas…');
      // The line sits in the live region, which was there (empty) before the text.
      expect(holdStatus()?.getAttribute('role')).toBe('status');
      expect(holdStatus()?.getAttribute('aria-live')).toBe('polite');
      expect(holdLine()?.getAttribute('role')).toBeNull();
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
      expect(splash()).toBeNull();
      // No frame between nothing and everything.
      expect(watch.counts.filter((count) => count > 0 && count < 3)).toEqual([]);
      expect(watch.counts).toContain(3);
      expect(domEdges()).toBe(2);
      expect(document.querySelector('.character-node')).not.toBeNull();
    } finally { vi.useRealTimers(); }
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
      // A whole graph's fit runs without animation, before its layer fades in.
      expect(fitView).toHaveBeenCalledWith(expect.objectContaining({ duration: 0 }));
    } finally { vi.useRealTimers(); }
  });
});

describe('a node added to a graph that is already shown', () => {
  it('is handed over at once as a fallback frame with its name, ports and wires, and no line; the real card replaces it', async () => {
    mount();
    act(() => useGraphStore.getState().loadGraph([text(), shown()], []));
    await settle();
    const before = document.querySelector('.react-flow__node[data-id="n1"]');
    expect(before).not.toBeNull();

    act(() => useGraphStore.setState((state) => ({ nodes: [...state.nodes, character('n2')], edges: [wire('n2', 'character', 'n3', 'input')] })));
    await settle();
    expect(domNodes().sort()).toEqual(['n1', 'n2', 'n3']);
    expect(fallbacks()).toEqual(['n2']);
    const frame = document.querySelector('.react-flow__node[data-id="n2"] [data-card-fallback=""]') as HTMLElement;
    expect(frame.querySelector('.node-card-boundary__label')?.textContent).toBe('n2');
    expect(frame.querySelector('.react-flow__handle[data-handleid="character"]')).not.toBeNull();
    expect(frame.querySelector('.card-fallback__line')).toBeNull();
    // Sized (this test's observer reports 100 x 60 for everything; the sizes by type are in tests/cardFallback.test.tsx).
    expect(frame.style.width).toMatch(/px$/);
    expect(domEdges()).toBe(1);
    expect(document.querySelector('.react-flow__node[data-id="n1"]')).toBe(before);
    // Not a whole-graph hold: the canvas shows what it showed.
    expect(holdLine()).toBeNull();
    expect(wrapper().className).not.toContain('reveal');

    await loadCharacter();
    expect(document.querySelector('.character-node')).not.toBeNull();
    expect(fallbacks()).toEqual([]);
    expect(domEdges()).toBe(1);
    expect(document.querySelector('.react-flow__node[data-id="n1"]')).toBe(before);
  });

  it('crossfades: a ghost of the frame lies over the arriving card, then goes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      act(() => useGraphStore.getState().loadGraph([text(), shown()], []));
      await settle();
      act(() => useGraphStore.setState((state) => ({ nodes: [...state.nodes, character('n2')] })));
      await settle();
      await loadCharacter();
      const node = document.querySelector('.react-flow__node[data-id="n2"]') as HTMLElement;
      // The card stays the node element's first child; the ghost is its sibling and has no handles of its own.
      expect(node.firstElementChild?.classList.contains('character-node')).toBe(true);
      const ghost = node.querySelector(':scope > [data-card-fallback="ghost"]');
      expect(ghost).not.toBeNull();
      expect(ghost?.querySelector('.react-flow__handle')).toBeNull();
      expect(ghost?.querySelector('.node-card-boundary__label')?.textContent).toBe('n2');
      advance(1000);
      expect(node.querySelector('[data-card-fallback]')).toBeNull();
      expect(node.firstElementChild?.classList.contains('character-node')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('a node with a size of its own keeps it in the frame', async () => {
    mount();
    act(() => useGraphStore.getState().loadGraph([text()], []));
    await settle();
    act(() => useGraphStore.setState((state) => ({ nodes: [...state.nodes, { ...character('n2'), width: 333, height: 222 }] })));
    await settle();
    const frame = document.querySelector('.react-flow__node[data-id="n2"] [data-card-fallback=""]') as HTMLElement;
    expect(frame.style.width).toBe('333px');
    expect(frame.style.minHeight).toBe('222px');
  });
});

const frameOf = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"] [data-card-fallback=""]`) as HTMLElement | null;
const ONLINE_LINE = 'Nebula couldn’t load this node because part of the app didn’t download. Reload the page to try again.';
const OFFLINE_LINE = 'Nebula couldn’t load this node because you’re offline. It’ll try again when you’re back online.';

describe('a chunk that fails to load', () => {
  it('ends the hold: the rest is drawn, the failed card is a fallback card with its name, ports and the online line, a later retry that works draws the real card', async () => {
    // Fake timers: a slow machine must not let the 400 ms line come due while the test runs.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
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
    const frame = frameOf('n2')!;
    expect(frame.querySelector('.node-card-boundary__label')?.textContent).toBe('n2');
    expect(frame.querySelector('.react-flow__handle[data-handleid="character"]')).not.toBeNull();
    expect(frame.querySelector('.card-fallback__line')?.textContent).toBe(ONLINE_LINE);
    // The wire into the shown card is drawn.
    expect(domEdges()).toBe(1);

    // The fallback card retries on mount and on focus; fail any attempt in flight, then focus once.
    await act(async () => { for (const load of chunkLoads.character.slice(1)) load.reject(new Error('still offline')); await Promise.resolve(); });
    await settle();
    const attempts = chunkLoads.character.length;
    await act(async () => { window.dispatchEvent(new Event('focus')); await Promise.resolve(); });
    expect(chunkLoads.character.length).toBeGreaterThan(attempts - 1);
    await loadCharacter(chunkLoads.character.length - 1);
    expect(document.querySelector('.character-node')).not.toBeNull();
    expect(frameOf('n2')).toBeNull();
    expect(domNodes().sort()).toEqual(['n1', 'n2', 'n3']);
    expect(domEdges()).toBe(1);
    quiet.mockRestore();
    vi.useRealTimers();
  });

  it('says so when the browser is offline, and tries again when it is back', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    mount();
    act(() => useGraphStore.getState().loadGraph([text(), character()], []));
    await settle();
    await act(async () => { chunkLoads.character[0].reject(new Error('offline')); await Promise.resolve(); });
    await settle();
    expect(frameOf('n2')?.querySelector('.card-fallback__line')?.textContent).toBe(OFFLINE_LINE);
    // Neutral text, never the error red.
    expect(frameOf('n2')?.querySelector('.card-fallback__line')?.getAttribute('class')).not.toMatch(/error|danger/);

    online.mockReturnValue(true);
    const attempts = chunkLoads.character.length;
    await act(async () => { window.dispatchEvent(new Event('online')); await Promise.resolve(); });
    expect(chunkLoads.character.length).toBe(attempts + 1);
    await loadCharacter(chunkLoads.character.length - 1);
    expect(document.querySelector('.character-node')).not.toBeNull();
    expect(frameOf('n2')).toBeNull();
    online.mockRestore();
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
    expect(useGraphStore.getState().nodes.map((n) => n.id).sort()).toEqual(['n5', 'n6']);

    await loadCharacter();
    expect(domNodes().sort()).toEqual(['n5', 'n6']);
    expect(changes.filter((change) => change.type === 'remove')).toEqual([]);
    expect(useGraphStore.getState().nodes.map((n) => n.id).sort()).toEqual(['n5', 'n6']);
  });
});

describe('what a fallback frame leaves alone', () => {
  it('a loading frame and a failed one write nothing to the store: nodes, positions, selection and wires stay, no remove change', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const changes: Array<{ type: string; id?: string }> = [];
    const original = useGraphStore.getState().onNodesChange;
    useGraphStore.setState({ onNodesChange: (batch) => { changes.push(...(batch as typeof changes)); original(batch); } });
    mount();
    act(() => useGraphStore.getState().loadGraph([text(), shown()], []));
    await settle();
    act(() => useGraphStore.setState((state) => ({
      nodes: [...state.nodes, { ...character('n2'), selected: true, position: { x: 123, y: 45 } }],
      edges: [wire('n2', 'character', 'n3', 'input')],
    })));
    await settle();
    expect(fallbacks()).toEqual(['n2']);
    const check = () => {
      const stored = useGraphStore.getState().nodes;
      expect(stored.map((n) => n.id).sort()).toEqual(['n1', 'n2', 'n3']);
      expect(stored.find((n) => n.id === 'n2')?.position).toEqual({ x: 123, y: 45 });
      expect(stored.find((n) => n.id === 'n2')?.type).toBe('characterNode');
      expect(stored.filter((n) => n.selected).map((n) => n.id)).toEqual(['n2']);
      expect(useGraphStore.getState().edges).toHaveLength(1);
      expect(changes.filter((change) => change.type === 'remove')).toEqual([]);
    };
    check();
    // The frame is the selected one too.
    expect(frameOf('n2')?.classList.contains('node-card-boundary--selected')).toBe(true);

    // It fails: still the same store.
    await act(async () => { chunkLoads.character[0].reject(new Error('offline')); await Promise.resolve(); });
    await settle();
    expect(frameOf('n2')?.querySelector('.card-fallback__line')).not.toBeNull();
    check();
    await act(async () => { for (const load of chunkLoads.character.slice(1)) load.reject(new Error('x')); await Promise.resolve(); });
    await loadCharacter(chunkLoads.character.length - 1).catch(() => {});
    quiet.mockRestore();
  });
});

describe('the hold line and the reveal of a whole graph', () => {
  const holdLinesEver = () => {
    const seen: string[] = [];
    const observer = new MutationObserver(() => { const el = holdLine(); if (el) seen.push(el.textContent ?? ''); });
    observer.observe(document.body, { childList: true, subtree: true });
    return { seen, stop: () => observer.disconnect() };
  };

  it('a hold shorter than 400 ms never draws the line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      const watch = holdLinesEver();
      act(() => useGraphStore.getState().loadGraph([text(), character()], []));
      await settle();
      advance(399);
      await loadCharacter();
      advance(2000);
      watch.stop();
      expect(watch.seen).toEqual([]);
      expect(domNodes().sort()).toEqual(['n1', 'n2']);
    } finally { vi.useRealTimers(); }
  });

  it('the node layer is covered through the hold and fades in on the spring once drawn, then the class goes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      act(() => useGraphStore.getState().loadGraph([text(), character()], []));
      await settle();
      expect(wrapper().classList.contains('canvas-wrapper--reveal-wait')).toBe(true);
      expect(useCanvasRevealStore.getState().covered).toBe(true);
      advance(400);
      const line = holdLine()!;
      expect(line.classList.contains('canvas-hold-line--out')).toBe(false);
      await loadCharacter();
      // Handed over, measured, no fit pending (the saved camera): the layer fades in and the line fades out together.
      expect(domNodes().sort()).toEqual(['n1', 'n2']);
      expect(wrapper().classList.contains('canvas-wrapper--reveal-wait')).toBe(false);
      expect(wrapper().classList.contains('canvas-wrapper--reveal-in')).toBe(true);
      expect(holdLine()?.classList.contains('canvas-hold-line--out')).toBe(true);
      expect(useCanvasRevealStore.getState().covered).toBe(false);
      // The spring comes from the wrapper's variables.
      expect(wrapper().style.getPropertyValue('--spring-soft')).toMatch(/^linear\(/);
      advance(1000);
      expect(wrapper().className).not.toContain('reveal');
      expect(holdLine()).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it('under reduced motion the fade lasts 180 ms', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      act(() => useGraphStore.getState().loadGraph([text(), character()], []));
      await settle();
      await loadCharacter();
      expect(wrapper().classList.contains('canvas-wrapper--reveal-in')).toBe(true);
      advance(179);
      expect(wrapper().classList.contains('canvas-wrapper--reveal-in')).toBe(true);
      advance(1);
      expect(wrapper().classList.contains('canvas-wrapper--reveal-in')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('a held graph replaced by an empty canvas is uncovered at once, and the line never shows', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      const watch = holdLinesEver();
      act(() => useGraphStore.getState().loadGraph([text(), character()], []));
      await settle();
      expect(useCanvasRevealStore.getState().covered).toBe(true);
      advance(100);
      act(() => useGraphStore.getState().loadGraph([], []));
      await settle();
      expect(wrapper().classList.contains('canvas-wrapper--reveal-wait')).toBe(false);
      expect(useCanvasRevealStore.getState().covered).toBe(false);
      advance(2000);
      watch.stop();
      expect(watch.seen).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('a fit asked during the hold runs before the layer is shown, and the layer stays covered until it has', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finishFit: () => void = () => {};
    fitView.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFit = () => resolve(true); }));
    try {
      mount();
      act(() => useGraphStore.getState().loadGraph([text(), character()], []));
      await settle();
      act(() => { window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: 2 } })); });
      advance(10);
      expect(fitView).not.toHaveBeenCalled();
      await loadCharacter();
      advance(10);
      expect(fitView).toHaveBeenCalledWith(expect.objectContaining({ duration: 0 }));
      // Nodes are in React Flow's tree but the fit has not finished: covered.
      expect(wrapper().classList.contains('canvas-wrapper--reveal-wait')).toBe(true);
      expect(useCanvasRevealStore.getState().covered).toBe(true);
      await act(async () => { finishFit(); await Promise.resolve(); await Promise.resolve(); });
      expect(wrapper().classList.contains('canvas-wrapper--reveal-wait')).toBe(false);
      expect(wrapper().classList.contains('canvas-wrapper--reveal-in')).toBe(true);
      expect(useCanvasRevealStore.getState().covered).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});

describe('the ceiling of a whole-graph hold', () => {
  it('a chunk that never answers does not keep the graph off the canvas: at 8,000 ms the graph is handed over, the waiting node as a frame, and its card replaces the frame when it lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      act(() => useGraphStore.getState().loadGraph([text(), character(), shown()], [wire('n2', 'character', 'n3', 'input')]));
      await settle();
      advance(7999);
      expect(domNodes()).toEqual([]);
      expect(domEdges()).toBe(0);
      expect(holdStatus()).not.toBeNull();
      expect(HOLD_CEILING_MS).toBe(8000);
      advance(1);
      await settle();
      expect(domNodes().sort()).toEqual(['n1', 'n2', 'n3']);
      expect(fallbacks()).toEqual(['n2']);
      // A waiting frame, not a failed one: no line in it. The wire is drawn.
      expect(frameOf('n2')?.querySelector('.card-fallback__line')).toBeNull();
      expect(domEdges()).toBe(1);

      await loadCharacter();
      expect(document.querySelector('.character-node')).not.toBeNull();
      expect(fallbacks()).toEqual([]);
      expect(domEdges()).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  it('a new graph starts a new ceiling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      act(() => useGraphStore.getState().loadGraph([text(), character()], []));
      await settle();
      advance(5000);
      act(() => useGraphStore.getState().loadGraph([node('n5', 'text-input', 'model-node'), character('n6')], []));
      await settle();
      advance(5000);
      // 10,000 ms after the first graph, 5,000 after the second.
      expect(domNodes()).toEqual([]);
      advance(3000);
      await settle();
      expect(domNodes().sort()).toEqual(['n5', 'n6']);
    } finally { vi.useRealTimers(); }
  });
});

describe('the fit of a held graph', () => {
  it('an event dispatched in the same tick as the load, before React renders, ends in one instant fit that runs before the reveal, and no animated one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finishFit: () => void = () => {};
    fitView.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFit = () => resolve(true); }));
    try {
      mount();
      act(() => {
        // As the store does: the event goes out inside the update, before any render.
        window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: 2 } }));
        useGraphStore.getState().loadGraph([text(), character()], []);
      });
      await settle();
      advance(500);
      expect(fitView).not.toHaveBeenCalled();
      await loadCharacter();
      advance(10);
      expect(fitView).toHaveBeenCalledTimes(1);
      expect(fitView).toHaveBeenCalledWith(expect.objectContaining({ duration: 0 }));
      expect(wrapper().classList.contains('canvas-wrapper--reveal-wait')).toBe(true);
      await act(async () => { finishFit(); await Promise.resolve(); await Promise.resolve(); });
      expect(wrapper().classList.contains('canvas-wrapper--reveal-in')).toBe(true);
      advance(2000);
      expect(fitView).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('a held graph whose nodes already carry a measured size stays covered until the stashed fit has run', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finishFit: () => void = () => {};
    fitView.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFit = () => resolve(true); }));
    const measured = { measured: { width: 100, height: 60 } };
    try {
      mount();
      act(() => useGraphStore.getState().loadGraph([{ ...text(), ...measured }, { ...character(), ...measured }], []));
      await settle();
      act(() => { window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: 2 } })); });
      advance(10);
      expect(fitView).not.toHaveBeenCalled();
      await loadCharacter();
      // Handed over and measured at once; the fit is owed, so no reveal yet.
      expect(domNodes().sort()).toEqual(['n1', 'n2']);
      expect(wrapper().classList.contains('canvas-wrapper--reveal-wait')).toBe(true);
      expect(wrapper().classList.contains('canvas-wrapper--reveal-in')).toBe(false);
      advance(10);
      expect(fitView).toHaveBeenCalledTimes(1);
      expect(wrapper().classList.contains('canvas-wrapper--reveal-wait')).toBe(true);
      await act(async () => { finishFit(); await Promise.resolve(); await Promise.resolve(); });
      expect(wrapper().classList.contains('canvas-wrapper--reveal-in')).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('a fit that owes nothing ends without cancelling the fit a held graph is owed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let finishFit: () => void = () => {};
    const measured = { measured: { width: 100, height: 60 } };
    try {
      mount();
      act(() => useGraphStore.getState().loadGraph([text(), shown()], []));
      await settle();
      advance(2000);
      // A fit for the shown graph is waiting on its 80 ms timer...
      act(() => { window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: 2 } })); });
      advance(10);
      // ...when a whole graph arrives, is held, and asks for its own fit.
      act(() => useGraphStore.getState().loadGraph([{ ...text(), ...measured }, { ...character(), ...measured }], []));
      await settle();
      act(() => { window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: 2 } })); });
      advance(10);
      // The first fit's timer ends (it owes nothing): the held graph's fit is still owed.
      advance(100);
      fitView.mockClear();
      fitView.mockImplementationOnce(() => new Promise<boolean>((resolve) => { finishFit = () => resolve(true); }));
      await loadCharacter();
      expect(domNodes().sort()).toEqual(['n1', 'n2']);
      expect(wrapper().classList.contains('canvas-wrapper--reveal-wait')).toBe(true);
      expect(useCanvasRevealStore.getState().covered).toBe(true);
      advance(10);
      expect(fitView).toHaveBeenCalledTimes(1);
      expect(fitView).toHaveBeenCalledWith(expect.objectContaining({ duration: 0 }));
      expect(useCanvasRevealStore.getState().covered).toBe(true);
      await act(async () => { finishFit(); await Promise.resolve(); await Promise.resolve(); });
      expect(useCanvasRevealStore.getState().covered).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('a fit asked for a node added to a shown graph runs as on main, at once, not after its chunk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      act(() => useGraphStore.getState().loadGraph([text(), shown()], []));
      await settle();
      act(() => useGraphStore.setState((state) => ({ nodes: [...state.nodes, character('n2')] })));
      await settle();
      expect(fallbacks()).toEqual(['n2']);
      act(() => { window.dispatchEvent(new CustomEvent('nebula:graph-nodes-added', { detail: { totalCount: 3 } })); });
      advance(200);
      expect(fitView).toHaveBeenCalledTimes(1);
      expect(fitView).toHaveBeenCalledWith(expect.objectContaining({ duration: 400 }));
    } finally { vi.useRealTimers(); }
  });
});

describe('the live region of the hold line', () => {
  it('is in the DOM, empty, from the start of the cover until the line has faded out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mount();
      expect(holdStatus()).toBeNull();
      act(() => useGraphStore.getState().loadGraph([text(), character()], []));
      await settle();
      const region = holdStatus();
      expect(region?.textContent).toBe('');
      advance(400);
      // The same element, now holding the text.
      expect(holdStatus()).toBe(region);
      expect(region?.textContent).toBe('Loading canvas…');
      await loadCharacter();
      // The reveal is on: the line fades out inside the region, which stays.
      expect(holdStatus()).toBe(region);
      expect(holdLine()?.classList.contains('canvas-hold-line--out')).toBe(true);
      advance(1000);
      expect(holdStatus()).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});

describe('the hold line and reveal styles', () => {
  const css = readFileSync(join(__dirname, '../src/styles/canvas.css'), 'utf8');
  const rule = (selector: string, from = 0) => {
    const at = css.indexOf(`\n${selector} {`, from);
    return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it('the line paints no background and does not use the app loading line that does', () => {
    const status = rule('.canvas-hold-status');
    expect(status).not.toBe('');
    expect(status).not.toMatch(/background/);
    expect(status).toMatch(/position:\s*absolute/);
    const line = rule('.canvas-hold-line');
    expect(line).not.toBe('');
    expect(line).not.toMatch(/background/);
    expect(line).toMatch(/var\(--spring-soft\)/);
    expect(css).not.toMatch(/workspace-loading--hold/);
  });

  it('covered nodes are not live: the covered node layer is hidden, not only transparent', () => {
    const layer = rule('.canvas-wrapper--reveal-wait .react-flow__viewport');
    expect(layer).toMatch(/opacity:\s*0;/);
    // React Flow puts `visibility: visible` inline on every measured node, so a value the
    // nodes inherit from the layer loses: the rule names the descendants and is !important.
    expect(css).toMatch(/\.canvas-wrapper--reveal-wait \.react-flow__viewport,\s*\.canvas-wrapper--reveal-wait \.react-flow__viewport \* \{\s*visibility: hidden !important;\s*\}/);
    // The reveal's fade is on the layer that is shown again.
    expect(rule('.canvas-wrapper--reveal-in .react-flow__viewport')).not.toMatch(/visibility:\s*hidden/);
  });

  it('the reduced-motion rules are 180 ms opacity fades, as the proposal bar', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)', css.indexOf('.canvas-hold-line')));
    expect(reduced).toMatch(/\.canvas-hold-line \{\s*animation: notice-fade-in 180ms ease-out both;/);
    expect(reduced).toMatch(/\.canvas-wrapper--reveal-in \.react-flow__viewport \{\s*animation: notice-fade-in 180ms ease-out both;/);
    // Opacity only: no transform or scale in either fade.
    expect(css.slice(css.indexOf('@keyframes canvas-reveal-in'), css.indexOf('@keyframes canvas-reveal-in') + 80)).not.toMatch(/transform|scale/);
  });
});

describe('the crossfade styles', () => {
  const css = readFileSync(join(__dirname, '../src/styles/card-fallback.css'), 'utf8');

  it('fade the card in and the ghost out on the SOFT spring, opacity only, and 180 ms under reduced motion', () => {
    expect(css).toMatch(/\.react-flow__node:has\(> \.card-fallback--ghost\) > :first-child \{\s*animation: card-swap-in var\(--spring-soft-ms\) var\(--spring-soft\) both;/);
    expect(css).toMatch(/\.card-fallback\.card-fallback--ghost \{[^}]*animation: card-swap-out var\(--spring-soft-ms\) var\(--spring-soft\) both;/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/animation: notice-fade-in 180ms ease-out both;/);
    expect(reduced).toMatch(/animation: card-swap-out 180ms ease-out both;/);
    expect(css.slice(css.indexOf('@keyframes card-swap-in'))).not.toMatch(/transform|scale/);
  });

  it('the ghost\'s rule outweighs every other rule that positions the fallback card, so it lies over the card and not under it', () => {
    // Specificity as [ids, classes and pseudo-classes, elements]; :has() and :not() count their argument.
    const specificity = (selector: string): number[] => {
      const flat = selector.replace(/:(?:has|not|is|where)\(([^)]*)\)/g, ' $1 ');
      const classes = (flat.match(/\.[\w-]+|\[[^\]]*\]|:(?!:)[\w-]+/g) ?? []).length;
      const elements = (flat.replace(/\.[\w-]+|\[[^\]]*\]|::?[\w-]+|#[\w-]+/g, ' ').match(/[a-zA-Z][\w-]*/g) ?? []).length;
      return [(flat.match(/#[\w-]+/g) ?? []).length, classes, elements];
    };
    const beats = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    const rules = [...css.split('@media')[0].matchAll(/(?:^|\n)([^\n{}@/*][^{}]*)\{([^}]*)\}/g)]
      .map((match) => ({ selector: match[1].trim(), body: match[2] }))
      .filter((found) => /\.card-fallback(?![\w-])/.test(found.selector) && /(?:^|\s)position:/.test(found.body));
    const ghost = rules.find((found) => found.selector.includes('card-fallback--ghost'));
    const others = rules.filter((found) => found !== ghost);
    expect(ghost).toBeDefined();
    expect(others.length).toBeGreaterThan(0);
    for (const other of others) expect(beats(specificity(ghost!.selector), specificity(other.selector)), other.selector).toBeGreaterThan(0);
  });

  it('the ghost takes the arriving card\'s box: the frame\'s usual width and height are dropped', () => {
    const ghost = css.match(/\n\.react-flow__node > \.card-fallback\.card-fallback--ghost \{([^}]*)\}/)?.[1] ?? '';
    expect(ghost).toMatch(/position: absolute;/);
    expect(ghost).toMatch(/inset: 0;/);
    expect(ghost).toMatch(/width: auto !important;/);
    expect(ghost).toMatch(/min-height: 0 !important;/);
  });
});
