import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { NodeInspectorPopover } from '../../src/components/panels/NodeInspectorPopover';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';
import { isCanvasSelectionDragging, noteCanvasSelectionDrag, onCanvasSelectionDragEnd } from '../../src/lib/canvasSelectionDrag';

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn().mockResolvedValue({}),
}));

// Review 8 of PR #205, lines-inspector (probes zzR8li P1-P7): GM r16 item 5
// says the unpinned Inspector closes only at zero. When the node it shows
// leaves the canvas and others stay selected, it shows the selection (MEDIUM-1);
// focus in a card that leaves goes to the canvas whichever node the Inspector
// shows (LOW-1); and a drag-select ends however the drag ends (NIT-2).

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
  useGraphStore.setState({ nodes: [], edges: [], undoStack: [], redoStack: [] });
});

afterEach(() => {
  cleanup();
  noteCanvasSelectionDrag(false);
  useUIStore.setState(previousUi, true);
  useGraphStore.setState(previousGraph, true);
  vi.unstubAllGlobals();
});

const textNode = (id: string, selected = false) => ({
  id, type: 'model-node', position: { x: 0, y: 0 }, selected,
  data: { label: `Text ${id}`, definitionId: 'text-input', params: { value: id }, state: 'idle' },
});
const removeFromCanvas = (id: string) => act(() => {
  useGraphStore.setState({ nodes: useGraphStore.getState().nodes.filter((node) => node.id !== id) });
});

describe('the shown node leaves while others stay selected (MEDIUM-1)', () => {
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
      title: popover ? (document.querySelector('.inspector__empty-title')?.textContent ?? ui.selectedNodeId) : null };
  };
  function openOn(id: string, pinned = false) {
    act(() => {
      useGraphStore.setState({ nodes: [textNode('a'), textNode('b'), textNode('c'), textNode('d')] as never, edges: [] });
    });
    render(<><Anchors /><NodeInspectorPopover /></>);
    click(id);
    act(() => {
      useUIStore.getState().setInspectorVisible(true);
      if (pinned) useUIStore.getState().setInspectorPinned(true);
    });
    expect(view()).toEqual({ pinned, visible: true, open: true, title: id });
  }

  it('P1: the shown node leaves while two others stay selected: open, "2 nodes selected"', () => {
    openOn('a');
    shiftClick('b'); shiftClick('c');
    expect([view().title, useUIStore.getState().selectedNodeId]).toEqual(['3 nodes selected', 'c']);
    removeFromCanvas('c');
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: '2 nodes selected' });
  });

  it('P3: the shown node leaves while one other stays selected: it shows that one', () => {
    openOn('a');
    shiftClick('b');
    removeFromCanvas('b');
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: 'a' });
  });

  it('control (P2): one of two selected leaves, the shown one stays: it shows the shown one', () => {
    openOn('a');
    shiftClick('b');
    click('a');
    shiftClick('b');
    act(() => { useUIStore.getState().selectNode('a'); });
    expect(view().title).toBe('2 nodes selected');
    removeFromCanvas('b');
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: 'a' });
  });

  it('the shown node leaves with nothing left selected: unpinned, it closes', () => {
    openOn('a');
    removeFromCanvas('a');
    expect(view()).toEqual({ pinned: false, visible: false, open: false, title: null });
  });

  it('pinned: the shown node leaves while two others stay selected: pinned, "2 nodes selected", naming none', () => {
    openOn('a', true);
    shiftClick('b'); shiftClick('c');
    removeFromCanvas('c');
    expect([view(), useUIStore.getState().selectedNodeId])
      .toEqual([{ pinned: true, visible: true, open: true, title: '2 nodes selected' }, null]);
  });

  it('pinned: the shown node leaves while one other stays selected: it shows that one', () => {
    openOn('a', true);
    shiftClick('b');
    removeFromCanvas('b');
    expect(view()).toEqual({ pinned: true, visible: true, open: true, title: 'a' });
  });

  it('the person\'s Delete of the shown node while others stay selected: open on the selection', () => {
    openOn('a');
    shiftClick('b'); shiftClick('c');
    act(() => { useGraphStore.getState().onNodesChange([{ id: 'c', type: 'remove' }]); });
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: '2 nodes selected' });
  });

  // A Redo puts back the canvas as the step left it, its selection too: here
  // the step took d alone off while a and b stayed selected.
  const deleteDWithOthersSelected = (others: string[]) => {
    openOn('a');
    for (const id of others.slice(1)) shiftClick(id);
    shiftClick('d');
    act(() => { useGraphStore.getState().onNodesChange([{ id: 'd', type: 'remove' }]); });
    act(() => { useGraphStore.getState().undo(); });
    expect([useGraphStore.getState().nodes.filter((node) => node.selected).map((node) => node.id), view().title]).toEqual([['d'], 'd']);
    for (const id of others) shiftClick(id);
    shiftClick('d');
    expect(useUIStore.getState().selectedNodeId).toBe('d');
  };

  it('Redo of a Delete takes the shown node off while two others stay selected: open, "2 nodes selected"; Undo brings it back alone', () => {
    deleteDWithOthersSelected(['a', 'b']);
    act(() => { useGraphStore.getState().redo(); });
    expect(useGraphStore.getState().nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(['a', 'b']);
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: '2 nodes selected' });
    act(() => { useGraphStore.getState().undo(); });
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: 'd' });
  });

  it('Redo of a Delete takes the shown node off while one other stays selected: it shows that one', () => {
    deleteDWithOthersSelected(['a']);
    act(() => { useGraphStore.getState().redo(); });
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: 'a' });
  });

  it('Undo of the person\'s Duplicate takes the shown copy off while others stay selected: open on the selection', () => {
    openOn('a');
    act(() => { useGraphStore.getState().duplicateSelected(); });
    const copy = useGraphStore.getState().nodes.find((node) => !['a', 'b', 'c', 'd'].includes(node.id))!.id;
    expect([useGraphStore.getState().nodes.filter((node) => node.selected).map((node) => node.id), useUIStore.getState().selectedNodeId])
      .toEqual([[copy], copy]);
    shiftClick('b'); shiftClick('c'); shiftClick(copy);
    expect([view().title, useUIStore.getState().selectedNodeId]).toEqual(['3 nodes selected', copy]);
    act(() => { useGraphStore.getState().undo(); });
    expect(useGraphStore.getState().nodes.some((node) => node.id === copy)).toBe(false);
    expect(view()).toEqual({ pinned: false, visible: true, open: true, title: '2 nodes selected' });
  });

  it('control: a Redo of a Delete made with nothing else selected closes the unpinned Inspector (none left)', () => {
    openOn('d');
    act(() => { useGraphStore.getState().onNodesChange([{ id: 'd', type: 'remove' }]); });
    act(() => { useGraphStore.getState().undo(); });
    act(() => { useUIStore.getState().setInspectorVisible(true); });
    shiftClick('a'); shiftClick('d');
    act(() => { useGraphStore.getState().redo(); });
    expect(view()).toEqual({ pinned: false, visible: false, open: false, title: null });
  });
});

