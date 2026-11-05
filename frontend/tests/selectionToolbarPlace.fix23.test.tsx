/**
 * PR #199 fix round 23, GM r35: the selection toolbar never covers the
 * selection. The placement rule, in order (lib/bottomBar placeSelectionToolbar):
 * 1. its own place below the top stack, when the selection is below it
 *    (with the gap) or beside or above it;
 * 2. else flipped below the selection, when it fits above the bottom bar,
 *    and below the offline banner too;
 * 3. else pinned in its own place: the only case that covers the selection.
 * The camera never moves. Each case with the stacks GM's shots had (the
 * World Labs notice alone, the notice and its reopen line, and the offline
 * banner as well) and three selections (a node near the top, one
 * mid-canvas, a tall selection that fills the view).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { NodeData } from '../src/types';
import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { useGraphStore } from '../src/store/graphStore';
import {
  SELECTION_TOOLBAR_OFFSET_VAR, SELECTION_TOOLBAR_PLACE_ATTR, TOP_STACK_ATTR, applySelectionToolbarPlace,
  placeSelectionToolbar, topStackBottom, type ScreenBox,
} from '../src/lib/bottomBar';

const H = 50;
const GAP = 8;
const BOTTOM = 820; // the bottom bar's top less its gap, in a 900 px window
const TOOLBAR = { left: 420, right: 1020 };

// The stacks, as measured at 1440 × 900 (the toolbar's own place is the
// stack's foot plus 8, never above its 92 px line; the banner sits under it).
const STACKS = {
  'the notice alone': { home: 92, stackBottom: 76 },
  'the notice and its reopen line': { home: 128, stackBottom: 120 },
  'the notice, its line and the offline banner': { home: 128, stackBottom: 220 },
} as const;
const box = (top: number, bottom: number, left = 600, right = 840): ScreenBox => ({ top, bottom, left, right });
const SELECTIONS = {
  'a node near the top': box(100, 300),
  'a node mid-canvas': box(420, 620),
  'a tall selection that fills the view': box(60, 880),
} as const;

const place = (stack: { home: number; stackBottom: number }, selection: ScreenBox | null) => placeSelectionToolbar({
  home: stack.home, height: H, ...TOOLBAR, selection, stackBottom: stack.stackBottom, bottomLimit: BOTTOM, gap: GAP,
});
const covers = (top: number, selection: ScreenBox) => TOOLBAR.left < selection.right && TOOLBAR.right > selection.left
  && top < selection.bottom && top + H > selection.top;

describe('GM r35: the toolbar never covers the selection', () => {
  for (const [stackName, stack] of Object.entries(STACKS)) {
    describe(stackName, () => {
      it('a node mid-canvas: case 1, between the stack and the selection', () => {
        const at = place(stack, SELECTIONS['a node mid-canvas']);
        expect(at).toEqual({ top: stack.home, place: 'between' });
        expect(covers(at.top, SELECTIONS['a node mid-canvas'])).toBe(false);
      });

      it('a node near the top: case 2, flipped below it (and below the banner)', () => {
        const selection = SELECTIONS['a node near the top'];
        const at = place(stack, selection);
        expect(at.place).toBe('below');
        expect(at.top).toBe(Math.max(selection.bottom + GAP, stack.stackBottom + GAP));
        expect(covers(at.top, selection)).toBe(false);
        expect(at.top).toBeGreaterThanOrEqual(stack.stackBottom + GAP);
      });

      it('a tall selection that fills the view: case 3, pinned in its own place', () => {
        const at = place(stack, SELECTIONS['a tall selection that fills the view']);
        expect(at).toEqual({ top: stack.home, place: 'pinned' });
      });
    });
  }

  it('case 1 holds exactly to the gap: a selection the gap below the toolbar stays; a pixel closer flips', () => {
    const stack = STACKS['the notice alone'];
    expect(place(stack, box(stack.home + H + GAP, 600)).place).toBe('between');
    expect(place(stack, box(stack.home + H + GAP - 1, 600)).place).toBe('below');
  });

  it('case 2 holds exactly to the bottom bar; past it, pinned', () => {
    const stack = STACKS['the notice alone'];
    expect(place(stack, box(100, BOTTOM - H - GAP)).place).toBe('below');
    expect(place(stack, box(100, BOTTOM - H - GAP + 1)).place).toBe('pinned');
  });

  it('a small node near the top under the banner: flipped below the banner, not into it', () => {
    const stack = STACKS['the notice, its line and the offline banner'];
    const at = place(stack, box(130, 170));
    expect(at).toEqual({ top: stack.stackBottom + GAP, place: 'below' });
  });

  it('a selection beside the toolbar, or above its place, stays clear without moving it', () => {
    const stack = STACKS['the notice alone'];
    expect(place(stack, box(100, 300, 40, 300))).toEqual({ top: stack.home, place: 'clear' });
    expect(place(stack, box(20, 60))).toEqual({ top: stack.home, place: 'clear' });
    expect(place(stack, null)).toEqual({ top: stack.home, place: 'clear' });
  });
});

// The DOM side: the Panel (the floating panels' marker) keeps its place;
// only the toolbar moves, by the offset written on the Panel.
function rect(el: Element, r: { top: number; bottom: number; left: number; right: number }) {
  el.getBoundingClientRect = () => ({ ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r }) as DOMRect;
}
afterEach(() => { document.body.innerHTML = ''; });

describe('applySelectionToolbarPlace', () => {
  function stage(nodeTop: number, nodeBottom: number, banner = false) {
    document.body.innerHTML = `
      <div class="provider-recovery-status" ${TOP_STACK_ATTR}=""></div>
      ${banner ? `<div class="backend-connection" ${TOP_STACK_ATTR}=""></div>` : ''}
      <div class="react-flow"><div class="panel"><div class="selection-toolbar"></div></div>
        <div class="react-flow__node selected"></div><div class="react-flow__node"></div></div>`;
    rect(document.querySelector('.provider-recovery-status')!, { top: 34, bottom: 120, left: 400, right: 1040 });
    if (banner) rect(document.querySelector('.backend-connection')!, { top: 186, bottom: 220, left: 500, right: 940 });
    const panel = document.querySelector<HTMLElement>('.panel')!;
    rect(panel, { top: 128, bottom: 178, left: 420, right: 1020 });
    const toolbar = document.querySelector<HTMLElement>('.selection-toolbar')!;
    rect(toolbar, { top: 128, bottom: 178, left: 420, right: 1020 });
    Object.defineProperty(toolbar, 'offsetHeight', { value: 50 });
    rect(document.querySelector('.react-flow__node.selected')!, { top: nodeTop, bottom: nodeBottom, left: 600, right: 840 });
    rect(document.querySelector('.react-flow__node:not(.selected)')!, { top: 0, bottom: 900, left: 0, right: 1440 });
    return { panel, toolbar };
  }

  it('flips the toolbar below a node near the top: the Panel stays, the offset and the case are on it', () => {
    const { panel, toolbar } = stage(140, 300);
    expect(applySelectionToolbarPlace(toolbar)).toBe('below');
    expect(panel.style.getPropertyValue(SELECTION_TOOLBAR_OFFSET_VAR)).toBe(`${300 + 8 - 128}px`);
    expect(panel.getAttribute(SELECTION_TOOLBAR_PLACE_ATTR)).toBe('below');
  });

  it('keeps it in its place over a node mid-canvas (offset 0); only selected nodes count', () => {
    const { panel, toolbar } = stage(420, 620);
    expect(applySelectionToolbarPlace(toolbar)).toBe('between');
    expect(panel.style.getPropertyValue(SELECTION_TOOLBAR_OFFSET_VAR)).toBe('0px');
  });

  it('reads the offline banner as part of the stack', () => {
    stage(130, 170, true);
    expect(topStackBottom()).toBe(220);
    const { panel, toolbar } = stage(130, 170, true);
    applySelectionToolbarPlace(toolbar);
    expect(panel.style.getPropertyValue(SELECTION_TOOLBAR_OFFSET_VAR)).toBe(`${220 + 8 - 128}px`);
  });
});

describe('the parts', () => {
  const src = (file: string) => readFileSync(join(process.cwd(), 'src', file), 'utf8');

  it('the toolbar moves by the offset; its Panel (the marker) keeps its own line', () => {
    const css = src('styles/canvas.css');
    const rule = /\n\.selection-toolbar \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/position:\s*relative;/);
    expect(rule).toMatch(/top:\s*var\(--selection-toolbar-offset,\s*0px\);/);
    expect(css).toMatch(/\.selection-toolbar-panel\.react-flow__panel \{[^}]*margin-top: max\(92px, var\(--top-notice-clearance, 0px\)\);/);
  });

  it('the toolbar places itself as it appears (before it paints), and the notice box and the canvas banner are in the stack', () => {
    const node = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
      data: { label: 'Text Input', definitionId: 'text-input', params: { value: 'x' }, outputs: {}, state: 'idle' } } as Node<NodeData>;
    useGraphStore.setState({ nodes: [node], edges: [] });
    const view = render(<div className="selection-toolbar-panel" data-testid="panel"><SelectionToolbar /></div>);
    const panel = view.getByTestId('panel');
    expect(panel.getAttribute(SELECTION_TOOLBAR_PLACE_ATTR)).toBe('clear');
    expect(panel.style.getPropertyValue(SELECTION_TOOLBAR_OFFSET_VAR)).toBe('0px');
    view.unmount();
    useGraphStore.setState({ nodes: [] });
    expect(src('components/ProviderRecoveryStatus.tsx').match(/data-top-stack=""/g)).toHaveLength(2);
    expect(src('components/BackendConnectionStatus.tsx')).toMatch(/data-top-stack=\{placement === 'workspace' \? '' : undefined\}/);
  });

  it('the camera is never moved by the placement', () => {
    const code = src('components/SelectionToolbar.tsx') + src('lib/bottomBar.ts');
    expect(code).not.toMatch(/setViewport|setCenter|fitView|fitBounds|panBy|zoomTo/);
  });
});
