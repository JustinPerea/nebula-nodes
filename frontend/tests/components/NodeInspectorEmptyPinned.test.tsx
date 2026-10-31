import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NodeInspectorPopover } from '../../src/components/panels/NodeInspectorPopover';
import { useUIStore } from '../../src/store/uiStore';
import { useGraphStore } from '../../src/store/graphStore';

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
