import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider, type Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 8, M-1: React Flow's own Delete and Backspace listen on the document
// and never asked whether a modal dialog is open, so with focus on the
// placeholder dialog's Cancel (or on the page) a selected node behind it was
// deleted. The real canvas (Canvas.tsx with React Flow) must leave the graph
// untouched while any modal dialog is open, and still delete when none is,
// including right after one closes (a key whose keyup came while a dialog
// was open must not leave the delete key stuck).

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/backend')>(),
  apiFetch: apiFetchMock,
  getCachedBackendBaseUrl: () => null,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
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
vi.mock('../src/components/ConnectionPopup', () => ({ ConnectionPopup: () => null }));
vi.mock('../src/lib/canvasSelection', () => ({
  selectedNodeIds: (nodes: Node<NodeData>[]) => nodes.filter((node) => node.selected).map((node) => node.id),
  publishCanvasSelection: vi.fn().mockResolvedValue(undefined),
}));

import { Canvas } from '../src/components/Canvas';
import { PlaceholderRunDialog } from '../src/components/PlaceholderRunDialog';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import type { PlaceholderRunConfirm } from '../src/lib/placeholderRunConfirm';

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
const codex = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true };
const model: PlaceholderRunConfirm = {
  heading: 'Run 1 node Codex is still setting up?', intro: "Codex hasn't finished this, so its settings may not be final.",
  savedLine: null, leftLine: null,
  rows: [{ nodeId: 'n1', name: '“Still”', model: 'FLUX.2 [pro]', price: '$0.03', agent: codex }], freeLine: null,
  totalLine: 'This run could cost up to $0.03 at list prices.', notes: [], costNotes: [], runLabel: 'Run for $0.03',
  confirmIds: ['n1'], confirmCost: 0.03,
};

function canvasNode(id: string, selected = false): Node<NodeData> {
  return { id, position: { x: 100, y: 100 }, selected, width: 120, height: 60,
    data: { label: id, definitionId: 'text-input', params: {}, state: 'idle', outputs: {} } } as Node<NodeData>;
}
const ids = () => useGraphStore.getState().nodes.map((node) => node.id);

async function press(target: Element, key: 'Backspace' | 'Delete') {
  await act(async () => {
    fireEvent.keyDown(target, { key, code: key });
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  await act(async () => {
    fireEvent.keyUp(target, { key, code: key });
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function renderCanvas() {
  return render(
    <div style={{ width: 1280, height: 800 }}>
      <ReactFlowProvider><Canvas /></ReactFlowProvider>
    </div>,
  );
}

describe('the canvas delete keys behind an open modal dialog', () => {
  beforeEach(() => {
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useUIStore.setState({ ...initialUI, viewMode: 'canvas' }, true);
    useGraphStore.setState({ nodes: [canvasNode('a', true), canvasNode('b')], edges: [], isExecuting: false,
      undoStack: [], redoStack: [], undoNotice: null, messageNotice: null } as never);
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
  });

  it('control: with no dialog, Backspace on the page deletes the selected node', async () => {
    renderCanvas();
    await press(document.body, 'Backspace');
    expect(ids()).toEqual(['b']);
  });

  it.each(['Backspace', 'Delete'] as const)('%s with focus on the dialog\'s Cancel leaves the canvas untouched', async (key) => {
    renderCanvas();
    render(<PlaceholderRunDialog model={model} onDone={() => {}} />);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveFocus();
    await press(cancel, key);
    expect(ids()).toEqual(['a', 'b']);
    expect(useGraphStore.getState().nodes.find((node) => node.id === 'a')?.selected).toBe(true);
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  it.each(['Backspace', 'Delete'] as const)('%s with focus fallen to the page leaves the canvas untouched', async (key) => {
    renderCanvas();
    render(<PlaceholderRunDialog model={model} onDone={() => {}} />);
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    await press(document.body, key);
    expect(ids()).toEqual(['a', 'b']);
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  it('once the dialog closes, Delete works again', async () => {
    renderCanvas();
    const dialog = render(<PlaceholderRunDialog model={model} onDone={() => {}} />);
    await press(screen.getByRole('button', { name: 'Cancel' }), 'Delete');
    expect(ids()).toEqual(['a', 'b']);
    dialog.unmount();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    await press(document.body, 'Delete');
    expect(ids()).toEqual(['b']);
  });

  it('as React Flow did: a selected wire alone goes too; a text field and a held key keep their own', async () => {
    useGraphStore.setState({ nodes: [canvasNode('a'), canvasNode('b')],
      edges: [{ id: 'w', source: 'a', target: 'b', selected: true }] } as never);
    renderCanvas();
    const field = document.createElement('textarea');
    document.querySelector('.canvas-wrapper')!.appendChild(field);
    await press(field, 'Backspace');
    expect(useGraphStore.getState().edges.map((edge) => edge.id)).toEqual(['w']);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: 'Delete', code: 'Delete', repeat: true });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(useGraphStore.getState().edges.map((edge) => edge.id)).toEqual(['w']);
    await press(document.body, 'Delete');
    expect(useGraphStore.getState().edges).toEqual([]);
    expect(ids()).toEqual(['a', 'b']);
  });
});
