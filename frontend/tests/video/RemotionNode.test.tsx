import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { NodeProps } from '@xyflow/react';
import { RemotionNode } from '../../src/components/nodes/RemotionNode';

vi.mock('../../src/store/uiStore', () => ({
  useUIStore: (selector: (s: { enterRemotionEditor: (id: string) => void }) => unknown) =>
    selector({ enterRemotionEditor: vi.fn() }),
}));

function mkEmptyProps(overrides: Partial<NodeProps> = {}): NodeProps {
  return {
    id: 'remotion-1',
    type: 'remotionNode',
    selected: false,
    data: { params: { manifest: { graph: { nodes: [], edges: [] }, timeline: [] } } },
    ...overrides,
  } as unknown as NodeProps;
}

function mkPropsWithLayer(timeline: object[], overrides: Partial<NodeProps> = {}): NodeProps {
  return {
    id: 'remotion-1',
    type: 'remotionNode',
    selected: false,
    data: { params: { manifest: { graph: { nodes: [], edges: [] }, timeline } } },
    ...overrides,
  } as unknown as NodeProps;
}

describe('RemotionNode card', () => {
  it('renders title and empty-state summary', () => {
    render(
      <ReactFlowProvider>
        <RemotionNode {...mkEmptyProps()} />
      </ReactFlowProvider>,
    );
    expect(screen.getByText(/Remotion Composition/i)).toBeInTheDocument();
    expect(screen.getByText(/no layers yet/i)).toBeInTheDocument();
  });

  it('renders layer count when manifest has TrackItems', () => {
    const timeline = [
      { id: 't1', sourceNodeId: 's1', componentType: 'TextNode', time: { startFrame: 0, durationInFrames: 60 }, spatial: { x: 0, y: 0, z: 0, scale: [1, 1, 1], rotation: [0, 0, 0] }, keyframes: {}, props: {} },
    ];
    render(
      <ReactFlowProvider>
        <RemotionNode {...mkPropsWithLayer(timeline)} />
      </ReactFlowProvider>,
    );
    expect(screen.getByText(/1 layer · 60f/i)).toBeInTheDocument();
  });

  it('shows Open Editor button when selected', () => {
    render(
      <ReactFlowProvider>
        <RemotionNode {...mkEmptyProps({ selected: true })} />
      </ReactFlowProvider>,
    );
    expect(screen.getByRole('button', { name: /open editor/i })).toBeInTheDocument();
  });
});
