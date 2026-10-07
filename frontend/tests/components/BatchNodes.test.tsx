import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData, PortValue } from '../../src/types';
import { BatchNode } from '../../src/components/nodes/BatchNode';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { DynamicNode } from '../../src/components/nodes/DynamicNode';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import { batchAuthoringError, batchSizeCap, parseBatchItems } from '../../src/lib/batch';
import { cameraPoseFixture } from '../fixtures/spatialValues';

const transport = vi.hoisted(() => ({ apiFetch: vi.fn(), download: vi.fn() }));
vi.mock('../../src/lib/backend', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/backend')>(), apiFetch: transport.apiFetch,
}));
vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../../src/lib/worldDownload', () => ({ downloadWorldAsset: transport.download }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type, 'aria-label': label }: { id?: string; type: string; 'aria-label'?: string }) =>
    <span data-testid={`handle-${type}-${id}`} aria-label={label} />,
}));
vi.mock('../../src/components/nodes/MeshPreview', () => ({
  MeshPreview: ({ src }: { src: string }) => <div data-testid="mesh-preview">{src}</div>,
}));
vi.mock('../../src/components/nodes/RepresentationViewer', () => ({
  RepresentationViewer: ({ type, value }: { type: string; value: unknown }) =>
    <div data-testid="representation-preview">{type}:{JSON.stringify(value)}</div>,
}));
vi.mock('../../src/components/nodes/BeforeAfterSlider', () => ({
  BeforeAfterSlider: ({ beforeSrc, afterSrc }: { beforeSrc: string; afterSrc: string }) =>
    <div data-testid="comparison-preview">{beforeSrc}:{afterSrc}</div>,
}));

