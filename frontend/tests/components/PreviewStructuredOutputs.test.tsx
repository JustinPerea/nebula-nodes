import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import type { NodeData, PortValue } from '../../src/types';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { DynamicNode } from '../../src/components/nodes/DynamicNode';
import { Inspector } from '../../src/components/panels/Inspector';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(), disconnect: vi.fn() } }));
vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));

// The bundle the Moodboard node sends (backend/handlers/moodboard.py).
const BUNDLE = {
  kind: 'nebula_moodboard',
  moodboardId: 'mb-1',
  name: 'Dusk Harbor',
  mode: 'look',
  strength: 0.7,
  images: [
    { id: 'a', url: '/api/outputs/moodboards/a.png', weight: 1, notes: '', excluded: false },
    { id: 'b', url: '/api/outputs/moodboards/b.png', weight: 1, notes: '', excluded: false },
    { id: 'c', url: '/api/outputs/moodboards/c.png', weight: 1, notes: '', excluded: false },
    { id: 'd', url: '/api/outputs/moodboards/d.png', weight: 1, notes: '', excluded: false },
    { id: 'e', url: '/api/outputs/moodboards/e.png', weight: 1, notes: '', excluded: false },
  ],
  notes: 'Wet streets after rain',
  analysis: {
    // The raw analysis still holds the colour the person kept out; the card
    // must show the brief's palette, never this one.
    palette: ['#112233', '#445566', '#ff00ff'],
    accents: ['#ee8844'],
    warnings: ['One image could not be read.'],
  },
  styleBrief: `Use the Nebula moodboard 'Dusk Harbor' as look direction. ${'Long brief sentence. '.repeat(40)}`,
  negativePrompt: 'blurry, low-detail artifacts',
  avoid: ['text', 'logos'],
  avoidPrompt: 'Keep these out of the image: text, logos.',
  direction: '',
  pinnedColors: { include: [], exclude: ['#ff00ff', '#00ff00'] },
  briefOverride: { active: false, stale: false },
  palette: ['#112233', '#445566'],
  accents: ['#ee8844'],
  representativeImages: ['/api/outputs/moodboards/b.png', '/api/outputs/moodboards/a.png'],
  providerHints: {},
};

let previousGraph: ReturnType<typeof useGraphStore.getState>;
let previousUi: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null });
});

afterEach(() => {
  cleanup();
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
});

function previewNode(value: PortValue, patch: Partial<NodeData> = {}): Node<NodeData> {
  return { id: 'n2', type: 'model-node', position: { x: 0, y: 0 },
    data: { definitionId: 'preview', label: 'Preview', params: {}, state: 'complete', outputs: { input: value }, ...patch } };
}

function renderPreview(value: PortValue, patch: Partial<NodeData> = {}) {
  const node = previewNode(value, patch);
  useGraphStore.setState({ nodes: [node], edges: [] });
  return render(<ModelNode {...({ id: node.id, data: node.data, selected: false } as NodeProps)} />);
}

