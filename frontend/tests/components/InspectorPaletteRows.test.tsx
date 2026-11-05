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
 * of its own and the Add / Extract row comes right after the last swatch.
 * The floating Inspector grows to fit any body, the palette's too (GM r68).
 */

vi.mock('../../src/lib/backend', async (original) => ({
  ...await original<typeof import('../../src/lib/backend')>(), apiFetch: vi.fn(async () => new Response('{}')),
}));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

import { Inspector } from '../../src/components/panels/Inspector';
import { CONTENT_RESIZE_MS, NodeInspectorPopover, OPEN_STABLE_FRAMES } from '../../src/components/panels/NodeInspectorPopover';
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
      // GM r23: "Add" and "Extract" (the full name on the input).
      expect(actions.textContent).toBe('AddExtract');
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
    // Rules whose subject is the stack, the list, a row or the actions row
    // (a button inside the row may clip its own label, round 8f).
    const rules = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(([, selector]) => selector.split(',')
      .some((one) => /\.inspector__palette(?:-list|-row|-actions)?(?![\w-])[^\s>+~]*\s*$/.test(one.trim())));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, , body] of rules) expect(body).not.toMatch(/(^|[;\s])(overflow(-y)?|max-height|height)\s*:/);
  });
});

// The floating Inspector's height (it took the whole palette before its body
// scrolled, GM r12) is now the same content-fit rule for every body (GM r68:
// "Drop ... the palette exception"): NodeInspectorContentFit.test.tsx. Here,
// with the real Inspector (review 1 LOW-4 on #226): its palette sits in the
// box the popover measures, and swatches added on the real control change
// the height the popover gives it.
describe('the floating Inspector with the real Inspector and a palette (review 1 LOW-4)', () => {
  // jsdom has no layout: the panel's header and foot are CHROME; the content
  // box is as tall as the real rows rendered in it (ROW each, past a BASE).
  const CHROME = 115;
  const BASE = 180;
  const ROW = 34;
  let callbacks: Map<number, FrameRequestCallback>;
  let nextRaf = 0;
  const placed: HTMLElement[] = [];

  function frames(n: number) {
    for (let i = 0; i < n; i++) {
      act(() => {
        const pending = [...callbacks.values()];
        callbacks.clear();
        pending.forEach((cb) => cb(performance.now()));
      });
    }
  }
  const popover = () => document.querySelector<HTMLDivElement>('.node-inspector-popover')!;
  const bounds = () => ({ top: parseFloat(popover().style.top), height: parseFloat(popover().style.height) });
  const rowsIn = (box: Element) => box.querySelectorAll('.inspector__palette-row').length;

  beforeEach(() => {
    callbacks = new Map();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      callbacks.set(++nextRaf, cb);
      return nextRaf;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id));
    vi.stubGlobal('innerWidth', 1440);
    vi.stubGlobal('innerHeight', 1400);
    fireEvent(window, new Event('resize'));
    const onScreen = (el: HTMLElement | null) => {
      const h = parseFloat(el?.style.height ?? '');
      return Number.isFinite(h) ? h : 0;
    };
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('node-inspector-popover')) return onScreen(this);
      if (this.classList.contains('node-inspector-popover__content')) return BASE + ROW * rowsIn(this);
      return 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('node-inspector-popover__body')) return 0;
      return Math.max(0, onScreen(this.closest<HTMLElement>('.node-inspector-popover')) - CHROME);
    });
    const anchor = document.createElement('div');
    anchor.dataset.nodeInspectorAnchor = 'n1';
    anchor.getBoundingClientRect = () => new DOMRect(500, 200, 300, 200);
    document.body.append(anchor);
    placed.push(anchor);
    useGraphStore.setState({ nodes: [colorNode(hexes(8))], edges: [], undoNotice: null });
    useUIStore.getState().setInspectorPinned(false);
    useUIStore.getState().selectNode('n1');
    useUIStore.getState().setInspectorVisible(true);
  });
  afterEach(() => {
    placed.splice(0).forEach((el) => el.remove());
    vi.useRealTimers();
  });

  it('puts the real palette in the box it measures, and takes its whole body', () => {
    render(<NodeInspectorPopover />);
    frames(1);
    const content = popover().querySelector('.node-inspector-popover__body > .node-inspector-popover__content')!;
    expect(content).not.toBeNull();
    expect(content.querySelector('.inspector__palette-list')).not.toBeNull();
    expect(rowsIn(content)).toBe(8);
    expect(bounds().height).toBe(BASE + ROW * 8 + CHROME);
  });

  it('grows on the spring, its top held, when swatches are added on the real control', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<NodeInspectorPopover />);
    frames(1 + OPEN_STABLE_FRAMES);
    const before = bounds();
    expect(popover().hasAttribute('data-content-resizing')).toBe(false);
    // Add, on the real Inspector's palette row.
    const add = [...popover().querySelectorAll<HTMLButtonElement>('.inspector__palette-actions button')]
      .find((button) => button.textContent === 'Add')!;
    expect(add).toBeDefined();
    act(() => { add.click(); });
    frames(1);
    const count = (useGraphStore.getState().nodes[0].data.params.palette as string[]).length;
    expect(count).toBe(9);
    expect(rowsIn(popover())).toBe(9);
    expect(bounds()).toEqual({ top: before.top, height: before.height + ROW });
    expect(popover().hasAttribute('data-content-resizing')).toBe(true);
    act(() => { vi.advanceTimersByTime(CONTENT_RESIZE_MS); });
    expect(popover().hasAttribute('data-content-resizing')).toBe(false);
  });
});

