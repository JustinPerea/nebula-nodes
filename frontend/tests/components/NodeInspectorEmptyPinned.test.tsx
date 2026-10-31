import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NodeInspectorPopover } from '../../src/components/panels/NodeInspectorPopover';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import { noteCanvasSelectionDrag } from '../../src/lib/canvasSelectionDrag';
import { isCanvasShortcutTarget } from '../../src/lib/canvasShortcutScope';

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn().mockResolvedValue({}),
}));

// GM PR #205 r10 items 2-3: a pinned Inspector whose node went (several came
// back, or an Undo, a Delete or a reopen took it off) stays on the screen
// with its empty state, as the store says (review 5, lines LOW-1). The real
// Inspector draws it.

let previousUi: ReturnType<typeof useUIStore.getState>;
let previousGraph: ReturnType<typeof useGraphStore.getState>;
let callbacks: Map<number, FrameRequestCallback>;
let nextRaf: number;

const advanceLayout = () => act(() => {
  const pending = [...callbacks.values()];
  callbacks.clear();
  pending.forEach((callback) => callback(performance.now()));
});

beforeEach(() => {
  previousUi = useUIStore.getState();
  previousGraph = useGraphStore.getState();
  callbacks = new Map();
  nextRaf = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextRaf, callback);
    return nextRaf;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  useGraphStore.setState({ nodes: [], edges: [] });
});

afterEach(() => {
  cleanup();
  useUIStore.setState(previousUi, true);
  useGraphStore.setState(previousGraph, true);
  vi.unstubAllGlobals();
});

