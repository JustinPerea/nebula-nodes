import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NodeInspectorPopover } from '../../src/components/panels/NodeInspectorPopover';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

/**
 * GM - Design, 2026-10-23: the Inspector's "Run / Duplicate / Delete row is
 * cut off ... so its foot row is always whole". The row was the last thing in
 * the Inspector's scrolling body: with more fields than the popover's 300 px
 * it scrolled out of sight and the body's fade covered what was left. It is
 * the popover's foot now, outside the scrolling body.
 */

vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));

let callbacks: Map<number, FrameRequestCallback>;
let nextRaf: number;
let previousGraph: ReturnType<typeof useGraphStore.getState>;
let previousUi: ReturnType<typeof useUIStore.getState>;

function advanceLayout() {
  act(() => {
    const pending = [...callbacks.values()];
    callbacks.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

beforeEach(() => {
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
  callbacks = new Map();
  nextRaf = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callbacks.set(++nextRaf, callback);
    return nextRaf;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
  vi.stubGlobal('innerWidth', 1280);
  vi.stubGlobal('innerHeight', 800);
  useGraphStore.setState({
    nodes: [{ id: 'n1', position: { x: 0, y: 0 },
      data: { definitionId: 'text-input', label: 'Text Input', params: { value: 'a lighthouse at dusk' }, outputs: {}, state: 'idle' } }],
    edges: [],
  });
  useUIStore.getState().setInspectorPinned(false);
  useUIStore.getState().selectNode('n1');
  useUIStore.getState().setInspectorVisible(true);
  const anchor = document.createElement('div');
  anchor.dataset.nodeInspectorAnchor = 'n1';
  anchor.getBoundingClientRect = () => new DOMRect(575, 437, 82, 90);
  document.body.append(anchor);
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('[data-node-inspector-anchor]').forEach((element) => element.remove());
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
  vi.unstubAllGlobals();
});

describe('the Inspector\'s foot row', () => {
  it('sits in the popover\'s foot, outside the scrolling body', async () => {
    render(<NodeInspectorPopover />);
    advanceLayout();
    const popover = document.querySelector('.node-inspector-popover')!;
    const body = popover.querySelector('.node-inspector-popover__body')!;
    const foot = popover.querySelector('.node-inspector-popover__foot');
    expect(foot).not.toBeNull();
    // The foot follows the body, so the order on screen is the order for the keyboard.
    expect(foot!.parentElement).toBe(popover);
    expect(body.compareDocumentPosition(foot!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const name of ['Run', 'Duplicate', 'Delete']) {
      const button = await screen.findByRole('button', { name });
      expect(foot!.contains(button)).toBe(true);
      expect(body.contains(button)).toBe(false);
    }
    // The fields stay in the scrolling body.
    expect(body.contains(screen.getByText('State'))).toBe(true);
  });
});
