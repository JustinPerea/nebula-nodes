import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BatchRunInspection } from '../src/components/panels/BatchRunInspection';
import type { RunRecord } from '../src/lib/runHistory';
import { getBackendBaseUrl } from '../src/lib/backend';
import { useGraphStore } from '../src/store/graphStore';

function record(status: RunRecord['status']): RunRecord {
  return { id: 'batch-run', trigger: 'graph', startedAt: 1, status, snapshot: { nodes: [], edges: [] },
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
    expect(screen.getByText('model · Result 1')).toBeInTheDocument();
    expect(screen.getByText('model · Result 2')).toBeInTheDocument();
    expect(screen.getByText('First caption')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open image · image' })).toHaveAttribute('href', 'http://localhost:8000/api/outputs/first.png');
    expect(screen.getByRole('link', { name: 'Open video · video' })).toHaveAttribute('href', 'http://localhost:8000/api/outputs/second.mp4');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
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
      expect(screen.getByText('model · Red logo')).toBeInTheDocument();
      expect(screen.getByText('model · Blue logo')).toBeInTheDocument();
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
    expect(screen.getByText('model · Result 1')).toBeInTheDocument();
    expect(screen.getByText('model · Result 2')).toBeInTheDocument();
    expect(screen.queryByText(/Misaligned label/)).not.toBeInTheDocument();
  });
});