describe('Preview card with a Moodboard bundle', () => {
  it('shows the board as a generator sees it: name, brief palette and accents, images, brief and status', () => {
    const { container } = renderPreview({ type: 'Moodboard', value: BUNDLE });
    expect(screen.queryByText('Output ready')).toBeNull();
    const card = screen.getByRole('group', { name: 'Moodboard Dusk Harbor' });
    expect(within(card).getByText('Dusk Harbor')).toBeInTheDocument();
    expect(within(card).getByText(/look · 70% · 5 images/)).toBeInTheDocument();

    const palette = within(card).getByRole('list', { name: 'Palette' });
    expect(within(palette).getAllByRole('listitem').map((item) => item.getAttribute('title')))
      .toEqual(['#112233', '#445566']);
    const accents = within(card).getByRole('list', { name: 'Accents' });
    expect(within(accents).getAllByRole('listitem').map((item) => item.getAttribute('title'))).toEqual(['#ee8844']);
    // The kept-out colour from the raw analysis never shows.
    expect(container.querySelector('[title="#ff00ff"]')).toBeNull();

    // Representative images first, then the rest, four at most, then +N.
    const images = within(card).getAllByRole('img');
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      expect.stringContaining('/api/outputs/moodboards/b.png'),
      expect.stringContaining('/api/outputs/moodboards/a.png'),
      expect.stringContaining('/api/outputs/moodboards/c.png'),
      expect.stringContaining('/api/outputs/moodboards/d.png'),
    ]);
    expect(within(card).getByText('+1')).toBeInTheDocument();

    expect(within(card).getByText(/Use the Nebula moodboard 'Dusk Harbor' as look direction/)).toBeInTheDocument();
    const status = within(card).getByRole('status');
    expect(status).toHaveTextContent('Notes sent');
    expect(status).toHaveTextContent('2 colors left out');
    expect(status).toHaveTextContent('Avoids 2 things');
    expect(status).toHaveTextContent('One image could not be read.');
    expect(container.querySelector('.model-node--structured-surface')).not.toBeNull();
  });

  it('opens the whole brief with Read all and closes it again', () => {
    renderPreview({ type: 'Moodboard', value: BUNDLE });
    const toggle = screen.getByRole('button', { name: 'Read all' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByRole('button', { name: 'Read all' })).toBeInTheDocument();
  });

  it('says when the notes were not sent because the brief was written by hand', () => {
    renderPreview({ type: 'Moodboard', value: {
      ...BUNDLE, pinnedColors: { include: [], exclude: [] }, avoid: [], analysis: {},
      briefOverride: { active: true, stale: true }, styleBrief: 'My own brief.',
    } });
    const status = within(screen.getByRole('group', { name: 'Moodboard Dusk Harbor' })).getByRole('status');
    expect(status).toHaveTextContent('Notes not sent');
    expect(status).toHaveTextContent('Brief written by hand, out of date');
    expect(status).not.toHaveTextContent('left out');
  });

  it('asks for an analysis when the bundle has no brief, and survives odd shapes', () => {
    renderPreview({ type: 'Moodboard', value: {
      kind: 'nebula_moodboard', name: 42, palette: 'nope', accents: [1, '#abc'], images: 'x', styleBrief: '',
    } });
    const card = screen.getByRole('group', { name: 'Moodboard Untitled board' });
    expect(within(card).getByText('Analyze the board to build its brief')).toBeInTheDocument();
    expect(within(card).queryByRole('list', { name: 'Palette' })).toBeNull();
    expect(within(within(card).getByRole('list', { name: 'Accents' })).getAllByRole('listitem')).toHaveLength(1);
  });
});

describe('Preview card fallback for structured values', () => {
  it('draws an array of image URLs as images', () => {
    renderPreview({ type: 'Array', value: ['/api/outputs/a.png', 'https://example.com/b.jpg?x=1'] });
    expect(screen.queryByText('Output ready')).toBeNull();
    const card = screen.getByRole('group', { name: 'Array' });
    expect(within(card).getAllByRole('img').map((img) => img.getAttribute('src'))).toEqual([
      expect.stringContaining('/api/outputs/a.png'), 'https://example.com/b.jpg?x=1',
    ]);
    expect(within(card).getByText('2 images')).toBeInTheDocument();
  });

  it('draws an array of hex colours as swatches', () => {
    renderPreview({ type: 'Array', value: ['#112233', '#AABBCC'] });
    const list = screen.getByRole('list', { name: 'Colors' });
    expect(within(list).getAllByRole('listitem').map((item) => item.getAttribute('title'))).toEqual(['#112233', '#AABBCC']);
  });

  it('draws a Character as its name, its reference images and its fields', () => {
    renderPreview({ type: 'Character', value: {
      characterId: 'c1', name: 'Mara', referenceViews: ['/api/outputs/front.png'],
      frozenTraitString: 'red coat, short hair', seed: 7, consistencyStrength: 0.8,
    } });
    const card = screen.getByRole('group', { name: 'Character Mara' });
    expect(within(card).getByText('Mara')).toBeInTheDocument();
    expect(within(card).getByRole('img')).toHaveAttribute('src', expect.stringContaining('/api/outputs/front.png'));
    expect(within(card).getByText('frozenTraitString')).toBeInTheDocument();
    expect(within(card).getByText('red coat, short hair')).toBeInTheDocument();
    expect(within(card).getByText('0.8')).toBeInTheDocument();
  });

  it('draws an object typed Any as readable key/value text', () => {
    renderPreview({ type: 'Any', value: { kind: 'krea_moodboard', id: 'kb-9', strength: 0.5, tags: ['a', 'b'], nested: { x: 1 } } });
    const card = screen.getByRole('group', { name: 'Any krea_moodboard' });
    expect(within(card).getByText('strength')).toBeInTheDocument();
    expect(within(card).getByText('0.5')).toBeInTheDocument();
    expect(within(card).getByText('2 items')).toBeInTheDocument();
    expect(within(card).getByText('1 field')).toBeInTheDocument();
  });

  it('draws a Text port holding an object instead of nothing', () => {
    renderPreview({ type: 'Text', value: { a: 1 } } as unknown as PortValue);
    expect(screen.getByRole('group', { name: 'Text' })).toHaveTextContent('a');
  });

  it('says there is no value for a null', () => {
    renderPreview({ type: 'Any', value: null });
    expect(screen.getByText('No value')).toBeInTheDocument();
  });

  it('caps very large values', () => {
    const big = { rows: Array.from({ length: 5000 }, (_, i) => ({ i, label: `row ${i}` })), blob: 'x'.repeat(200_000) };
    const many = Array.from({ length: 3000 }, (_, i) => `item ${i}`);
    const { container, unmount } = renderPreview({ type: 'Any', value: big });
    expect(container.textContent!.length).toBeLessThan(4000);
    expect(screen.getByText('5000 items')).toBeInTheDocument();
    unmount();
    const second = renderPreview({ type: 'Array', value: many });
    expect(second.container.textContent!.length).toBeLessThan(4000);
    expect(screen.getByText('3000 items')).toBeInTheDocument();
    expect(screen.getByText('item 0')).toBeInTheDocument();
  });

  it('leaves outputs that already draw alone', () => {
    const { container } = renderPreview({ type: 'Image', value: '/api/outputs/a.png' });
    expect(container.querySelector('.model-node__preview--overview img')).not.toBeNull();
    expect(container.querySelector('.structured-preview')).toBeNull();
  });
});

