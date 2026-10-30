import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider, type Node, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../src/types';

/**
 * PR #198 fix round 5:
 * - Review 5, N2: the selection toolbar's run-lock tooltip is GM's sentence,
 *   with its period (RUN_LOCK_REASON).
 * - GM r7 item 2: one selection style. The Cinema scene card drops #FF5A1F
 *   and takes the selected style every model card has, in its category's
 *   colour (--node-category-color, set on the card as ModelNode sets it),
 *   with the same breathing ring.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(),
  subscribe: vi.fn(() => () => {}) } }));

import { SelectionToolbar } from '../src/components/SelectionToolbar';
import { CinemaSceneNode } from '../src/components/nodes/CinemaSceneNode';
import { RUN_LOCK_REASON } from '../src/lib/cinemaScene';
import { CATEGORY_COLORS } from '../src/constants/ports';
import { useGraphStore } from '../src/store/graphStore';

afterEach(() => { cleanup(); useGraphStore.setState({ nodes: [], isExecuting: false }); });

describe('N2: the toolbar\'s run-lock tooltip', () => {
  it('Duplicate and Delete read "Wait for the active run to finish." while this tab runs', () => {
    const node = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, selected: true,
      data: { label: 'Text', definitionId: 'text-input', params: {}, outputs: {}, state: 'idle' } } as unknown as Node<NodeData>;
    useGraphStore.setState({ nodes: [node], edges: [], isExecuting: true });
    render(<SelectionToolbar />);
    expect(RUN_LOCK_REASON).toBe('Wait for the active run to finish.');
    // Round 6 (GM r8 merge check): Run and Arrange, which the run also
    // locks, say so too.
    expect(screen.getAllByTitle(RUN_LOCK_REASON).length).toBe(4);
    expect(screen.queryByTitle('Wait for the active run to finish')).toBeNull();
  });
});

describe('GM r7 item 2: the scene card\'s selected style', () => {
  const props = (selected: boolean) => ({ id: 'n4', selected, type: 'cinemaSceneNode', dragging: false,
    zIndex: 0, isConnectable: true, positionAbsoluteX: 0, positionAbsoluteY: 0, selectable: true, deletable: true, draggable: true,
    data: { label: 'Opening', definitionId: 'cinema-scene', state: 'idle', outputs: {},
      params: { scene: { version: 1, base: { model: 'seedream-4-5' }, aspectRatio: '16:9', shots: [] } } } }) as unknown as NodeProps;

  it('the card carries its category colour, as a model card does', () => {
    const { container } = render(<ReactFlowProvider><CinemaSceneNode {...props(true)} /></ReactFlowProvider>);
    const card = container.querySelector('.cinema-scene-node') as HTMLElement;
    expect(card.classList.contains('cinema-scene-node--selected')).toBe(true);
    expect(card.style.getPropertyValue('--node-category-color')).toBe(CATEGORY_COLORS.cinematic);
  });

  it('the CSS: the category colour and the breathing ring, never the orange accent', () => {
    const css = readFileSync(join(__dirname, '../src/styles/cinema-node.css'), 'utf8');
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf('}', at));
    };
    const selected = rule('body.app-slava-restraint .cinema-scene-node--selected');
    expect(selected).toContain('border-color: var(--node-category-color, var(--sr-accent))');
    expect(selected).toContain('border-width: var(--sr-node-card-selected-border-width)');
    expect(selected).toContain('animation: slava-select-breathe var(--sr-node-selected-duration) ease-in-out infinite');
    expect(selected).not.toMatch(/border-color: var\(--sr-accent\)/);
    // Reduced motion: the still ring, as model cards have it.
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(reduced).toContain('.cinema-scene-node--selected');
    expect(reduced).toContain('animation: none');
  });
});
