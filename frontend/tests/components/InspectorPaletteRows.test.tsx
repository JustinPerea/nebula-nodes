import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';

/**
 * GM r12 on #208 (round 8, 7b): "the inspector shows exactly 3 palette rows;
 * the 4th swatch onwards and the Add / Extract from reference row are hidden
 * with no sign of more." The palette list shows every swatch with no scroll
 * of its own, the Add / Extract row comes right after the last swatch, and
 * the floating Inspector takes the whole body's height up to the room there
 * is; only then does its body scroll, as one.
 */

vi.mock('../../src/lib/backend', async (original) => ({
  ...await original<typeof import('../../src/lib/backend')>(), apiFetch: vi.fn(async () => new Response('{}')),
}));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

import { Inspector } from '../../src/components/panels/Inspector';
import { NodeInspectorPopover } from '../../src/components/panels/NodeInspectorPopover';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();

function colorNode(palette: string[]): Node<NodeData> {
  return { id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { label: 'Cinema Color', definitionId: 'cinema-color', params: { palette }, state: 'idle', outputs: {} } };
}

const hexes = (n: number) => Array.from({ length: n }, (_, i) => `#${(i * 20).toString(16).padStart(2, '0')}4080`);

afterEach(() => {
  cleanup();
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the palette list shows every swatch, then the Add row (GM r12, 7b)', () => {
  it('renders N rows and the Add / Extract row right after the last, for N from 1 to 12', () => {
    for (let n = 1; n <= 12; n++) {
      useGraphStore.setState({ nodes: [colorNode(hexes(n))], edges: [], undoNotice: null });
      useUIStore.getState().selectNode('n1');
      const { container, unmount } = render(<Inspector embedded />);
      const list = container.querySelector('.inspector__palette-list')!;
      const rows = [...list.querySelectorAll('.inspector__palette-row')];
      expect(rows).toHaveLength(n);
      expect(rows.map((r) => (r.querySelector('.inspector__palette-hex') as HTMLInputElement).value)).toEqual(hexes(n));
      // The Add / Extract row is the list's next sibling: right after the last swatch.
      const actions = list.nextElementSibling!;
      expect(actions.className).toBe('inspector__palette-actions');
      expect(actions.textContent).toContain('Add');
      expect(actions.textContent).toContain('Extract from reference');
      // No container between a row and the Inspector's body clips it.
      for (let el: Element | null = rows[n - 1]; el && !el.classList.contains('inspector__body'); el = el.parentElement) {
        const style = (el as HTMLElement).style;
        expect([style.overflow, style.overflowY, style.maxHeight, style.height]).toEqual(['', '', '', '']);
      }
      unmount();
    }
  });

  it('gives the palette list and its wrapper no height and no scroll of their own', () => {
    const css = readFileSync(resolve(__dirname, '../../src/styles/panels.css'), 'utf8')
      + readFileSync(resolve(__dirname, '../../src/styles/slava-restraint.css'), 'utf8');
    const rules = [...css.matchAll(/([^{}]*\.inspector__palette(?:-list|-row|-actions)?(?![\w-])[^{}]*)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) expect(body).not.toMatch(/(^|[;\s])(overflow(-y)?|max-height|height)\s*:/);
  });
});

describe('the floating Inspector takes the whole palette before its body scrolls (GM r12, 7b)', () => {
  // jsdom has no layout: the body's viewport is the panel less its header
  // and foot (CHROME); its content is as tall as the test says.
  const CHROME = 115;
  let contentHeight = 0;
  let animated: number | null = null;
  let callbacks: Map<number, FrameRequestCallback>;
  let nextRaf = 0;
  const placed: HTMLElement[] = [];

  function place(attrs: Record<string, string>, at: () => DOMRect) {
    const element = document.createElement('div');
    for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
    element.getBoundingClientRect = at;
    document.body.append(element);
    placed.push(element);
  }
  function frames(n: number) {
    for (let i = 0; i < n; i++) {
      act(() => {
        const pending = [...callbacks.values()];
        callbacks.clear();
        pending.forEach((cb) => cb(performance.now()));
      });
    }
  }
  const bounds = () => {
    const { style } = document.querySelector<HTMLDivElement>('.node-inspector-popover')!;
    return { top: parseFloat(style.top), height: parseFloat(style.height) };
  };
  function open(height: number) {
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', height);
    fireEvent(window, new Event('resize'));
    place({ 'data-top-bar': '' }, () => new DOMRect(400, 24, 600, 40));
    const anchor = document.createElement('div');
    anchor.dataset.nodeInspectorAnchor = 'n1';
    anchor.getBoundingClientRect = () => new DOMRect(500, 200, 300, 200);
    document.body.append(anchor);
    placed.push(anchor);
    render(<NodeInspectorPopover />);
    frames(3);
  }

  beforeEach(() => {
    callbacks = new Map();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      callbacks.set(++nextRaf, cb);
      return nextRaf;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
    animated = null;
    // The panel's height on screen: its given height, or where the layout
    // spring has it (``animated``).
    const onScreen = (popover: HTMLElement | null) => {
      const h = parseFloat(popover?.style.height ?? '');
      return animated ?? (Number.isFinite(h) ? h : 0);
    };
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('node-inspector-popover') ? onScreen(this) : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('node-inspector-popover__body')) return 0;
      return Math.max(0, onScreen(this.closest<HTMLElement>('.node-inspector-popover')) - CHROME);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('node-inspector-popover__body')) return 0;
      return Math.max(contentHeight, this.clientHeight);
    });
    useGraphStore.setState({ nodes: [colorNode(hexes(8))], edges: [], undoNotice: null });
    useUIStore.getState().setInspectorPinned(false);
    useUIStore.getState().selectNode('n1');
    useUIStore.getState().setInspectorVisible(true);
  });
  afterEach(() => {
    placed.splice(0).forEach((el) => el.remove());
  });

  it('grows past 300 px to show the whole body when it holds a palette', () => {
    // Eight swatches, the Add row and the rest: 420 px of body.
    contentHeight = 420;
    open(900);
    expect(bounds().height).toBe(420 + CHROME);
    const body = document.querySelector<HTMLElement>('.node-inspector-popover__body')!;
    expect(body.scrollHeight - body.clientHeight).toBe(0);
  });

  it('stops at the room there is, and then the body scrolls as one', () => {
    contentHeight = 2000;
    open(700);
    const { top, height } = bounds();
    expect(height).toBeGreaterThan(300);
    expect(top + height).toBeLessThanOrEqual(700);
    const body = document.querySelector<HTMLElement>('.node-inspector-popover__body')!;
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
  });

  it('grows to its body on the layout spring, never past it (round 8b)', () => {
    contentHeight = 420;
    open(1400);
    expect(bounds().height).toBe(420 + CHROME);
    // A palette with more swatches lands: the spring starts from the old height.
    contentHeight = 600;
    animated = 420 + CHROME;
    frames(4);
    expect(bounds().height).toBe(600 + CHROME);
    // Mid-way, and past it (the spring's overshoot): the target holds.
    for (const at of [480, 560, 600 + CHROME + 9, 600 + CHROME]) {
      animated = at;
      frames(3);
      expect(bounds().height).toBe(600 + CHROME);
    }
  });

  it('keeps 300 px and the spare-line rule for a body with no palette', () => {
    useGraphStore.setState({ nodes: [{ ...colorNode([]), data: { ...colorNode([]).data, definitionId: 'text-input', label: 'Text Input', params: {} } }] });
    contentHeight = 420;
    open(900);
    expect(bounds().height).toBe(300);
  });
});