describe('Dynamic node fallback', () => {
  it('draws a structured output on a dynamic node', () => {
    const data = { definitionId: 'fal-universal', label: 'fal', params: {}, state: 'complete',
      outputs: { result: { type: 'Any', value: { status: 'done', count: 3 } } } } as NodeData;
    useGraphStore.setState({ nodes: [{ id: 'n3', type: 'dynamic-node', position: { x: 0, y: 0 }, data }], edges: [] });
    render(<DynamicNode {...({ id: 'n3', data, selected: false } as NodeProps)} />);
    expect(screen.getByText('status')).toBeInTheDocument();
    expect(screen.getByText('done')).toBeInTheDocument();
  });
});

describe('Inspector last output', () => {
  it('shows a selected Preview node\'s Moodboard bundle, brief unclamped', () => {
    useGraphStore.setState({ nodes: [previewNode({ type: 'Moodboard', value: BUNDLE })], edges: [] });
    useUIStore.setState({ selectedNodeId: 'n2' });
    render(<Inspector embedded />);
    const section = screen.getByRole('region', { name: 'Last output' });
    expect(within(section).getByText('Dusk Harbor')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Read all' })).toBeNull();
    expect(within(section).getByText(/Long brief sentence/)).toBeInTheDocument();
  });

  it('shows a structured value as JSON with a Copy button', () => {
    useGraphStore.setState({ nodes: [previewNode({ type: 'Any', value: { kind: 'krea_job', id: 'j1' } })], edges: [] });
    useUIStore.setState({ selectedNodeId: 'n2' });
    render(<Inspector embedded />);
    const section = screen.getByRole('region', { name: 'Last output' });
    expect(within(section).getByText(/"kind": "krea_job"/)).toBeInTheDocument();
    expect(within(section).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('caps a very large value at 20,000 characters of JSON and says so', () => {
    const big = { rows: Array.from({ length: 50_000 }, (_, i) => ({ i, label: `row ${i}` })) };
    useGraphStore.setState({ nodes: [previewNode({ type: 'Any', value: big })], edges: [] });
    useUIStore.setState({ selectedNodeId: 'n2' });
    render(<Inspector embedded />);
    const section = screen.getByRole('region', { name: 'Last output' });
    const json = section.querySelector('pre')!;
    expect(json.textContent!.length).toBeLessThanOrEqual(20_002);
    expect(within(section).getByText(/Showing the first 20,000 characters/)).toBeInTheDocument();
  });
});