describe("the palette's read-only × and Extract (GM r22, folded)", () => {
  const css = (name: string) => readFileSync(resolve(__dirname, `../../src/styles/${name}`), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

  it('gives the read-only × the default cursor and no fade', () => {
    const disabled = rules(css('disabled-buttons.css'));
    const cursor = disabled.find((r) => r.selector.includes(":is(.inspector__palette-remove)[aria-disabled='true']") && /cursor:\s*default/.test(r.body));
    expect(cursor).toBeDefined();
    const fade = disabled.find((r) => r.selector.includes(":is(.inspector__palette-remove):is(:disabled, [aria-disabled='true'])") && /transition:\s*none\s*!important/.test(r.body));
    expect(fade).toBeDefined();
    // Its hovers skip the read-only one.
    for (const name of ['panels.css', 'slava-restraint.css']) {
      const hovers = rules(css(name)).filter((r) => /\.inspector__palette-remove:hover/.test(r.selector));
      expect(hovers.length).toBeGreaterThan(0);
      for (const hover of hovers) expect(hover.selector).toContain("[aria-disabled='true']");
    }
  });

  it('shows no ring on the pending line, which gets focus by code (GM r23)', () => {
    const panels = rules(css('panels.css'));
    for (const skin of ['body:not(.app-slava-restraint)', 'body.app-slava-restraint']) {
      const rule = panels.find((r) => r.selector.split(',').map((s) => s.trim()).includes(`${skin} .inspector__palette-pending:focus`));
      expect(rule?.body, skin).toMatch(/outline:\s*none/);
    }
  });

  it('keeps Extract on one line and its input in the Tab order', () => {
    const panels = rules(css('panels.css'));
    const row = panels.find((r) => r.selector.includes('.inspector__palette-actions .inspector__file-button') && /white-space:\s*nowrap/.test(r.body));
    expect(row).toBeDefined();
    const input = panels.find((r) => r.selector === ".inspector__file-input[data-palette-part='extract']");
    expect(input?.body).toMatch(/display:\s*block/);
    expect(input?.body).not.toMatch(/visibility:\s*hidden/);
    const ring = panels.find((r) => r.selector.includes(':has(.inspector__file-input:focus-visible)'));
    expect(ring?.body).toMatch(/outline:/);
  });
});