const colors = ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet'];
const text = (value: string): Record<string, PortValue> => ({ text: { type: 'Text', value } });
function node(id = 'preview', definitionId = 'preview', patch: Partial<NodeData> = {}): Node<NodeData> {
  return { id, type: 'model-node', position: { x: 0, y: 0 }, data: {
    definitionId, label: definitionId, params: {}, state: 'complete', outputs: text('violet'),
    batchOutputs: colors.map(text), batchRunId: 'run-a',
    batchVariants: colors.map((label, index) => ({ index, label, lineage: [{
      source_node_id: 'batch', source_label: 'colors', index, item_label: label,
    }] })), ...patch,
  } };
}
function propsFor(value: Node<NodeData>): NodeProps { return { id: value.id, data: value.data, selected: false } as NodeProps; }
function StoreCard({ id = 'preview', dynamic = false }: { id?: string; dynamic?: boolean }) {
  const value = useGraphStore((state) => state.nodes.find((candidate) => candidate.id === id)!);
  return dynamic ? <DynamicNode {...propsFor(value)} /> : <ModelNode {...propsFor(value)} />;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  transport.apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  transport.download.mockResolvedValue(undefined);
  useGraphStore.getState().resetExecution();
  useGraphStore.setState({ nodes: [node()], edges: [], runHistory: [], activeRuns: [], isExecuting: false, isCancelling: false });
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('Batch authoring card', () => {
  it('shows the seven-color count/list, legacy Text output and an explicit editing path without requests', () => {
    render(<BatchNode {...propsFor(node('batch', 'batch', { state: 'idle', outputs: {},
      params: { display_name: 'colors', items_text: colors.join('\n'), split_mode: 'by_line', batch_size_cap: 10 } }))} />);
    expect(screen.getByText('colors')).toBeInTheDocument();
    expect(screen.getByText('7 items')).toBeInTheDocument();
    colors.forEach((color) => expect(screen.getByText(color)).toBeInTheDocument());
    expect(screen.getByTestId('handle-source-set')).toHaveAttribute('aria-label', 'Batch items output');
    expect(screen.getByText(/Cap 10.*Editing does not generate/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Batch items' }));
    expect(useUIStore.getState().selectedNodeId).toBe('batch');
    expect(useUIStore.getState().panels.inspector.visible).toBe(true);
    expect(transport.apiFetch).not.toHaveBeenCalled();
    expect(useGraphStore.getState().activeRuns).toEqual([]);
  });

  it('warns about overflow without clipping source/count and displays malformed values as errors', () => {
    const params = { items_text: colors.join('\n'), batch_size_cap: 2 };
    const view = render(<BatchNode {...propsFor(node('batch', 'batch', { params }))} />);
    expect(screen.getByRole('alert')).toHaveTextContent('7 items exceed the cap of 2');
    expect(screen.getByText('violet')).toBeInTheDocument();
    expect(params.items_text).toBe(colors.join('\n'));
    view.rerender(<BatchNode {...propsFor(node('batch', 'batch', { params: { items_text: ['bad'] } }))} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Items must be text');
    expect(transport.apiFetch).not.toHaveBeenCalled();
  });

  it('matches line/whole-text parsing and preserves authored values', () => {
    const params = { items_text: ' red \n\n orange\r\n ', split_mode: 'by_line' };
    expect(parseBatchItems(params)).toEqual(['red', 'orange']);
    expect(parseBatchItems({ ...params, split_mode: 'none' })).toEqual([params.items_text]);
    expect(parseBatchItems({ items_text: '', split_mode: 'none' })).toEqual([]);
    expect(parseBatchItems({ items_text: '  ', split_mode: 'none' })).toEqual(['  ']);
    expect(parseBatchItems({ items_text: false })).toEqual([]);
    expect(batchSizeCap({})).toBe(10);
    expect(batchSizeCap({ batch_size_cap: 25 })).toBe(25);
    expect(batchAuthoringError({ batch_size_cap: 26 })).toMatch(/1 to 25/);
    expect(batchAuthoringError({ split_mode: 'csv' })).toMatch(/By line or Whole text/);
  });
});

describe.each([['ModelNode', false], ['DynamicNode', true]] as const)('%s Batch result browsing', (_name, dynamic) => {
  it('starts at red, navigates/clamps all seven variants, and never changes graph/history or transports', () => {
    const snapshot = JSON.stringify(useGraphStore.getState().nodes);
    const history = JSON.stringify(useGraphStore.getState().runHistory);
    const view = render(<StoreCard dynamic={dynamic} />);
    expect(screen.getByText('[red]')).toHaveAttribute('title', 'colors: red');
    expect(screen.getByText('1 of 7 — red')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous batch result' })).toBeDisabled();
    const body = () => view.container.querySelector('.model-node__preview-text')!.textContent;
    expect(body()).toBe('red');
    fireEvent.click(screen.getByRole('button', { name: 'Next batch result' }));
    expect(body()).toBe('orange');
    expect(screen.getByText('[orange]')).toBeInTheDocument();
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole('button', { name: 'Next batch result' }));
    expect(body()).toBe('violet');
    expect(screen.getByText('7 of 7 — violet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next batch result' })).toBeDisabled();
    for (let i = 0; i < 8; i++) fireEvent.click(screen.getByRole('button', { name: 'Previous batch result' }));
    expect(body()).toBe('red');
    expect(JSON.stringify(useGraphStore.getState().nodes)).toBe(snapshot);
    expect(JSON.stringify(useGraphStore.getState().runHistory)).toBe(history);
    expect(transport.apiFetch).not.toHaveBeenCalled();
    expect(useGraphStore.getState().activeRuns).toEqual([]);
  });

  it('resets for a replaced owning run, retains live output while running, and preserves successes on error', () => {
    const view = render(<StoreCard dynamic={dynamic} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next batch result' }));
    act(() => useGraphStore.setState({ nodes: [node('preview', 'preview', { state: 'executing', streamingText: 'live green' })] }));
    expect(screen.queryByText('[orange]')).toBeNull();
    expect(screen.getByText('7 results · Running')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next batch result' })).toBeDisabled();
    expect(view.container.querySelector('.model-node__preview-text')).toHaveTextContent('live green');
    act(() => useGraphStore.setState({ nodes: [node('preview', 'preview', { batchRunId: 'run-b', batchOutputs: [text('pink'), text('cyan')],
      batchVariants: [{ index: 0, label: 'pink', lineage: [] }, { index: 1, label: 'cyan', lineage: [] }] })] }));
    expect(screen.getByText('[pink]')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 — pink')).toBeInTheDocument();
    act(() => useGraphStore.setState((state) => ({ nodes: state.nodes.map((value) => ({ ...value,
      data: { ...value.data, state: 'error', error: 'Third item failed' } })) })));
    fireEvent.click(screen.getByRole('button', { name: 'Next batch result' }));
    expect(screen.getByText('[cyan]')).toBeInTheDocument();
    expect(view.container.querySelector('.model-node__preview-text')).toHaveTextContent('cyan');
    expect(screen.getByText(/Third item failed/)).toBeInTheDocument();
    expect(transport.apiFetch).not.toHaveBeenCalled();
  });

  it('keeps selection independent between nodes and clamps when the displayed collection shrinks', () => {
    useGraphStore.setState({ nodes: [node('a'), node('b')] });
    const view = render(<><StoreCard id="a" dynamic={dynamic} /><StoreCard id="b" dynamic={dynamic} /></>);
    const cards = view.container.querySelectorAll('.model-node');
    fireEvent.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Next batch result' }));
    expect(within(cards[0] as HTMLElement).getByText('[orange]')).toBeInTheDocument();
    expect(within(cards[1] as HTMLElement).getByText('[red]')).toBeInTheDocument();
    act(() => useGraphStore.setState({ nodes: [node('a', 'preview', { batchOutputs: [text('red')], batchVariants: [{ index: 0, label: 'red', lineage: [] }] }), node('b')] }));
    expect(within(cards[0] as HTMLElement).getByText('1 of 1 — red')).toBeInTheDocument();
    expect(within(cards[0] as HTMLElement).getByRole('button', { name: 'Next batch result' })).toBeDisabled();
  });

  it('does not put a retained partial stream under a completed snapshot label', () => {
    useGraphStore.setState({ nodes: [node('preview', 'preview', {
      streamingText: 'abandoned partial text', streamingPartials: [{ index: 0, src: '/api/outputs/partial.png' }],
    })] });
    const view = render(<StoreCard dynamic={dynamic} />);
    expect(screen.getByText('[red]')).toBeInTheDocument();
    expect(view.container.querySelector('.model-node__preview-text')).toHaveTextContent('red');
    expect(screen.queryByText('abandoned partial text')).toBeNull();
    expect(view.container.querySelector('img[src="/api/outputs/partial.png"]')).toBeNull();
  });

  it.each(['Image', 'Video', 'Audio', 'SVG', 'Mesh', 'World', 'CameraPose'] as const)('renders the selected %s snapshot with the existing media/representation path', (type) => {
    const values: PortValue['value'][] = type === 'World'
      ? [{ schemaVersion: 1, provider: 'worldlabs', worldId: 'first-world', assets: {} }, { schemaVersion: 1, provider: 'worldlabs', worldId: 'second-world', assets: {} }]
      : type === 'CameraPose' ? [{ ...cameraPoseFixture, id: 'first-pose' }, { ...cameraPoseFixture, id: 'second-pose' }]
        : [`/api/outputs/first.${type.toLowerCase()}`, `/api/outputs/second.${type.toLowerCase()}`];
    const results = values.map((value) => ({ result: { type, value } as PortValue }));
    useGraphStore.setState({ nodes: [node('preview', 'preview', { outputs: results[1], batchOutputs: results,
      batchVariants: [{ index: 0, label: 'first', lineage: [] }, { index: 1, label: 'second', lineage: [] }] })] });
    const view = render(<StoreCard dynamic={dynamic} />);
    const selectedValue = () => {
      if (['World', 'CameraPose'].includes(type)) return screen.getByTestId('representation-preview').textContent;
      if (type === 'Mesh') return screen.getByTestId('mesh-preview').textContent;
      return view.container.querySelector(type === 'Video' ? 'video' : type === 'Audio' ? 'audio' : '.model-node__preview img')?.getAttribute('src');
    };
    expect(selectedValue()).toContain('first');
    fireEvent.click(screen.getByRole('button', { name: 'Next batch result' }));
    expect(selectedValue()).toContain('second');
    expect(useGraphStore.getState().nodes[0].data.outputs).toEqual(results[1]);
    expect(transport.apiFetch).not.toHaveBeenCalled();
  });
});

it('browses Image Compare pairs together and keeps the connected pair canonical', () => {
  const results = ['first', 'second'].map((name) => ({
    imageA: { type: 'Image', value: `/api/outputs/${name}-before.png` } as PortValue,
    imageB: { type: 'Image', value: `/api/outputs/${name}-after.png` } as PortValue,
  }));
  useGraphStore.setState({ nodes: [node('preview', 'image-compare', { outputs: results[1], batchOutputs: results })] });
  render(<StoreCard />);
  expect(screen.getByTestId('comparison-preview')).toHaveTextContent('first-before.png:/api/outputs/first-after.png');
  fireEvent.click(screen.getByRole('button', { name: 'Next batch result' }));
  expect(screen.getByTestId('comparison-preview')).toHaveTextContent('second-before.png:/api/outputs/second-after.png');
  expect(useGraphStore.getState().nodes[0].data.outputs).toEqual(results[1]);
  expect(transport.apiFetch).not.toHaveBeenCalled();
});

it('ordinary output rendering remains unchanged when a node has no batch collection', () => {
  useGraphStore.setState({ nodes: [node('preview', 'preview', { batchOutputs: undefined, batchVariants: undefined,
    batchRunId: undefined, outputs: text('ordinary result') })] });
  render(<StoreCard />);
  expect(screen.getByText('ordinary result')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Next batch result' })).toBeNull();
  expect(screen.queryByText(/Browsing keeps/)).toBeNull();
});

it('browses produced mask artifacts instead of the latest live source composite, with matching downloads', () => {
  const results = ['red', 'violet'].map((color) => ({
    mask: { type: 'Image', value: `/api/outputs/${color}-mask.png` } as PortValue,
  }));
  const upstream = node('upstream', 'image-input', { batchOutputs: undefined, batchVariants: undefined,
    outputs: { image: { type: 'Image', value: '/api/outputs/violet-source.png' } },
    params: { _previewUrl: '/api/outputs/violet-source.png' } });
  useGraphStore.setState({ nodes: [upstream, node('preview', 'mask-painter', { outputs: results[1],
    params: { _maskData: 'data:image/png;base64,painted-mask' }, batchOutputs: results,
    batchVariants: [{ index: 0, label: 'red', lineage: [] }, { index: 1, label: 'violet', lineage: [] }],
  })], edges: [{ id: 'image-wire', source: 'upstream', sourceHandle: 'image', target: 'preview', targetHandle: 'image' }] });
  const view = render(<StoreCard />);
  expect(screen.getByText('[red]')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Generated output' })).toHaveAttribute('src', '/api/outputs/red-mask.png');
  expect(screen.queryByRole('img', { name: 'Mask source' })).toBeNull();
  expect(screen.queryByRole('img', { name: 'Painted mask overlay' })).toBeNull();
  fireEvent.click(screen.getAllByRole('button', { name: 'Download image' })[0]);
  expect(transport.download).toHaveBeenLastCalledWith('/api/outputs/red-mask.png', expect.any(String), expect.any(Object));
  fireEvent.click(screen.getByRole('button', { name: 'Next batch result' }));
  expect(screen.getByText('[violet]')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Generated output' })).toHaveAttribute('src', '/api/outputs/violet-mask.png');
  fireEvent.click(screen.getAllByRole('button', { name: 'Download image' })[0]);
  expect(transport.download).toHaveBeenLastCalledWith('/api/outputs/violet-mask.png', expect.any(String), expect.any(Object));
  expect(useGraphStore.getState().nodes[1].data.outputs).toEqual(results[1]);
  expect(transport.apiFetch).not.toHaveBeenCalled();
  act(() => useGraphStore.setState((state) => ({ nodes: state.nodes.map((value) => value.id === 'preview'
    ? { ...value, data: { ...value.data, batchOutputs: undefined, batchVariants: undefined } } : value) })));
  expect(view.container.querySelector('.model-node__mask-composite')).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Mask source' })).toHaveAttribute('src', '/api/outputs/violet-source.png');
  expect(screen.getByRole('img', { name: 'Painted mask overlay' })).toHaveAttribute('src', 'data:image/png;base64,painted-mask');
});

it('downloads the visible image snapshot and retains the canonical latest connected output', () => {
  const first = { image: { type: 'Image', value: '/api/outputs/red.png' } as PortValue };
  const latest = { image: { type: 'Image', value: '/api/outputs/orange.png' } as PortValue };
  useGraphStore.setState({ nodes: [node('preview', 'preview', { outputs: latest, batchOutputs: [first, latest] })] });
  render(<StoreCard />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Download image' })[0]);
  expect(transport.download).toHaveBeenLastCalledWith('/api/outputs/red.png', expect.any(String), expect.any(Object));
  fireEvent.click(screen.getByRole('button', { name: 'Next batch result' }));
  fireEvent.click(screen.getAllByRole('button', { name: 'Download image' })[0]);
  expect(transport.download).toHaveBeenLastCalledWith('/api/outputs/orange.png', expect.any(String), expect.any(Object));
  expect(useGraphStore.getState().nodes[0].data.outputs).toEqual(latest);
  expect(transport.apiFetch).not.toHaveBeenCalled();
});
