import { afterEach, describe, expect, it } from 'vitest';
import { NODE_DEFINITIONS } from '../src/constants/nodeDefinitions';
import { canvasTitle } from '../src/lib/directRoute';
import { fireEvent, render, screen } from '@testing-library/react';
import { BatchRunInspection } from '../src/components/panels/BatchRunInspection';
import { openOutputLabel } from '../src/lib/openOutputLabel';
import type { RunRecord } from '../src/lib/runHistory';
import { getBackendBaseUrl } from '../src/lib/backend';
import { useGraphStore } from '../src/store/graphStore';

function record(status: RunRecord['status']): RunRecord {
  return { id: 'batch-run', trigger: 'graph', startedAt: 1, status, snapshot: { nodes: [{ id: 'model', definitionId: 'batch', label: 'Prefix', params: {}, outputs: {} }], edges: [] },
    batchOutputs: { model: [
      { image: { type: 'Image', value: 'http://127.0.0.1:9292/api/outputs/first.png' }, text: { type: 'Text', value: 'First caption' } },
      { video: { type: 'Video', value: '/api/outputs/second.mp4' } },
    ] },
  };
}

describe('historical batch result access', () => {
  it.each(['complete', 'failed', 'cancelled'] as const)('exposes every saved item in a %s run without starting execution', async (status) => {
    await getBackendBaseUrl();
    render(<BatchRunInspection record={record(status)} />);
    fireEvent.click(screen.getByText('Batch results · 2'));
    expect(screen.getByText('Prefix · Result 1')).toBeInTheDocument();
    expect(screen.getByText('Prefix · Result 2')).toBeInTheDocument();
    expect(screen.getByText('First caption')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open image, Prefix · Result 1' })).toHaveAttribute('href', 'http://localhost:8000/api/outputs/first.png');
    expect(screen.getByRole('link', { name: 'Open video, Prefix · Result 2' })).toHaveAttribute('href', 'http://localhost:8000/api/outputs/second.mp4');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names the port only when it says something the kind does not', () => {
    expect(openOutputLabel('Image', 'image')).toBe('Open image');
    expect(openOutputLabel('Image', 'mask')).toBe('Open image · mask');
    expect(openOutputLabel('SVG', 'svg')).toBe('Open SVG');
    expect(openOutputLabel('SVG', 'logo')).toBe('Open SVG · logo');
    expect(openOutputLabel('Mesh', 'Mesh')).toBe('Open mesh');
  });

  it('reads two-word types as words and matches the port ignoring case and non-letters', () => {
    expect(openOutputLabel('DepthMap', 'depth_map')).toBe('Open depth map');
    expect(openOutputLabel('DepthMap', 'depthMap')).toBe('Open depth map');
    expect(openOutputLabel('DepthMap', 'DepthMap')).toBe('Open depth map');
    expect(openOutputLabel('DepthMap', 'preview')).toBe('Open depth map · preview');
    expect(openOutputLabel('Mask', 'mask')).toBe('Open mask');
    expect(openOutputLabel('PointCloud', 'cloud')).toBe('Open point cloud · cloud');
  });

  it('links mask and depth map outputs in words, each with a unique accessible name', () => {
    const saved = record('complete');
    saved.batchOutputs = { model: [
      { mask: { type: 'Mask', value: '/api/outputs/m.png' }, depth_map: { type: 'DepthMap', value: '/api/outputs/d.png' } },
      { image: { type: 'Image', value: '/api/outputs/a.png' } },
    ] };
    render(<BatchRunInspection record={saved} />);
    const mask = screen.getByRole('link', { name: 'Open mask, Prefix · Result 1' });
    const depth = screen.getByRole('link', { name: 'Open depth map, Prefix · Result 1' });
    expect(mask).toHaveTextContent('Open mask');
    expect(depth).toHaveTextContent('Open depth map');
    const names = screen.getAllByRole('link').map((link) => link.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
  });

  it('draws the caption in the body face, not a pre', () => {
    const { container } = render(<BatchRunInspection record={record('complete')} />);
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getByText('First caption').tagName).toBe('P');
  });

  describe('node names', () => {
    const run = (nodes: RunRecord['snapshot']['nodes']): RunRecord => {
      const saved = record('complete');
      saved.snapshot = { nodes, edges: [] };
      saved.batchOutputs = { model: [{ text: { type: 'Text', value: 'x' } }] };
      return saved;
    };
    const live = (nodes: unknown[]) => useGraphStore.setState({ nodes: nodes as never });
    const original = useGraphStore.getState().nodes;
    afterEach(() => useGraphStore.setState({ nodes: original }));

    it('uses the name the node ran under, even after a rename', () => {
      live([{ id: 'model', position: { x: 0, y: 0 }, data: { label: 'Renamed', definitionId: 'batch', params: {}, outputs: {}, state: 'idle' } }]);
      render(<BatchRunInspection record={run([{ id: 'model', definitionId: 'batch', label: 'Hero', params: {}, outputs: {} }])} />);
      expect(screen.getByText('Hero · Result 1')).toBeInTheDocument();
    });

    it('uses the default card title for an unnamed node, never its id', () => {
      const definition = NODE_DEFINITIONS.batch;
      render(<BatchRunInspection record={run([{ id: 'model', definitionId: 'batch', params: {}, outputs: {} }])} />);
      expect(screen.getByText(`${canvasTitle(definition)} · Result 1`)).toBeInTheDocument();
      expect(screen.queryByText(/model/)).not.toBeInTheDocument();
    });

    it('reads a node deleted from the live graph from its snapshot', () => {
      live([]);
      render(<BatchRunInspection record={run([{ id: 'model', definitionId: 'batch', label: 'Gone', params: {}, outputs: {} }])} />);
      expect(screen.getByText('Gone · Result 1')).toBeInTheDocument();
    });

    it('falls back to the live node when the snapshot lacks it', () => {
      live([{ id: 'model', position: { x: 0, y: 0 }, data: { label: 'Live name', definitionId: 'batch', params: {}, outputs: {}, state: 'idle' } }]);
      render(<BatchRunInspection record={run([])} />);
      expect(screen.getByText('Live name · Result 1')).toBeInTheDocument();
    });

    it('reads "Node" when neither the snapshot nor the canvas has it, never the id', () => {
      live([]);
      render(<BatchRunInspection record={run([])} />);
      expect(screen.getByText('Node · Result 1')).toBeInTheDocument();
      expect(screen.queryByText(/model/)).not.toBeInTheDocument();
    });
  });

  it('does not turn saved text or unsafe schemes into executable links', () => {
    const saved = record('complete');
    saved.batchOutputs = { model: [
      { image: { type: 'Image', value: 'javascript:alert(1)' }, text: { type: 'Text', value: 'javascript:plain text' } },
    ] };
    render(<BatchRunInspection record={saved} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('javascript:plain text')).toBeInTheDocument();
  });

  it('omits the disclosure for normal single-result runs', () => {
    const saved = record('complete');
    delete saved.batchOutputs;
    const { container } = render(<BatchRunInspection record={saved} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('keeps saved labels and lineage after the live source is edited', () => {
    const saved = record('complete');
    saved.batchVariants = { model: [
      { index: 0, label: 'Red logo', lineage: [{ source_node_id: 'source', source_label: 'Colors',
        index: 0, item_label: 'red' }] },
      { index: 1, label: 'Blue logo', lineage: [{ source_node_id: 'source', source_label: 'Colors',
        index: 1, item_label: 'blue' }] },
    ] };
    const originalNodes = useGraphStore.getState().nodes;
    const rendered = render(<BatchRunInspection record={saved} />);
    try {
      useGraphStore.setState({ nodes: [{ id: 'source', position: { x: 0, y: 0 }, data: {
        label: 'Changed source', definitionId: 'batch', params: {
          display_name: 'Changed palette', items_text: 'yellow\npurple',
        }, outputs: {}, state: 'idle',
      } }] });
      rendered.rerender(<BatchRunInspection record={saved} />);
      expect(screen.getByText('Prefix · Red logo')).toBeInTheDocument();
      expect(screen.getByText('Prefix · Blue logo')).toBeInTheDocument();
      expect(screen.getByText('Colors: red')).toBeInTheDocument();
      expect(screen.getByText('Colors: blue')).toBeInTheDocument();
      expect(screen.queryByText(/Changed palette|yellow|purple/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    } finally {
      rendered.unmount();
      useGraphStore.setState({ nodes: originalNodes });
    }
  });

  it('falls back to result numbers for the whole node when metadata count does not match', () => {
    const saved = record('complete');
    saved.batchVariants = { model: [{ index: 0, label: 'Misaligned label', lineage: [] }] };
    render(<BatchRunInspection record={saved} />);
    expect(screen.getByText('Prefix · Result 1')).toBeInTheDocument();
    expect(screen.getByText('Prefix · Result 2')).toBeInTheDocument();
    expect(screen.queryByText(/Misaligned label/)).not.toBeInTheDocument();
  });
});
