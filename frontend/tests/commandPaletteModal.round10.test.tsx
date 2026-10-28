import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReactFlowProvider, type Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

// Review 9, L-1: the command palette covers the window but was no modal
// dialog: a click on a group label put focus on the page, and Backspace then
// deleted the selected node behind it (Cmd+Enter, Cmd+Z, Cmd+D the same way).
// It is now a labelled modal dialog that keeps focus, so no canvas key acts
// behind it; Cmd+K still closes it.

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
import { CommandPalette } from '../src/components/CommandPalette';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
function canvasNode(id: string, selected = false): Node<NodeData> {
  return { id, position: { x: 100, y: 100 }, selected, width: 120, height: 60,
    data: { label: id, definitionId: 'text-input', params: {}, state: 'idle', outputs: {} } } as Node<NodeData>;
}
const ids = () => useGraphStore.getState().nodes.map((node) => node.id);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
const openPalette = async () => {
  act(() => { fireEvent.keyDown(document, { key: 'k', metaKey: true }); });
  await settle();
  return document.querySelector('.command-palette') as HTMLElement;
};

describe('the command palette is a modal dialog', () => {
  beforeEach(() => {
    apiFetchMock.mockReset().mockRejectedValue(new TypeError('Offline fixture'));
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    useUIStore.setState({ ...initialUI, viewMode: 'canvas' }, true);
    useGraphStore.setState({ nodes: [canvasNode('a', true), canvasNode('b')], edges: [], isExecuting: false,
      undoStack: [], redoStack: [], undoNotice: null, messageNotice: null } as never);
    render(<div style={{ width: 1280, height: 800 }}><ReactFlowProvider><Canvas /><CommandPalette /></ReactFlowProvider></div>);
  });
  afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useUIStore.setState(initialUI, true);
    useGraphStore.setState(initialGraph, true);
  });

  it('is labelled and modal, focus in its search field', async () => {
    await openPalette();
    const dialog = screen.getByRole('dialog', { name: 'Search commands and nodes' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByPlaceholderText('Search commands and nodes…')).toHaveFocus();
  });

  it('a click on a group label: focus comes back to the search field', async () => {
    await openPalette();
    const label = document.querySelector('.command-palette__group-label')!;
    act(() => {
      fireEvent.mouseDown(label);
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await settle();
    expect(screen.getByPlaceholderText('Search commands and nodes…')).toHaveFocus();
  });

  it('with focus on the page, Backspace and Delete leave the canvas behind it alone', async () => {
    await openPalette();
    act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
    for (const key of ['Backspace', 'Delete']) {
      act(() => { fireEvent.keyDown(document.body, { key, code: key }); });
      await settle();
    }
    expect(ids()).toEqual(['a', 'b']);
    expect(useGraphStore.getState().undoNotice).toBeNull();
  });

  it('Tab stays inside', async () => {
    await openPalette();
    const input = screen.getByPlaceholderText('Search commands and nodes…');
    const items = [...document.querySelectorAll<HTMLElement>('.command-palette button:not([disabled])')];
    act(() => { items.at(-1)!.focus(); });
    act(() => { fireEvent.keyDown(items.at(-1)!, { key: 'Tab' }); });
    expect(input).toHaveFocus();
    act(() => { fireEvent.keyDown(input, { key: 'Tab', shiftKey: true }); });
    expect(items.at(-1)).toHaveFocus();
  });

  it('Cmd+K still closes it', async () => {
    await openPalette();
    act(() => { fireEvent.keyDown(screen.getByPlaceholderText('Search commands and nodes…'), { key: 'k', metaKey: true }); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Search commands and nodes' })).toBeNull());
  });
});
