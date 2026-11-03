import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
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
// "Drop ... the palette exception"): NodeInspectorContentFit.test.tsx.

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