describe('the pinned Inspector with no node', () => {
  it('stays on the screen, pinned, saying "No node selected"', () => {
    act(() => {
      useUIStore.getState().selectNode('gone');
      useUIStore.getState().setInspectorPinned(true);
      useUIStore.getState().setInspectorVisible(true);
      useUIStore.getState().selectNode(null, { keepPin: true });
    });
    render(<NodeInspectorPopover />);
    advanceLayout();
    const popover = document.querySelector('.node-inspector-popover');
    expect(popover).not.toBeNull();
    expect(popover?.getAttribute('data-placement')).toBe('pinned-left');
    expect(screen.getByText('No node selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unpin inspector' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('"standby" is decoration: screen readers get only "No node selected", and the change isn’t announced', () => {
    act(() => {
      useUIStore.getState().selectNode('gone');
      useUIStore.getState().setInspectorPinned(true);
      useUIStore.getState().selectNode(null, { keepPin: true });
    });
    render(<NodeInspectorPopover />);
    advanceLayout();
    expect(screen.getByText('standby')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('No node selected')).not.toHaveAttribute('aria-hidden');
    // GM PR #205 r13 item 6: read when someone moves to it, not announced.
    const empty = document.querySelector('[data-inspector-empty="true"]');
    expect(empty?.closest('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });

  it('unpinning the empty Inspector closes it, in the store as on the screen', () => {
    act(() => {
      useUIStore.getState().selectNode('gone');
      useUIStore.getState().setInspectorPinned(true);
      useUIStore.getState().selectNode(null, { keepPin: true });
    });
    render(<NodeInspectorPopover />);
    advanceLayout();
    act(() => { screen.getByRole('button', { name: 'Unpin inspector' }).click(); });
    advanceLayout();
    expect(document.querySelector('.node-inspector-popover')).toBeNull();
    expect(useUIStore.getState()).toMatchObject({ inspectorPinned: false, panels: { inspector: { visible: false } } });
  });

  it('unpinning over a shown node keeps it open, unpinned', () => {
    act(() => {
      useGraphStore.setState({ nodes: [{ id: 'a', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
        data: { label: 'Text a', definitionId: 'text-input', params: { value: 'a' }, state: 'idle' } }] as never });
      useUIStore.getState().selectNode('a');
      useUIStore.getState().setInspectorPinned(true);
      useUIStore.getState().setInspectorPinned(false);
    });
    expect(useUIStore.getState()).toMatchObject({ inspectorPinned: false, panels: { inspector: { visible: true } } });
  });

  it('a node named before it arrives (an agent\'s focus request) stays named while other nodes change', () => {
    act(() => {
      useGraphStore.setState({ nodes: [{ id: 'a', type: 'model-node', position: { x: 0, y: 0 },
        data: { label: 'A', definitionId: 'text-input', params: { value: 'a' }, state: 'idle' } }] as never });
      useUIStore.getState().selectNode('arriving');
      useGraphStore.setState({ nodes: [...useGraphStore.getState().nodes, { id: 'b', type: 'model-node', position: { x: 0, y: 0 },
        data: { label: 'B', definitionId: 'text-input', params: { value: 'b' }, state: 'idle' } }] as never });
    });
    expect(useUIStore.getState().selectedNodeId).toBe('arriving');
  });

  it('control: an Inspector that isn\'t pinned closes with its node', () => {
    act(() => {
      useUIStore.getState().selectNode('gone');
      useUIStore.getState().setInspectorVisible(true);
      useUIStore.getState().selectNode(null, { keepPin: true });
    });
    render(<NodeInspectorPopover />);
    advanceLayout();
    expect(document.querySelector('.node-inspector-popover')).toBeNull();
  });
});

// GM PR #205 r11 item 3 and r12: the Inspector follows the canvas selection,
// so it and the rings agree. None selected: "No node selected". One, however
// it was selected: that node. From 2: "N nodes selected", then "Select one
// node to see its settings.". Screen readers get the words on the screen.
describe('the pinned Inspector over a selection', () => {
  const textNode = (id: string, selected = false) => ({
    id, type: 'model-node', position: { x: 0, y: 0 }, selected,
    data: { label: `Text ${id}`, definitionId: 'text-input', params: { value: id }, state: 'idle' },
  });
  // What React Flow sends for a drag-select or a Shift-click.
  const select = (ids: string[], selected: boolean) => act(() => {
    useGraphStore.getState().onNodesChange(ids.map((id) => ({ type: 'select' as const, id, selected })));
  });
  // A click on a card: React Flow selects it alone, and the card opens it.
  const click = (id: string) => act(() => {
    const others = useGraphStore.getState().nodes.filter((node) => node.selected && node.id !== id).map((node) => node.id);
    useGraphStore.getState().onNodesChange([...others.map((other) => ({ type: 'select' as const, id: other, selected: false })),
      { type: 'select' as const, id, selected: true }]);
    useUIStore.getState().selectNode(id);
  });
  // A Shift-click: React Flow adds it, and the card's own click names it.
  const shiftClick = (id: string) => act(() => {
    useGraphStore.getState().onNodesChange([{ type: 'select' as const, id, selected: true }]);
    useUIStore.getState().selectNode(id);
  });
  const emptyState = () => document.querySelector('[data-inspector-empty="true"]');
  const shown = () => ({ ui: useUIStore.getState().selectedNodeId, empty: emptyState()?.textContent ?? null,
    rings: useGraphStore.getState().nodes.filter((node) => node.selected || node.id === useUIStore.getState().selectedNodeId).map((node) => node.id) });
  const MULTI = (n: number) => `${n} nodes selectedSelect one node to see its settings.`;

  function pinnedEmpty(nodes = [textNode('a'), textNode('b'), textNode('c')]) {
    act(() => {
      useGraphStore.setState({ nodes: nodes as never, edges: [] });
      useUIStore.getState().selectNode('gone');
      useUIStore.getState().setInspectorPinned(true);
      useUIStore.getState().setInspectorVisible(true);
      useUIStore.getState().selectNode(null, { keepPin: true });
    });
    render(<NodeInspectorPopover />);
    advanceLayout();
  }

  it('0 selected: "No node selected"', () => {
    pinnedEmpty();
    expect(shown()).toEqual({ ui: null, empty: 'No node selectedstandby', rings: [] });
    expect(emptyState()).not.toHaveAttribute('data-inspector-selected');
  });

  it('1 by a click, by a drag-select of one, by Select all on a canvas of one and by a Paste of one: that node', () => {
    pinnedEmpty();
    click('b');
    expect(shown()).toEqual({ ui: 'b', empty: null, rings: ['b'] });
    select(['b'], false);
    expect(shown()).toEqual({ ui: null, empty: 'No node selectedstandby', rings: [] });
    select(['c'], true);
    expect(shown()).toEqual({ ui: 'c', empty: null, rings: ['c'] });
    expect(screen.getByRole('button', { name: 'Unpin inspector' })).toHaveAttribute('aria-pressed', 'true');
    cleanup();
    pinnedEmpty([textNode('solo')]);
    act(() => { useGraphStore.getState().selectAll(); });
    expect(shown()).toEqual({ ui: 'solo', empty: null, rings: ['solo'] });
    cleanup();
    pinnedEmpty([textNode('a')]);
    act(() => { useGraphStore.setState({ nodes: [textNode('a'), textNode('pasted', true)] as never }); });
    expect(shown()).toEqual({ ui: 'pasted', empty: null, rings: ['pasted'] });
  });

  it('2 by a Shift-click, 3 by another, back to 2, then the clear', () => {
    pinnedEmpty();
    click('a');
    shiftClick('b');
    expect(shown()).toEqual({ ui: 'b', empty: MULTI(2), rings: ['a', 'b'] });
    expect(screen.getByText('2 nodes selected')).not.toHaveAttribute('aria-hidden');
    expect(screen.getByText('Select one node to see its settings.')).not.toHaveAttribute('aria-hidden');
    expect(screen.queryByText('No node selected')).toBeNull();
    shiftClick('c');
    expect(shown().empty).toBe(MULTI(3));
    select(['a'], false);
    expect(shown()).toMatchObject({ empty: MULTI(2), rings: ['b', 'c'] });
    select(['b', 'c'], false);
    expect(shown()).toEqual({ ui: null, empty: 'No node selectedstandby', rings: [] });
    expect(screen.getByRole('button', { name: 'Unpin inspector' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('a drag-select of several and Select all: the count, and no node of the Inspector’s own left ringed', () => {
    pinnedEmpty();
    click('a');
    select(['a'], false);
    select(['b', 'c'], true);
    expect(shown()).toEqual({ ui: null, empty: MULTI(2), rings: ['b', 'c'] });
    act(() => { useGraphStore.getState().selectAll(); });
    expect(shown().empty).toBe(MULTI(3));
    expect(emptyState()).toHaveAttribute('data-inspector-selected', '3');
  });

  it('a Paste of several: the pasted nodes, selected, are counted', () => {
    pinnedEmpty([textNode('a')]);
    click('a');
    act(() => {
      useGraphStore.setState({ nodes: [textNode('a'), textNode('p1', true), textNode('p2', true)] as never });
    });
    expect(shown()).toEqual({ ui: null, empty: MULTI(2), rings: ['p1', 'p2'] });
  });

  it('a node named from elsewhere (the command palette) while others are selected: the canvas selects it alone', async () => {
    pinnedEmpty();
    select(['a', 'b'], true);
    await act(async () => { useUIStore.getState().selectNode('c'); });
    expect(shown()).toEqual({ ui: 'c', empty: null, rings: ['c'] });
  });

  it('one node ringed on the canvas while the UI store names none: the Inspector shows that node', () => {
    pinnedEmpty();
    select(['b'], true);
    act(() => { useUIStore.getState().selectNode(null, { keepPin: true }); });
    expect(useUIStore.getState().selectedNodeId).toBeNull();
    expect(emptyState()).toBeNull();
    expect(screen.getByDisplayValue('b')).toBeInTheDocument();
  });

  // A card's own click names it before React Flow adds it (the order live).
  it('a Shift-click whose card names it before the canvas adds it: both stay selected', async () => {
    pinnedEmpty();
    click('a');
    await act(async () => {
      useUIStore.getState().selectNode('b');
      useGraphStore.getState().onNodesChange([{ type: 'select' as const, id: 'b', selected: true }]);
    });
    expect(shown()).toEqual({ ui: 'b', empty: MULTI(2), rings: ['a', 'b'] });
  });
});

// Review 6 of PR #205 (inspector-pin MEDIUM-1), GM r13 item 5: with the
// Inspector pinned, Delete, Cmd+Z, Cmd+Shift+Z and Cmd+Z again all stay the
// canvas's: when the shown node leaves, focus goes to the canvas, and the node
// an Undo brings back shows in the Inspector without taking focus.
// GM PR #205 r16 item 5: the unpinned Inspector follows the selection. One
// node: that node. 2 or more: "N nodes selected", whether or not its old node
// is among them. None: it closes, as on main (where selectNode(null) closes an
// unpinned Inspector).
describe('the unpinned Inspector over a selection', () => {
  const textNode = (id: string, selected = false) => ({
    id, type: 'model-node', position: { x: 0, y: 0 }, selected,
    data: { label: `Text ${id}`, definitionId: 'text-input', params: { value: id }, state: 'idle' },
  });
  const select = (ids: string[], selected: boolean) => act(() => {
    useGraphStore.getState().onNodesChange(ids.map((id) => ({ type: 'select' as const, id, selected })));
  });
  const click = (id: string) => act(() => {
    const others = useGraphStore.getState().nodes.filter((node) => node.selected && node.id !== id).map((node) => node.id);
    useGraphStore.getState().onNodesChange([...others.map((other) => ({ type: 'select' as const, id: other, selected: false })),
      { type: 'select' as const, id, selected: true }]);
    useUIStore.getState().selectNode(id);
  });
  const shiftClick = (id: string) => act(() => {
    useGraphStore.getState().onNodesChange([{ type: 'select' as const, id, selected: true }]);
    useUIStore.getState().selectNode(id);
  });
  function Anchors() {
    const nodes = useGraphStore((state) => state.nodes);
    return <>{nodes.map((node, index) => (
      <button key={node.id} type="button" data-node-inspector-anchor={node.id}
        ref={(el) => { if (el) el.getBoundingClientRect = () => ({ left: 100 + index * 220, top: 100, right: 300 + index * 220, bottom: 160,
          width: 200, height: 60, x: 100 + index * 220, y: 100, toJSON: () => ({}) }) as DOMRect; }}>{node.id}</button>
    ))}</>;
  }
  const view = () => {
    advanceLayout();
    const ui = useUIStore.getState();
    const popover = document.querySelector('.node-inspector-popover');
    return { pinned: ui.inspectorPinned, visible: ui.panels.inspector.visible, open: Boolean(popover),
      title: popover ? (document.querySelector('.inspector__empty-title')?.textContent
        ?? document.querySelector('.node-inspector-popover')?.getAttribute('data-node-id') ?? ui.selectedNodeId) : null };
  };
  function openUnpinnedOn(id: string) {
    act(() => {
      useGraphStore.setState({ nodes: [textNode('a'), textNode('b'), textNode('c'), textNode('d')] as never, edges: [] });
    });
    render(<><Anchors /><NodeInspectorPopover /></>);
    click(id);
    act(() => { useUIStore.getState().setInspectorVisible(true); });
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: id });
  }

  it('a click on another node: it shows that node', () => {
    openUnpinnedOn('a');
    click('b');
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: 'b' });
  });

  // As React Flow does it: the selection clears, the drag starts (one handler),
  // the box takes nodes, the drag ends.
  const drag = async (ids: string[]) => {
    act(() => {
      const on = useGraphStore.getState().nodes.filter((node) => node.selected).map((node) => node.id);
      useGraphStore.getState().onNodesChange(on.map((id) => ({ type: 'select' as const, id, selected: false })));
      noteCanvasSelectionDrag(true);
    });
    await act(async () => {});
    select(ids, true);
    act(() => { noteCanvasSelectionDrag(false); });
    await act(async () => {});
  };

  it('a drag-select of two other nodes, a Shift-click and Select all each read "N nodes selected"', async () => {
    openUnpinnedOn('a');
    await drag(['b', 'c']);
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: '2 nodes selected' });
    cleanup();
    openUnpinnedOn('a');
    shiftClick('b');
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: '2 nodes selected' });
    cleanup();
    openUnpinnedOn('a');
    act(() => { useGraphStore.getState().selectAll(); });
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: '4 nodes selected' });
  });

  it('back to one: that node; then none (a pane click): it closes', async () => {
    openUnpinnedOn('a');
    await drag(['b', 'c']);
    select(['b'], false);
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: 'c' });
    select(['c'], false);
    await act(async () => {});
    expect(view()).toEqual({ pinned: false, visible: false, open: false, title: null });
  });

  it('a drag-select that ends over nothing: it closes', async () => {
    openUnpinnedOn('a');
    await drag([]);
    expect(view()).toEqual({ pinned: false, visible: false, open: false, title: null });
  });
});

describe('the pinned Inspector and the keyboard', () => {
  function Cards() {
    const nodes = useGraphStore((state) => state.nodes);
    return (
      <div className="canvas-wrapper" tabIndex={0}>
        {nodes.map((node) => <div key={node.id} className="react-flow__node" tabIndex={0} data-card={node.id}>{node.id}</div>)}
      </div>
    );
  }
  // The canvas's own keys, routed by the same rule as Canvas.tsx.
  const onKey = (event: KeyboardEvent) => {
    if (!isCanvasShortcutTarget(event.target) || !event.metaKey || event.key.toLowerCase() !== 'z') return;
    event.preventDefault();
    if (event.shiftKey) useGraphStore.getState().redo();
    else useGraphStore.getState().undo();
  };
  const press = (key: string, extra: KeyboardEventInit = {}) => act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
  });
  const where = () => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return 'body';
    if (active.classList.contains('canvas-wrapper')) return 'canvas';
    if (active.closest('.node-inspector-popover')) return `inspector ${active.tagName.toLowerCase()}`;
    return active.getAttribute('data-card') ? `card ${active.getAttribute('data-card')}` : active.tagName.toLowerCase();
  };
  const ids = () => useGraphStore.getState().nodes.map((node) => node.id);

  it('pin, Delete, Cmd+Z, Cmd+Shift+Z, Cmd+Z: each on the canvas, focus never in the Inspector', () => {
    document.addEventListener('keydown', onKey);
    try {
      act(() => {
        useGraphStore.setState({ nodes: [{ id: 'temp', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
          data: { label: 'Temp', definitionId: 'text-input', params: { value: 'kept' }, state: 'idle' } }] as never,
        edges: [], undoStack: [], redoStack: [] });
        useUIStore.getState().selectNode('temp');
        useUIStore.getState().setInspectorPinned(true);
      });
      render(<><Cards /><NodeInspectorPopover /></>);
      advanceLayout();
      act(() => { (document.querySelector('[data-card="temp"]') as HTMLElement).focus(); });
      expect(where()).toBe('card temp');
      // Delete: the node goes; focus to the canvas, the Inspector empty and pinned.
      act(() => { useGraphStore.getState().onNodesChange([{ id: 'temp', type: 'remove' }]); });
      advanceLayout();
      expect([ids(), where(), useUIStore.getState().inspectorPinned]).toEqual([[], 'canvas', true]);
      expect(screen.getByText('No node selected')).toBeInTheDocument();
      press('z', { metaKey: true });
      advanceLayout();
      expect([ids(), where()]).toEqual([['temp'], 'canvas']);
      press('z', { metaKey: true, shiftKey: true });
      advanceLayout();
      expect([ids(), where()]).toEqual([[], 'canvas']);
      press('z', { metaKey: true });
      advanceLayout();
      expect([ids(), where()]).toEqual([['temp'], 'canvas']);
      expect(document.querySelector('.node-inspector-popover textarea, .node-inspector-popover input')).not.toHaveFocus();
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  // React Flow copies the nodes into its own store, so a card leaves a commit
  // after the selection clears (review 7 of PR #205, inspector LOW-1).
  function LaggingCards() {
    const nodes = useGraphStore((state) => state.nodes);
    const [shown, setShown] = useState(nodes);
    // React Flow drops a removed card a frame after the store change: so do these.
    useEffect(() => {
      const frame = requestAnimationFrame(() => setShown(nodes));
      return () => cancelAnimationFrame(frame);
    }, [nodes]);
    return (
      <div className="canvas-wrapper" tabIndex={0}>
        {shown.map((node) => <div key={node.id} className="react-flow__node" tabIndex={0} data-id={node.id} data-card={node.id}>{node.id}</div>)}
      </div>
    );
  }

  it('Delete with focus in the card, which leaves a render after the selection clears: focus ends on the canvas, not the page', () => {
    act(() => {
      useGraphStore.setState({ nodes: [{ id: 'temp', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
        data: { label: 'Temp', definitionId: 'text-input', params: { value: 'kept' }, state: 'idle' } }] as never,
      edges: [], undoStack: [], redoStack: [] });
      useUIStore.getState().selectNode('temp');
      useUIStore.getState().setInspectorPinned(true);
    });
    render(<><LaggingCards /><NodeInspectorPopover /></>);
    advanceLayout();
    act(() => { (document.querySelector('[data-card="temp"]') as HTMLElement).focus(); });
    expect(where()).toBe('card temp');
    act(() => { useGraphStore.getState().onNodesChange([{ id: 'temp', type: 'remove' }]); });
    advanceLayout();
    advanceLayout();
    expect([ids(), document.querySelector('[data-card="temp"]'), where()]).toEqual([[], null, 'canvas']);
  });

  it('control: focus somewhere else (a field outside the canvas) stays there when the shown node leaves', () => {
    act(() => {
      useGraphStore.setState({ nodes: [{ id: 'temp', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
        data: { label: 'Temp', definitionId: 'text-input', params: { value: 'kept' }, state: 'idle' } }] as never,
      edges: [], undoStack: [], redoStack: [] });
      useUIStore.getState().selectNode('temp');
      useUIStore.getState().setInspectorPinned(true);
    });
    render(<><LaggingCards /><input aria-label="elsewhere" /><NodeInspectorPopover /></>);
    advanceLayout();
    act(() => { screen.getByLabelText('elsewhere').focus(); });
    act(() => { useGraphStore.getState().onNodesChange([{ id: 'temp', type: 'remove' }]); });
    advanceLayout();
    advanceLayout();
    expect(where()).toBe('input');
  });

  it('with focus on the page (nothing focused), an Undo that brings the node back leaves it there: only the next-step picker hands the Inspector focus', () => {
    document.addEventListener('keydown', onKey);
    try {
      act(() => {
        useGraphStore.setState({ nodes: [{ id: 'temp', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
          data: { label: 'Temp', definitionId: 'text-input', params: { value: 'kept' }, state: 'idle' } }] as never,
        edges: [], undoStack: [], redoStack: [] });
        useUIStore.getState().selectNode('temp');
        useUIStore.getState().setInspectorPinned(true);
      });
      render(<><Cards /><NodeInspectorPopover /></>);
      advanceLayout();
      act(() => { useGraphStore.getState().onNodesChange([{ id: 'temp', type: 'remove' }]); });
      advanceLayout();
      act(() => { (document.activeElement as HTMLElement | null)?.blur(); });
      expect(where()).toBe('body');
      press('z', { metaKey: true });
      advanceLayout();
      expect([ids(), useUIStore.getState().selectedNodeId, where()]).toEqual([['temp'], 'temp', 'body']);
      press('z', { metaKey: true, shiftKey: true });
      advanceLayout();
      expect(ids()).toEqual([]);
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });
});
