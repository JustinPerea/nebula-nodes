import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData } from '../../src/types';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

function previewNode(outputs: NodeData['outputs']): Node<NodeData> {
  return { id: 'p', type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId: 'preview', label: 'Box mask', params: {}, state: 'complete', outputs } };
}

function renderNode(n: Node<NodeData>) {
  useGraphStore.setState({ nodes: [n], edges: [] });
  return render(<ModelNode {...({ id: n.id, data: n.data, selected: false } as NodeProps)} />);
}

beforeEach(() => {
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null });
});

describe('mask previews', () => {
  it('draws a Mask value on a Preview card, the way an image is drawn', () => {
    const { container } = renderNode(previewNode({ input: { type: 'Mask', value: '/api/outputs/run/jev-box-mask.png' } }));
    expect(container.querySelector('img.model-node__preview-image[src*="jev-box-mask.png"]')).not.toBeNull();
    expect(container.querySelector('.model-node__preview-placeholder')).toBeNull();
  });

  it('prefers a regular image when a node has both an image and a mask', () => {
    const { container } = renderNode(previewNode({
      mask: { type: 'Mask', value: '/api/outputs/run/mask.png' },
      image: { type: 'Image', value: '/api/outputs/run/photo.png' },
    }));
    const imgs = [...container.querySelectorAll('img.model-node__preview-image')].map((i) => i.getAttribute('src'));
    expect(imgs.some((src) => src?.includes('photo.png'))).toBe(true);
    expect(imgs.some((src) => src?.includes('mask.png'))).toBe(false);
  });
});
