import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { resolvedStyle } from '../helpers/cssCascade';

// GM r23 on #208: the Add / Extract row fits inside the Inspector. jsdom has
// no layout, so this lays the row out from the app's own stylesheets
// (helpers/cssCascade): the floating Inspector at its minimum width, less
// every padding and border down to the row, shared by the two buttons as
// their flex rules share it; each button's parts that can't shrink (its
// padding, border, icon and gap) must fit its share, and its label must be
// allowed to shrink (min-width 0, clipped, an ellipsis). It also measures
// the visible labels against their share with a generous glyph width, which
// is why the label is "Extract" (the full name can't fit beside Add).

vi.mock('../../src/lib/backend', async (original) => ({
  ...await original<typeof import('../../src/lib/backend')>(), apiFetch: vi.fn(async () => new Response('{}')),
}));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn() } }));

import { Inspector } from '../../src/components/panels/Inspector';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

const initialUI = useUIStore.getState();
const initialGraph = useGraphStore.getState();
afterEach(() => {
  cleanup();
  document.body.className = '';
  useUIStore.setState(initialUI, true);
  useGraphStore.setState(initialGraph, true);
});

const POPOVER_SOURCE = readFileSync(resolve(__dirname, '../../src/components/panels/NodeInspectorPopover.tsx'), 'utf8');
const MIN_WIDTH = Number(/const POPOVER_MIN_WIDTH = (\d+);/.exec(POPOVER_SOURCE)![1]);
/** A generous average advance for the UI fonts (Inter, the system UI) at 1em. */
const GLYPH_EM = 0.62;

/** A length in px from a declared value, var() resolved against `style`. */
function length(style: Record<string, string>, raw: string | undefined, depth = 0): number {
  if (!raw || depth > 8) return 0;
  const value = raw.trim();
  const v = /^var\((--[\w-]+)(?:,\s*([^)]*))?\)$/.exec(value);
  if (v) return length(style, style[`|${v[1]}`] ?? v[2], depth + 1);
  const px = /^(-?[\d.]+)px$/.exec(value);
  if (px) return Number(px[1]);
  if (/^0$/.test(value)) return 0;
  return NaN;
}
/** Left and right of a box shorthand ("4px 10px"), or its longhands. */
function sides(style: Record<string, string>, prop: 'padding' | 'border-width'): number {
  const longhand = prop === 'padding' ? ['padding-left', 'padding-right'] : ['border-left-width', 'border-right-width'];
  let short = style[`|${prop}`];
  if (prop === 'border-width' && !short) {
    const border = style['|border'];
    if (border !== undefined) short = /none/.test(border) ? '0' : (border.split(/\s+/).find((t) => /px$|^var\(--sr-border/.test(t)) ?? '0');
  }
  const parts = short ? short.split(/\s+(?![^(]*\))/) : [];
  const right = parts.length ? (parts[1] ?? parts[0]) : undefined;
  const left = parts.length ? (parts[3] ?? parts[1] ?? parts[0]) : undefined;
  const l = style[`|${longhand[0]}`] ?? left;
  const r = style[`|${longhand[1]}`] ?? right;
  const sum = length(style, l) + length(style, r);
  expect(Number.isNaN(sum), `${prop}: ${l} / ${r}`).toBe(false);
  return sum;
}

function show() {
  const node: Node<NodeData> = { id: 'n1', type: 'model', position: { x: 0, y: 0 },
    data: { label: 'Cinema Color', definitionId: 'cinema-color', params: { palette: ['#aaaaaa'] }, state: 'idle', outputs: {} } };
  useGraphStore.setState({ nodes: [node], edges: [], undoNotice: null });
  useUIStore.getState().selectNode('n1');
  // The floating Inspector's frame around its embedded body.
  return render(
    <div className="node-inspector-popover"><div className="node-inspector-popover__body"><Inspector embedded /></div></div>,
  );
}

describe.each([['the default skin', ''], ['Slava', 'app-slava-restraint']])('the Add / Extract row fits the Inspector at its minimum width (GM r23), %s', (_, skin) => {
  it('keeps both buttons inside the panel content box', () => {
    document.body.className = skin;
    const { container } = show();
    const row = container.querySelector<HTMLElement>('.inspector__palette-actions')!;
    const popover = container.querySelector<HTMLElement>('.node-inspector-popover')!;
    // The content box the row has: the panel's width less each padding and border on the way down.
    let content = MIN_WIDTH;
    for (let el: HTMLElement | null = row.parentElement; el; el = el.parentElement) {
      const style = resolvedStyle(el);
      content -= sides(style, 'padding') + sides(style, 'border-width');
      if (el === popover) break;
    }
    const rowStyle = resolvedStyle(row);
    expect(rowStyle['|display']).toBe('flex');
    expect(rowStyle['|flex-wrap'] ?? 'nowrap').toBe('nowrap');
    const gap = length(rowStyle, rowStyle['|gap']);
    const buttons = [...row.children] as HTMLElement[];
    expect(buttons).toHaveLength(2);
    // Each button grows from a zero basis (content-box: its padding and
    // border sit outside the basis), so the room the two share is what the
    // row has less the gap and both buttons' padding and border; each gets
    // half, plus its own padding and border: the two always add up to the
    // row's width (Chrome at 228 px: 88 + 6 + 108 = 202).
    const extras = buttons.map((button) => {
      const style = resolvedStyle(button);
      return sides(style, 'padding') + sides(style, 'border-width');
    });
    const room = (content - gap - extras[0] - extras[1]) / 2;
    expect(room).toBeGreaterThan(0);
    expect(extras[0] + room + gap + room + extras[1]).toBeCloseTo(content, 6);
    for (const button of buttons) {
      const style = resolvedStyle(button);
      // Shares the width: grows and shrinks from a zero basis.
      expect(style['|flex']).toBe('1 1 0');
      expect(style['|min-width']).toBe('0');
      expect(style['|overflow']).toBe('hidden');
      expect(style['|white-space']).toBe('nowrap');
      // The parts that can't shrink: the icon and the gap after it.
      const fixed = 14 /* the icon */ + length(style, style['|gap']);
      expect(fixed, `${button.textContent}: ${fixed} px of fixed parts in ${room} px`).toBeLessThanOrEqual(room);
      // The label shrinks, with an ellipsis, rather than push the button out.
      const label = button.querySelector('span')!;
      const labelStyle = resolvedStyle(label);
      expect(labelStyle['|min-width']).toBe('0');
      expect(labelStyle['|text-overflow']).toBe('ellipsis');
      // And the visible label fits whole at this width.
      const fontSize = length(style, style['|font-size']) || 13;
      const text = label.textContent!;
      expect(fixed + text.length * GLYPH_EM * fontSize, `"${text}" at ${fontSize} px`).toBeLessThanOrEqual(room);
      // The full name couldn't, even at a narrow half-em a glyph (why the label is "Extract").
      if (text === 'Extract') expect(fixed + 'Extract from reference'.length * 0.5 * fontSize).toBeGreaterThan(room);
    }
    expect(buttons.map((b) => b.textContent)).toEqual(['Add', 'Extract']);
    expect(buttons[1].querySelector('input')?.getAttribute('aria-label')).toBe('Extract from reference');
    expect(buttons[1].getAttribute('title')).toBe('Extract a palette from an image');
  });
});
