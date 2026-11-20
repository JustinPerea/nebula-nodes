/**
 * Design: the Cinema shot panel's failed block is the node card's notice, in the warning look:
 * warning text on the warning tint, no border or edge, and the card notice's type size, padding
 * and corner radius, inset from the preview by the card notice's own margin. Resolved through
 * the app's own stylesheets (tests/helpers/cssCascade), the card's `.model-node__error` as the
 * reference, never a copy of its values.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Node } from '@xyflow/react';
import type { CinemaSceneSpec, NodeData } from '../src/types';
import { cascaded } from './helpers/cssCascade';
import { leftBar, lineFill, lineLook } from './helpers/lineLook';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

import { CinemaShotPanel } from '../src/components/cinema-studio/CinemaShotPanel';
import { useGraphStore, resetDeletedSceneEditsForTests } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';

beforeEach(() => { document.body.className = 'app-slava-restraint'; });
afterEach(() => { cleanup(); resetDeletedSceneEditsForTests(); document.body.className = ''; });

type Output = NonNullable<CinemaSceneSpec['shots'][number]['output']>;
function failedBlock(output: Output = { status: 'error', error: 'No mask painted yet', errorCategory: 'unknown', errorPerson: 'No mask painted yet' }): Element {
  const spec: CinemaSceneSpec = { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [{ id: 'a', prompt: 'Logo', output }] };
  const node: Node<NodeData> = { id: 'n1', type: 'cinemaSceneNode', position: { x: 0, y: 0 }, data: { label: 'Scene',
    definitionId: 'cinema-scene', params: { scene: spec }, state: 'error', outputs: {} } };
  useGraphStore.setState({ nodes: [node], edges: [], isImportingGraph: false, isShotAdmissionBlocked: () => false });
  useUIStore.setState({ viewMode: 'cinema-editor', cinemaEditorNodeId: 'n1' });
  const { container } = render(<CinemaShotPanel cinemaNodeId="n1" scene={spec} shot={spec.shots[0]} onChangeShot={vi.fn()} />);
  return container.querySelector('.cinema-shot-panel__error')!;
}

function cardNotice(): Element {
  const box = document.createElement('div'); box.className = 'model-node__error'; box.setAttribute('data-line-box', '');
  document.body.appendChild(box); return box;
}

const SAME = ['font-family', 'font-size', 'line-height', 'padding', 'margin', 'border-radius'];

describe('the failed shot block takes the card notice\'s look (design)', () => {
  it('warning text on the warning tint, no border, no edge', () => {
    const block = failedBlock();
    expect(lineLook(block).color).toBe('var(--sr-warning)');
    expect(lineFill(block)).toBe('var(--sr-warning-soft)');
    const won = cascaded(block);
    const drawn = [...won].filter(([prop, win]) => /^\|border(?!-radius)/.test(prop) && !/^(?:none|0|0px)$/.test(win.value.trim()));
    expect(drawn.map(([prop]) => prop), 'a border').toEqual([]);
    expect(leftBar(block), 'a bar down the edge').toBe(false);
    expect(won.get('|box-shadow')?.value ?? 'none').toBe('none');
  });

  it('font size, line height, padding, margin (the inset) and radius are the card notice\'s, by the same declarations', () => {
    const block = cascaded(failedBlock());
    const card = cascaded(cardNotice());
    for (const prop of SAME) {
      expect(block.get(`|${prop}`)?.value, prop).toBe(card.get(`|${prop}`)?.value);
    }
    expect(card.get('|font-size')?.value).toBe('var(--sr-type-label)');
    expect(card.get('|padding')?.value).toBe('var(--sr-node-error-padding)');
    expect(block.get('|margin')?.value).toBe('var(--sr-node-error-margin)');
  });

  it('keeps its place over the bottom of the preview', () => {
    const won = cascaded(failedBlock());
    expect(['position', 'left', 'right', 'bottom'].map((prop) => won.get(`|${prop}`)?.value)).toEqual(['absolute', '0', '0', '0']);
  });

  it('its Details toggle takes the card\'s size', () => {
    const output = { status: 'error' as const, error: 'cut', errorCategory: 'unknown', errorFriendly: 'cut', errorRaw: 'the whole raw text' };
    const block = failedBlock(output);
    const summary = block.querySelector('summary')!;
    const card = document.createElement('div');
    card.innerHTML = '<div class="model-node__error"><div class="model-node__error-details"><summary>Details</summary></div></div>';
    document.body.appendChild(card);
    expect(cascaded(summary).get('|font-size')?.value).toBe('9px');
    expect(cascaded(summary).get('|font-size')?.value).toBe(cascaded(card.querySelector('summary')!).get('|font-size')?.value);
  });
});

describe('cinema-studio.css only places the failed block (design: its look is the card notice\'s)', () => {
  it('every rule naming cinema-shot-panel__error, with descendants and states, declares layout only', () => {
    const css = readFileSync(join(__dirname, '../src/styles/cinema-studio.css'), 'utf8');
    const LAYOUT = /^(?:position|left|right|top|bottom|inset(?:-[\w-]+)?|z-index|width|max-width)$/;
    const found: string[] = [];
    let rules = 0;
    postcss.parse(css).walkRules((rule) => {
      if (!rule.selector.includes('cinema-shot-panel__error')) return;
      rules += 1;
      rule.walkDecls((decl) => { if (!LAYOUT.test(decl.prop)) found.push(`${rule.selector} { ${decl.prop} }`); });
    });
    expect(rules, 'the placement rule is still there').toBeGreaterThan(0);
    expect(found, 'a look declared on the block, which the card notice owns').toEqual([]);
  });
});
