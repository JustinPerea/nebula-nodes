import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeProps } from '@xyflow/react';
import shared from '../../../backend/tests/fixtures/jev_outputs.json';
import type { NodeData, PortValue } from '../../src/types';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { JevResultView } from '../../src/components/nodes/JevResult';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import { CATEGORY_COLORS } from '../../src/constants/ports';
import {
  JEV_BOX, JEV_BRAND, JEV_DECIDE, JEV_NODE_IDS, JEV_PICK_BEST, jevBrandStyle, parseJevOutputs, type JevResult,
} from '../../src/lib/jev';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

type Sample = { name: string; params?: Record<string, unknown>; outputs: Record<string, PortValue> };
const fixture = shared as unknown as { decide: Sample[]; pickBest: Sample[]; box: Sample[] };
const sample = (list: Sample[], name: string) => {
  const found = list.find((s) => s.name.includes(name));
  if (!found) throw new Error(`no fixture sample "${name}"`);
  return found;
};
const parse = (id: string, s: Sample) => parseJevOutputs(id, s.outputs) as JevResult;

function renderNode(definitionId: string, patch: Partial<NodeData> = {}) {
  const data: NodeData = { definitionId, label: definitionId, params: {}, state: 'idle', outputs: {}, ...patch };
  const node: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 }, data };
  useGraphStore.setState({ nodes: [node], edges: [] });
  const { container } = render(<ModelNode {...({ id: 'n1', data, selected: false } as NodeProps)} />);
  return container.querySelector('.model-node') as HTMLElement;
}

beforeEach(() => {
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null });
});
afterEach(cleanup);

describe('Jev nodes wear TypeSafe pink', () => {
  it('defines the colours once, as variables for the node', () => {
    expect(JEV_BRAND).toEqual({ accent: '#E551BA', soft: '#F386A1' });
    expect(jevBrandStyle()).toEqual({
      '--node-category-color': JEV_BRAND.accent,
      '--jev-brand': JEV_BRAND.accent,
      '--jev-brand-soft': JEV_BRAND.soft,
    });
  });

  it.each(JEV_NODE_IDS)('%s gets the brand class and variables before it has a result', (definitionId) => {
    const el = renderNode(definitionId);
    expect(el).toHaveClass('model-node--jev');
    expect(el).not.toHaveClass('model-node--jev-surface');
    expect(el.style.getPropertyValue('--jev-brand')).toBe(JEV_BRAND.accent);
    expect(el.style.getPropertyValue('--jev-brand-soft')).toBe(JEV_BRAND.soft);
    expect(el.style.getPropertyValue('--node-category-color')).toBe(JEV_BRAND.accent);
  });

  it('keeps the brand once a result is showing', () => {
    const s = sample(fixture.decide, 'yes/no that passes');
    const outputs = Object.fromEntries(Object.entries(s.outputs)) as NodeData['outputs'];
    const el = renderNode(JEV_DECIDE, { state: 'complete', outputs, params: s.params ?? {} });
    expect(el).toHaveClass('model-node--jev');
    expect(el).toHaveClass('model-node--jev-surface');
    expect(el.style.getPropertyValue('--jev-brand')).toBe(JEV_BRAND.accent);
  });

  it.each(['esrgan-upscale', 'text-input'])('leaves %s alone', (definitionId) => {
    const el = renderNode(definitionId);
    expect(el).not.toHaveClass('model-node--jev');
    expect(el.style.getPropertyValue('--jev-brand')).toBe('');
    expect(el.style.getPropertyValue('--jev-brand-soft')).toBe('');
    expect(el.style.getPropertyValue('--node-category-color')).not.toBe(JEV_BRAND.accent);
    expect(Object.values(CATEGORY_COLORS)).toContain(el.style.getPropertyValue('--node-category-color'));
  });
});

describe('Jev results: pink where it is not a verdict', () => {
  it("Pick Best's winner chip and bar are pink", () => {
    const s = sample(fixture.pickBest, 'a clear winner');
    const { container } = render(<JevResultView result={parse(JEV_PICK_BEST, s)} params={s.params ?? {}} />);
    expect(container.querySelector('.jev-result__chip')).toHaveClass('jev-result__chip--brand');
    expect(container.querySelector('.jev-result__candidate--winner .jev-result__bar-fill')).toHaveClass('jev-result__fill--brand');
    expect(container.querySelectorAll('.jev-result__fill--pass')).toHaveLength(0);
  });

  it('a close Pick Best stays yellow', () => {
    const s = sample(fixture.pickBest, 'any would do');
    const { container } = render(<JevResultView result={parse(JEV_PICK_BEST, s)} params={s.params ?? {}} />);
    expect(container.querySelector('.jev-result__chip')).toHaveClass('jev-result__chip--unsure');
    expect(container.querySelectorAll('.jev-result__fill--brand')).toHaveLength(0);
  });

  it('Decide and Box keep their verdict colours', () => {
    const decide = sample(fixture.decide, 'yes/no that passes');
    render(<JevResultView result={parse(JEV_DECIDE, decide)} params={decide.params ?? {}} />);
    const box = fixture.box.find((s) => parse(JEV_BOX, s)?.kind === 'box' && (parse(JEV_BOX, s) as { found: string }).found === 'true');
    if (!box) throw new Error('no found Box sample');
    render(<JevResultView result={parse(JEV_BOX, box)} params={box.params ?? {}} />);
    const chips = screen.getAllByText(/^(Pass|Found)$/).map((el) => el.closest('.jev-result__chip'));
    expect(chips).toHaveLength(2);
    for (const chip of chips) expect(chip).toHaveClass('jev-result__chip--pass');
    expect(document.querySelectorAll('.jev-result__chip--brand')).toHaveLength(0);
  });
});
