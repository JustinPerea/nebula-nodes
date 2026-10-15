import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Position, type EdgeProps, type Node, type NodeProps } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { TypedEdge } from '../../src/components/edges/TypedEdge';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

function node(id: string, definitionId: string, patch: Partial<NodeData> = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId, label: definitionId, params: {}, state: 'idle', outputs: {}, ...patch } };
}

function edgeProps(source: string, sourceHandleId: string): EdgeProps {
  return { id: `${source}-${sourceHandleId}`, source, target: 'up', sourceHandleId, targetHandleId: 'image',
    sourceX: 0, sourceY: 0, targetX: 100, targetY: 40, sourcePosition: Position.Right, targetPosition: Position.Left,
    data: { dataType: 'Any' } } as unknown as EdgeProps;
}

beforeEach(() => {
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null });
});

describe('gated nodes on the canvas', () => {
  it('shows a skipped node dimmed with a Skipped chip that names the gate, and no stale preview', () => {
    const skipped = node('up', 'esrgan-upscale', {
      state: 'skipped', skipReason: 'Jev Decide failed (answered no, 0.12)', skipGateNodeId: 'gate',
      outputs: { image: { type: 'Image', value: '/api/outputs/old.png' } },
    });
    useGraphStore.setState({ nodes: [skipped], edges: [] });
    const { container } = render(<ModelNode {...({ id: 'up', data: skipped.data, selected: false } as NodeProps)} />);
    const chip = screen.getByRole('status', { name: 'Skipped: Jev Decide failed (answered no, 0.12)' });
    expect(chip).toHaveTextContent('Skipped');
    expect(chip).toHaveAttribute('title', 'Skipped: Jev Decide failed (answered no, 0.12)');
    expect(container.querySelector('.model-node--skipped')).not.toBeNull();
    expect(container.querySelector('img[src*="old.png"]')).toBeNull();
  });

  it('draws a wire from a withheld port as inactive and keeps the live branch normal', () => {
    useGraphStore.setState({ nodes: [node('gate', 'jev-decide', {
      state: 'complete', withheldPorts: { on_fail: 'Jev Decide passed (answered yes, 0.93)' },
    })], edges: [] });
    const { container } = render(
      <svg>
        <TypedEdge {...edgeProps('gate', 'on_fail')} />
        <TypedEdge {...edgeProps('gate', 'on_pass')} />
      </svg>,
    );
    const paths = container.querySelectorAll('path.react-flow__edge-path');
    expect(paths).toHaveLength(2);
    expect(paths[0].classList.contains('typed-edge--inactive')).toBe(true);
    expect(paths[1].classList.contains('typed-edge--inactive')).toBe(false);
  });
});
