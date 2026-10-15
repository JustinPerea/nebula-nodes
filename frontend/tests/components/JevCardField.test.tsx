import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeProps } from '@xyflow/react';
import shared from '../../../backend/tests/fixtures/jev_outputs.json';
import type { NodeData, PortValue } from '../../src/types';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import { JEV_BOX, JEV_DECIDE, JEV_PICK_BEST } from '../../src/lib/jev';

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

function node(
  id: string, definitionId: string, params: Record<string, unknown> = {},
  outputs: Record<string, PortValue> = {}, state: NodeData['state'] = 'idle',
): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, data: { definitionId, label: id, params, state, outputs } };
}

/** Renders the node as the canvas does: from the store, so edits show up. */
function LiveNode({ id }: { id: string }) {
  const current = useGraphStore((s) => s.nodes.find((n) => n.id === id));
  if (!current) return null;
  return <ModelNode {...({ id, data: current.data, selected: false } as NodeProps)} />;
}

function renderLive(n: Node<NodeData>) {
  useGraphStore.setState({ nodes: [n], edges: [] });
  return render(<LiveNode id={n.id} />);
}

const paramsOf = (id: string) => useGraphStore.getState().nodes.find((n) => n.id === id)?.data.params;

beforeEach(() => {
  useGraphStore.setState({ nodes: [], edges: [], isExecuting: false });
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null });
});
afterEach(cleanup);

describe('Jev card field', () => {
  it.each([
    [JEV_PICK_BEST, 'Question', 'TEXTAREA'],
    [JEV_DECIDE, 'Question', 'TEXTAREA'],
    [JEV_BOX, 'Find', 'INPUT'],
  ])('%s shows an editable %s box on the card', (definitionId, label, tag) => {
    renderLive(node('j1', definitionId));
    const field = screen.getByLabelText(label);
    expect(field.tagName).toBe(tag);
    expect(field).toHaveClass('nodrag', 'nowheel');
  });

  it('does not appear on other model nodes', () => {
    const { container } = renderLive(node('g1', 'gpt-image-2-generate', { prompt: 'a cat' }));
    expect(container.querySelector('.model-node__jev-field')).toBeNull();
    expect(screen.queryByLabelText('Question')).not.toBeInTheDocument();
  });

  it('writes what you type into the node params, where the Inspector reads them', () => {
    renderLive(node('j1', JEV_DECIDE, { question: '', answer_type: 'yes_no' }));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Is the logo visible?' } });
    expect(paramsOf('j1')).toEqual({ question: 'Is the logo visible?', answer_type: 'yes_no' });
    expect(screen.getByLabelText('Question')).toHaveValue('Is the logo visible?');

    act(() => { useGraphStore.getState().updateNodeData('j1', { params: { question: 'Set from the Inspector', answer_type: 'yes_no' } }); });
    expect(screen.getByLabelText('Question')).toHaveValue('Set from the Inspector');
  });

  it("shows the param's placeholder when empty", () => {
    renderLive(node('b1', JEV_BOX, { target: '' }));
    expect(screen.getByLabelText('Find')).toHaveAttribute('placeholder', 'the red car');
    cleanup();
    renderLive(node('p1', JEV_PICK_BEST, { question: '' }));
    expect(screen.getByLabelText('Question')).toHaveAttribute('placeholder', 'Which image best matches the brief?');
  });

  it('keeps Backspace, Delete and shortcut keys away from the canvas listeners', () => {
    const onDocument = vi.fn();
    const onWindow = vi.fn();
    document.addEventListener('keydown', onDocument);
    window.addEventListener('keydown', onWindow);
    try {
      renderLive(node('j1', JEV_DECIDE, { question: 'Is it red?' }));
      const field = screen.getByLabelText('Question');
      for (const key of ['Backspace', 'Delete', 'f', 'Enter']) fireEvent.keyDown(field, { key });
      fireEvent.mouseDown(field);
      expect(onDocument).not.toHaveBeenCalled();
      expect(onWindow).not.toHaveBeenCalled();
      expect(useGraphStore.getState().nodes.map((n) => n.id)).toEqual(['j1']);
    } finally {
      document.removeEventListener('keydown', onDocument);
      window.removeEventListener('keydown', onWindow);
    }
  });

  it('notes when a wired Target input takes precedence over the typed target', () => {
    const box = node('b1', JEV_BOX, { target: 'the red car' });
    useGraphStore.setState({
      nodes: [node('t1', 'text-input', { value: 'a dog' }), box],
      edges: [{ id: 'e1', source: 't1', sourceHandle: 'text', target: 'b1', targetHandle: 'target' }],
    });
    render(<LiveNode id="b1" />);
    expect(screen.getByText('Used when the Target input is empty')).toBeInTheDocument();
  });
});

describe('Jev result under the card field', () => {
  it('does not repeat the question the field already shows', () => {
    const s = sample(fixture.decide, 'yes/no that passes');
    renderLive(node('j1', JEV_DECIDE, s.params, s.outputs, 'complete'));
    expect(screen.getByTestId('jev-result')).toBeInTheDocument();
    expect(screen.getByLabelText('Question')).toHaveValue('Is the product on a plain white background?');
    expect(screen.queryByTestId('jev-asked')).not.toBeInTheDocument();
  });

  it('treats a blank Pick Best question as its default, which is what it asked', () => {
    const s = sample(fixture.pickBest, 'a clear winner');
    renderLive(node('p1', JEV_PICK_BEST, { question: '' }, s.outputs, 'complete'));
    expect(screen.queryByTestId('jev-asked')).not.toBeInTheDocument();
  });

  it('keeps showing the answered question once the field is edited after the run', () => {
    const s = sample(fixture.decide, 'yes/no that passes');
    renderLive(node('j1', JEV_DECIDE, s.params, s.outputs, 'complete'));
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Is the logo visible?' } });
    const asked = screen.getByTestId('jev-asked');
    expect(asked).toHaveTextContent('Asked Is the product on a plain white background?');
    expect(screen.getByTestId('jev-result')).toBeInTheDocument();
  });

  it('marks a Box target edited after the run as the one it searched for', () => {
    const s = sample(fixture.box, 'found with a confident box');
    renderLive(node('b1', JEV_BOX, s.params, s.outputs, 'complete'));
    expect(screen.queryByTestId('jev-asked')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'the teapot' } });
    expect(screen.getByTestId('jev-asked')).toHaveTextContent('Searched for the coffee mug');
  });
});
