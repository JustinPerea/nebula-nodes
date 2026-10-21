import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Node, NodeProps } from '@xyflow/react';
import shared from '../../../backend/tests/fixtures/jev_outputs.json';
import type { NodeData, PortValue } from '../../src/types';
import { ModelNode } from '../../src/components/nodes/ModelNode';
import { DynamicNode } from '../../src/components/nodes/DynamicNode';
import { ExpandableBlock } from '../../src/components/nodes/ExpandableBlock';
import { Inspector } from '../../src/components/panels/Inspector';
import { JEV_DECIDE } from '../../src/lib/jev';
import { boundedJson, describeStructuredValue, CARD_LIMITS } from '../../src/lib/structuredValue';
import { useGraphStore } from '../../src/store/graphStore';
import { useUIStore } from '../../src/store/uiStore';
import { cameraPoseFixture, worldV1Fixture } from '../fixtures/spatialValues';

// The guards behind the Preview change's promise: outputs some renderer
// already draws stay exactly as they were, and only undrawn values get the
// structured block.

vi.mock('../../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));
vi.mock('../../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
  // The Moodboard node's settings list the boards it can pick.
  fetchMoodboards: vi.fn(async () => []),
  fetchMoodboard: vi.fn(async () => null),
}));
vi.mock('../../src/lib/worldDownload', () => ({ downloadWorldAsset: vi.fn() }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: ({ id, type }: { id?: string; type: string }) => <span data-testid={`handle-${type}-${id}`} />,
}));
vi.mock('../../src/components/nodes/MeshPreview', () => ({
  MeshPreview: ({ src }: { src: string }) => <div data-testid="mesh-preview">{src}</div>,
}));
vi.mock('../../src/components/nodes/RepresentationViewer', () => ({
  RepresentationViewer: ({ type }: { type: string }) => <div data-testid="representation-preview">{type}</div>,
}));

const jevDecide = (shared as unknown as { decide: Array<{ name: string; params?: Record<string, unknown>; outputs: Record<string, PortValue> }> })
  .decide[0];

let previousGraph: ReturnType<typeof useGraphStore.getState>;
let previousUi: ReturnType<typeof useUIStore.getState>;

beforeEach(() => {
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
});

type Card = 'model' | 'dynamic';

function renderCard(card: Card, outputs: Record<string, PortValue>, patch: Partial<NodeData> = {}) {
  const data = (card === 'model'
    ? { definitionId: 'preview', label: 'Preview', params: {}, state: 'complete', outputs, ...patch }
    : { definitionId: 'fal-universal', label: 'fal', params: {}, state: 'complete', outputs, ...patch }) as NodeData;
  const node: Node<NodeData> = { id: 'n1', type: card === 'model' ? 'model-node' : 'dynamic-node', position: { x: 0, y: 0 }, data };
  useGraphStore.setState({ nodes: [node], edges: [] });
  const props = { id: node.id, data: node.data, selected: false } as NodeProps;
  return render(card === 'model' ? <ModelNode {...props} /> : <DynamicNode {...props} />);
}

const DRAWN: Array<[string, Record<string, PortValue>]> = [
  ['an Image URL', { out: { type: 'Image', value: '/api/outputs/a.png' } }],
  ['a Video URL', { out: { type: 'Video', value: '/api/outputs/a.mp4' } }],
  ['an Audio URL', { out: { type: 'Audio', value: '/api/outputs/a.mp3' } }],
  ['a Mesh URL', { out: { type: 'Mesh', value: '/api/outputs/a.glb' } }],
  ['a Text string', { out: { type: 'Text', value: 'hello there' } }],
  ['a World', { out: { type: 'World', value: worldV1Fixture } as PortValue }],
  ['a spatial representation', { out: { type: 'CameraPose', value: cameraPoseFixture } as PortValue }],
];

describe('outputs that already draw get no structured block', () => {
  for (const card of ['model', 'dynamic'] as const) {
    it.each(DRAWN)(`${card} card: %s`, (_name, outputs) => {
      const { container } = renderCard(card, outputs);
      expect(container.querySelector('.structured-preview')).toBeNull();
      expect(container.querySelector('.model-node--structured-surface')).toBeNull();
    });
  }

  it('a Jev result keeps its verdict card', () => {
    const { container } = renderCard('model', jevDecide.outputs, { definitionId: JEV_DECIDE, params: jevDecide.params ?? {} });
    expect(screen.getByTestId('jev-result')).toBeInTheDocument();
    expect(container.querySelector('.structured-preview')).toBeNull();
  });

  it.each(['model', 'dynamic'] as const)('%s card: an undrawn value next to nothing drawn does get one', (card) => {
    const { container } = renderCard(card, { out: { type: 'Any', value: { status: 'done' } } });
    expect(container.querySelector('.model-node--structured-surface .structured-preview')).not.toBeNull();
  });
});