describe('focus in a card that leaves goes to the canvas (LOW-1)', () => {
  // React Flow drops a removed card a frame after the store change: so do these.
  function LaggingCards() {
    const nodes = useGraphStore((state) => state.nodes);
    const [shown, setShown] = useState(nodes);
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
  const where = () => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return 'body';
    if (active.classList.contains('canvas-wrapper')) return 'canvas';
    return active.getAttribute('data-card') ? `card ${active.getAttribute('data-card')}` : active.tagName.toLowerCase();
  };
  function setUp(ids: string[], shown: string, pinned: boolean) {
    act(() => {
      useGraphStore.setState({ nodes: ids.map((id) => textNode(id, true)) as never, edges: [] });
      useUIStore.getState().selectNode(shown);
      useUIStore.getState().setInspectorVisible(true);
      if (pinned) useUIStore.getState().setInspectorPinned(true);
    });
    render(<><LaggingCards /><input aria-label="elsewhere" /><NodeInspectorPopover /></>);
    advanceLayout();
  }
  const focusCard = (id: string) => act(() => { (document.querySelector(`[data-card="${id}"]`) as HTMLElement).focus(); });

  for (const pinned of [true, false]) {
    const how = pinned ? 'pinned' : 'unpinned';
    it(`P6 ${how}: an agent deletes the focused shown card while another stays selected: focus on the canvas`, () => {
      setUp(['a', 'b'], 'b', pinned);
      focusCard('b');
      expect(where()).toBe('card b');
      removeFromCanvas('b');
      // The card is still there for a frame: focus stays in it until it goes.
      expect(where()).toBe('card b');
      advanceLayout(); advanceLayout(); advanceLayout();
      expect([document.querySelector('[data-card="b"]'), useUIStore.getState().selectedNodeId, where()]).toEqual([null, 'a', 'canvas']);
    });

    it(`P7 ${how}: an agent deletes a focused card the Inspector doesn't show: focus on the canvas`, () => {
      setUp(['a', 'b', 'c'], 'b', pinned);
      focusCard('a');
      removeFromCanvas('a');
      advanceLayout(); advanceLayout(); advanceLayout();
      expect([document.querySelector('[data-card="a"]'), useUIStore.getState().selectedNodeId, where()]).toEqual([null, 'b', 'canvas']);
    });
  }

  it('control: another card leaving leaves focus in the card that holds it', () => {
    setUp(['a', 'b', 'c'], 'b', false);
    focusCard('c');
    removeFromCanvas('a');
    advanceLayout(); advanceLayout(); advanceLayout();
    expect(where()).toBe('card c');
  });

  it('control: focus outside the canvas stays there when a card leaves', () => {
    setUp(['a', 'b'], 'b', false);
    act(() => { (document.querySelector('[aria-label="elsewhere"]') as HTMLElement).focus(); });
    removeFromCanvas('b');
    advanceLayout(); advanceLayout(); advanceLayout();
    expect(where()).toBe('input');
  });

  it('control: focus moved on to another card before the leaving one goes stays there', () => {
    setUp(['a', 'b', 'c'], 'b', false);
    focusCard('b');
    removeFromCanvas('b');
    focusCard('c');
    advanceLayout(); advanceLayout(); advanceLayout();
    expect(where()).toBe('card c');
  });
});

