/**
 * GM - Design (2026-11-14): the Remotion card's selected border takes the
 * node's category colour, as the model card's and the boundary card's do,
 * not the accent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { CATEGORY_COLORS } from '../src/constants/ports';
import { RemotionNode } from '../src/components/nodes/RemotionNode';

vi.mock('../src/store/uiStore', () => ({
  useUIStore: (selector: (s: { enterRemotionEditor: (id: string) => void }) => unknown) =>
    selector({ enterRemotionEditor: vi.fn() }),
}));

afterEach(cleanup);

describe('the Remotion card\'s selected border', () => {
  it('the rule takes the category colour, with the accent only as a fallback', () => {
    const css = readFileSync(join(__dirname, '../src/styles/remotion-node.css'), 'utf8');
    // The model card's selection style in the category colour (r7), as the boundary and Cinema scene cards: colour, width and the breathe.
    const rule = /\n(?:body\.app-slava-restraint )?\.remotion-node--selected \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/border-color: var\(--node-category-color, var\(--sr-accent\)\);/);
    expect(rule).toMatch(/border-width: var\(--sr-node-card-selected-border-width\);/);
    expect(rule).toMatch(/animation: slava-select-breathe var\(--sr-node-selected-duration\) ease-in-out infinite;/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toMatch(/\.remotion-node--selected \{\s*animation: none;\s*box-shadow:/);
  });

  it('the rendered card carries the category colour of its definition', () => {
    const props = { id: 'r1', type: 'remotionNode', selected: true,
      data: { definitionId: 'remotion-node', params: {} } } as unknown as NodeProps;
    render(<ReactFlowProvider><RemotionNode {...props} /></ReactFlowProvider>);
    const card = document.querySelector('.remotion-node') as HTMLElement;
    const color = CATEGORY_COLORS[NODE_DEFINITIONS['remotion-node'].category];
    expect(color).toBeTruthy();
    expect(card.style.getPropertyValue('--node-category-color')).toBe(color);
  });
});