describe('structured values', () => {
  it('judges a mixed list by every item, not the first', () => {
    renderCard('model', { out: { type: 'Array', value: ['/api/outputs/a.png', 'plain words'] } });
    const card = screen.getByRole('group', { name: 'Array' });
    expect(within(card).getByText('2 items')).toBeInTheDocument();
    expect(within(card).getByText('plain words')).toBeInTheDocument();
    expect(within(card).queryByRole('img')).toBeNull();
  });

  it('keeps every row of an object whose keys share a long prefix, and repeated audio files', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderCard('model', { out: { type: 'Any', value: { [`${'k'.repeat(70)}1`]: 'one', [`${'k'.repeat(70)}2`]: 'two' } } });
    expect(screen.getByText('one')).toBeInTheDocument();
    expect(screen.getByText('two')).toBeInTheDocument();
    unmount();
    const audio = renderCard('model', { out: { type: 'Array', value: ['/api/outputs/a.mp3', '/api/outputs/a.mp3'] } });
    expect(audio.container.querySelectorAll('audio')).toHaveLength(2);
    const sameKey = errors.mock.calls.filter((call) => call.some((part) => String(part).includes('same key')));
    expect(sameKey).toEqual([]);
  });

  it('puts at most a few thousand characters of one long string on a card', () => {
    const { container } = renderCard('model', { out: { type: 'Any', value: 'word '.repeat(200_000) } });
    expect(container.querySelector('.structured-preview__text')!.textContent!.length).toBeLessThanOrEqual(4_001);
  });

  it('reads only what it shows of a very wide object', () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 50_000; index += 1) wide[`key${index}`] = index;
    let reads = 0;
    const counted = new Proxy(wide, { get: (target, key) => { reads += 1; return Reflect.get(target, key); } });

    const view = describeStructuredValue(counted, CARD_LIMITS);
    expect(view.kind === 'record' && view.total).toBe(50_000);
    expect(reads).toBeLessThan(1_000);

    reads = 0;
    const json = boundedJson(counted, 20_000);
    expect(json.truncated).toBe(true);
    expect(reads).toBeLessThan(5_000);
  });

  it('writes the same JSON as JSON.stringify for an object that fits', () => {
    const value = { a: 1, skip: undefined, b: { c: [1, 'x'], d: {} }, e: [] };
    expect(boundedJson(value, 10_000)).toEqual({ text: JSON.stringify(value, null, 2), truncated: false });
  });

  it('keeps the structured block visible zoomed out, as an overview preview', () => {
    const { container } = renderCard('model', { out: { type: 'Array', value: ['/api/outputs/a.png', '/api/outputs/b.png'] } });
    expect(container.querySelector('.model-node__preview--structured')).toHaveClass('model-node__preview--overview');
    const dynamic = renderCard('dynamic', { out: { type: 'Array', value: ['/api/outputs/a.png'] } });
    expect(dynamic.container.querySelector('.model-node__preview--structured')).toHaveClass('model-node__preview--overview');
  });
});