describe('a drag-select ends however the drag ends (NIT-2)', () => {
  const unpinnedOpenWithNone = () => {
    act(() => {
      useGraphStore.setState({ nodes: [textNode('a', true), textNode('b')] as never, edges: [] });
      useUIStore.getState().selectNode('a');
      useUIStore.getState().setInspectorVisible(true);
    });
    // React Flow clears the selection, then starts the drag.
    act(() => {
      useGraphStore.getState().onNodesChange([{ type: 'select', id: 'a', selected: false }]);
      noteCanvasSelectionDrag(true);
    });
  };
  const inspector = () => [useUIStore.getState().selectedNodeId, useUIStore.getState().panels.inspector.visible];

  for (const [end, fire] of [
    ['a pointercancel', () => window.dispatchEvent(new Event('pointercancel'))],
    ['the window losing focus', () => window.dispatchEvent(new Event('blur'))],
    ['a pointerup the pane never saw', () => window.dispatchEvent(new MouseEvent('pointerup', { button: 0 }))],
  ] as const) {
    it(`${end} ends it, and with nothing selected the unpinned Inspector closes`, async () => {
      unpinnedOpenWithNone();
      await act(async () => {});
      expect([isCanvasSelectionDragging(), ...inspector()]).toEqual([true, 'a', true]);
      act(() => { fire(); });
      await act(async () => {});
      expect([isCanvasSelectionDragging(), ...inspector()]).toEqual([false, null, false]);
    });
  }

  it('a pointerup of another button leaves the drag on, as React Flow does', async () => {
    unpinnedOpenWithNone();
    await act(async () => {});
    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { button: 2 })); });
    await act(async () => {});
    expect([isCanvasSelectionDragging(), ...inspector()]).toEqual([true, 'a', true]);
  });

  it('Escape mid-drag leaves the box going (React Flow keeps selecting); its pointerup ends it', async () => {
    unpinnedOpenWithNone();
    await act(async () => {});
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    await act(async () => {});
    act(() => { useGraphStore.getState().onNodesChange([{ type: 'select', id: 'b', selected: true }]); });
    await act(async () => {});
    expect([isCanvasSelectionDragging(), ...inspector()]).toEqual([true, 'b', true]);
    act(() => { window.dispatchEvent(new MouseEvent('pointerup', { button: 0 })); });
    expect([isCanvasSelectionDragging(), ...inspector()]).toEqual([false, 'b', true]);
  });

  it('a drag ends once: React Flow\'s own end after the window\'s, or a second window event, ends nothing more', () => {
    const ended = vi.fn();
    const stop = onCanvasSelectionDragEnd(ended);
    try {
      act(() => { noteCanvasSelectionDrag(true); });
      act(() => { window.dispatchEvent(new Event('pointercancel')); });
      act(() => { noteCanvasSelectionDrag(false); });
      act(() => { window.dispatchEvent(new Event('blur')); });
      expect(ended).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });
});