describe('Moodboard bundle details', () => {
  it('says the notes were not sent when the bundle has no brief', () => {
    renderCard('model', { out: { type: 'Moodboard', value: { kind: 'nebula_moodboard', name: 'N', notes: 'wet', styleBrief: '' } } });
    const status = within(screen.getByRole('group', { name: 'Moodboard N' })).getByRole('status');
    expect(status).toHaveTextContent('Notes not sent');
    expect(status).not.toHaveTextContent('Notes sent');
  });

  it('holds the whole board name for hover, on the card and in the Inspector', () => {
    const name = 'Harbor at Dusk, Long Exposure Study Series';
    renderCard('model', { out: { type: 'Moodboard', value: { kind: 'nebula_moodboard', name, styleBrief: 'b' } } });
    expect(screen.getByText(name)).toHaveAttribute('title', name);
  });

  it('names what each Read all opens and points it at its text', () => {
    renderCard('model', { out: { type: 'Moodboard', value: {
      kind: 'nebula_moodboard', name: 'Dusk Harbor', styleBrief: 'Long brief sentence. '.repeat(40),
    } } });
    const toggle = screen.getByRole('button', { name: 'Read all: brief of Dusk Harbor' });
    const body = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(body).toHaveTextContent(/Long brief sentence/);
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Show less: brief of Dusk Harbor' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('Read all after Show less', () => {
  it('keeps the toggle while the block is still springing shut', () => {
    // A layout jsdom doesn't have: 4 lines of 17.4 px closed, 300 px of text.
    let clientHeight = 70;
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => clientHeight);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => 300);
    const realStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = realStyle(element);
      return new Proxy(style, { get: (target, key) => (key === 'getPropertyValue'
        ? (name: string) => (name === '--expandable-line-height' ? '17.4px' : target.getPropertyValue(name))
        : Reflect.get(target, key)) });
    });
    render(<ExpandableBlock lines={4} contentKey="k" longHint={false}><p>long text</p></ExpandableBlock>);
    fireEvent.click(screen.getByRole('button', { name: 'Read all' }));
    // Open, the block is as tall as its content, and right after "Show less"
    // it still is: clientHeight equals scrollHeight.
    clientHeight = 300;
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByRole('button', { name: 'Read all' })).toBeInTheDocument();
  });
});

describe('Inspector last output', () => {
  function renderInspector(outputs: Record<string, PortValue>, patch: Partial<NodeData> = {}) {
    const node: Node<NodeData> = { id: 'n1', type: 'model-node', position: { x: 0, y: 0 },
      data: { definitionId: 'preview', label: 'Preview', params: {}, state: 'complete', outputs, ...patch } };
    useGraphStore.setState({ nodes: [node], edges: [] });
    useUIStore.setState({ selectedNodeId: 'n1' });
    return render(<Inspector embedded />);
  }

  it.each(DRAWN)('leaves out %s', (_name, outputs) => {
    renderInspector(outputs);
    expect(screen.queryByRole('region', { name: 'Last output' })).toBeNull();
  });

  it.each(['idle', 'executing', 'error'] as const)('shows nothing while the node is %s', (state) => {
    renderInspector({ out: { type: 'Any', value: { status: 'done' } } }, { state });
    expect(screen.queryByRole('region', { name: 'Last output' })).toBeNull();
  });

  it('loads every board image at once (lazy images never start in its scroll panel)', () => {
    const images = Array.from({ length: 6 }, (_, index) => ({ url: `/api/outputs/moodboards/${index}.png` }));
    renderInspector({ out: { type: 'Moodboard', value: { kind: 'nebula_moodboard', name: 'Six', images, styleBrief: 'b' } } });
    const section = screen.getByRole('region', { name: 'Last output' });
    const thumbs = within(section).getAllByRole('img');
    expect(thumbs).toHaveLength(6);
    for (const img of thumbs) expect(img).not.toHaveAttribute('loading', 'lazy');
  });

  // Q98: a Moodboard node run before board images were checked could save an
  // old board's outside link in `representative_images`. Opening that
  // project never loads it: the Last output shows the placeholder instead.
  it('never loads an outside link a Moodboard node saved in its representative images', () => {
    const { container } = renderInspector({
      representative_images: { type: 'Array', value: ['https://example.com/x.png', '/api/outputs/a.png'] },
    }, { definitionId: 'nebula-moodboard', label: 'Moodboard' });
    const section = screen.getByRole('region', { name: 'Last output' });
    const thumbs = within(section).getAllByRole('img');
    expect(thumbs).toHaveLength(1);
    expect(thumbs[0].getAttribute('src')).toContain('/api/outputs/a.png');
    expect(within(section).getByText('Image link from outside Nebula')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('example.com');
  });

  it('still draws a remote image another node returned', () => {
    renderInspector({ out: { type: 'Array', value: ['https://cdn.example.com/a.png'] } });
    const section = screen.getByRole('region', { name: 'Last output' });
    expect(within(section).getByRole('img')).toHaveAttribute('src', 'https://cdn.example.com/a.png');
  });

  it('wraps a long board name whole instead of cutting it', () => {
    const name = 'Harbor at Dusk, Long Exposure Study Series';
    renderInspector({ out: { type: 'Moodboard', value: { kind: 'nebula_moodboard', name, styleBrief: 'b' } } });
    const section = screen.getByRole('region', { name: 'Last output' });
    expect(within(section).getByText(name).closest('.structured-preview--full')).not.toBeNull();
  });
});
