/**
 * lib/cardChunks.ts is the canvas's list of what a node needs loaded. Two
 * things must hold for a card to never draw empty: every deferred card in
 * CANVAS_CARDS is in the list, and a node for which a card mounts a result
 * view is a node the list asks that view's chunk for (the cards and the list
 * decide with the same predicates, lib/resultViews.ts, and this drives the
 * real cards rather than a copy of the condition).
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Node, NodeProps } from '@xyflow/react';
import shared from '../../backend/tests/fixtures/jev_outputs.json';
import type { NodeData, PortValue } from '../src/types';

const mounted = vi.hoisted(() => new Set<string>());
vi.mock('../src/components/nodes/DeferredOutputViews', () => ({
  JevResultView: () => { mounted.add('jev'); return null; },
  RepresentationViewer: () => { mounted.add('viewer'); return null; },
  StructuredOutputs: () => { mounted.add('structured'); return null; },
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));
vi.mock('../src/lib/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/api')>(),
  getSettings: vi.fn(async () => ({ favorites: {} })),
}));
vi.mock('../src/lib/worldDownload', () => ({ downloadWorldAsset: vi.fn() }));
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...await importOriginal<typeof import('@xyflow/react')>(),
  Handle: () => null,
}));

import { CANVAS_CARDS } from '../src/components/canvasTypes';
import { ModelNode } from '../src/components/nodes/ModelNode';
import { DynamicNode } from '../src/components/nodes/DynamicNode';
import { ALL_CARD_CHUNKS, CARD_CHUNK_BY_TYPE, cardChunksOf } from '../src/lib/cardChunks';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFERRED_CARD_PRELOADS, DEFERRED_PRELOADS, DeferredJevResultView, DeferredRepresentationViewer, DeferredStructuredOutputs } from '../src/lib/deferredChunks';
import { JEV_DECIDE, JEV_PICK_BEST } from '../src/lib/jev';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { cameraPoseFixture, worldV1Fixture } from './fixtures/spatialValues';

beforeAll(async () => { await Promise.all(DEFERRED_CARD_PRELOADS.map((preload) => preload())); });

describe('every deferred card is in the list', () => {
  const deferred = Object.entries(CANVAS_CARDS).flatMap(([type, card]) => {
    const chunk = (card as { chunk?: unknown }).chunk;
    return chunk ? [[type, chunk] as const] : [];
  });

  it('there are deferred cards to check', () => {
    expect(deferred.length).toBeGreaterThanOrEqual(10);
  });

  it.each(deferred)('%s', (type, chunk) => {
    expect(CARD_CHUNK_BY_TYPE[type]).toBe(chunk);
    expect(ALL_CARD_CHUNKS).toContain(chunk);
  });

  it('the list holds no type the canvas does not defer', () => {
    expect(Object.keys(CARD_CHUNK_BY_TYPE).sort()).toEqual(deferred.map(([type]) => type).sort());
  });
});

// ---- the predicates ---------------------------------------------------------

const decide = (shared as unknown as { decide: Array<{ params?: Record<string, unknown>; outputs: Record<string, PortValue> }> }).decide[0];
const pick = (shared as unknown as { pickBest: Array<{ params?: Record<string, unknown>; outputs: Record<string, PortValue> }> }).pickBest[0];

interface Case { name: string; card: 'model' | 'dynamic'; data: Partial<NodeData> }
const out = (outputs: Record<string, PortValue>, patch: Partial<NodeData> = {}): Partial<NodeData> => ({ state: 'complete', outputs, ...patch });
const CASES: Case[] = [
  { name: 'a Jev decide answer', card: 'model', data: out(decide.outputs, { definitionId: JEV_DECIDE, params: decide.params ?? {} }) },
  { name: 'a Jev pick-best answer', card: 'model', data: out(pick.outputs, { definitionId: JEV_PICK_BEST, params: pick.params ?? {} }) },
  { name: 'a Jev node still running', card: 'model', data: { state: 'executing', outputs: decide.outputs, definitionId: JEV_DECIDE } },
  { name: 'a World on a model card', card: 'model', data: out({ out: { type: 'World', value: worldV1Fixture } as PortValue }) },
  { name: 'a World on a dynamic card', card: 'dynamic', data: out({ out: { type: 'World', value: worldV1Fixture } as PortValue }) },
  { name: 'a camera pose on a model card', card: 'model', data: out({ out: { type: 'CameraPose', value: cameraPoseFixture } as PortValue }) },
  { name: 'a camera pose on a dynamic card', card: 'dynamic', data: out({ out: { type: 'CameraPose', value: cameraPoseFixture } as PortValue }) },
  { name: 'a structured value on a model card', card: 'model', data: out({ out: { type: 'Any', value: { status: 'done' } } }) },
  { name: 'a structured value on a dynamic card', card: 'dynamic', data: out({ out: { type: 'Any', value: { status: 'done' } } }) },
  { name: 'a list of mixed strings', card: 'model', data: out({ out: { type: 'Array', value: ['/api/outputs/a.png', 'plain words'] } }) },
  { name: 'a Moodboard bundle', card: 'model', data: out({ out: { type: 'Moodboard', value: { kind: 'nebula_moodboard', name: 'Dusk', images: [] } } }) },
  { name: 'a text with an empty text next to a structured value', card: 'model', data: out({ a: { type: 'Text', value: '' }, b: { type: 'Any', value: { x: 1 } } }) },
  { name: 'streamed text over a structured value', card: 'model', data: out({ a: { type: 'Text', value: 'done' }, b: { type: 'Any', value: { x: 1 } } }, { streamingText: '' }) },
  { name: 'a mask only', card: 'model', data: out({ m: { type: 'Mask', value: '/api/outputs/m.png' } }) },
  { name: 'a non-string image value', card: 'model', data: out({ i: { type: 'Image', value: ['/api/outputs/a.png'] } }) },
  { name: 'an image', card: 'model', data: out({ i: { type: 'Image', value: '/api/outputs/a.png' } }) },
  { name: 'a video', card: 'dynamic', data: out({ v: { type: 'Video', value: '/api/outputs/a.mp4' } }) },
  { name: 'text', card: 'model', data: out({ t: { type: 'Text', value: 'hello there' } }) },
  { name: 'nothing yet', card: 'model', data: { state: 'idle', outputs: {} } },
  { name: 'browsed batch results (idle, second one structured)', card: 'model',
    data: { state: 'idle', outputs: {}, batchOutputs: [{ i: { type: 'Image', value: '/api/outputs/a.png' } }, { o: { type: 'Any', value: { n: 2 } } }] } },
  { name: 'browsed batch results holding a World second', card: 'model',
    data: { state: 'idle', outputs: {}, batchOutputs: [{ i: { type: 'Image', value: '/api/outputs/a.png' } }, { w: { type: 'World', value: worldV1Fixture } as PortValue }] } },
];

const CHUNK_OF = { jev: DeferredJevResultView, viewer: DeferredRepresentationViewer, structured: DeferredStructuredOutputs } as const;

function dataFor(item: Case): NodeData {
  const base = item.card === 'model' ? { definitionId: 'preview', label: 'Preview' } : { definitionId: 'fal-universal', label: 'fal' };
  return { params: {}, state: 'idle', outputs: {}, ...base, ...item.data } as NodeData;
}

let previousGraph: ReturnType<typeof useGraphStore.getState>;
let previousUi: ReturnType<typeof useUIStore.getState>;
beforeEach(() => {
  mounted.clear();
  previousGraph = useGraphStore.getState();
  previousUi = useUIStore.getState();
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null });
});
afterEach(() => {
  cleanup();
  useGraphStore.setState(previousGraph, true);
  useUIStore.setState(previousUi, true);
});

describe('a result view a card mounts is a chunk the list asks for', () => {
  it.each(CASES)('$name', (item) => {
    const data = dataFor(item);
    const node: Node<NodeData> = { id: 'n1', type: item.card === 'model' ? 'model-node' : 'dynamic-node', position: { x: 0, y: 0 }, data };
    useGraphStore.setState({ nodes: [node], edges: [] });
    const props = { id: node.id, data, selected: false } as NodeProps;
    render(item.card === 'model' ? <ModelNode {...props} /> : <DynamicNode {...props} />);

    const asked = cardChunksOf(node);
    for (const view of mounted) {
      expect(asked, `the card mounted ${view}`).toContain(CHUNK_OF[view as keyof typeof CHUNK_OF]);
    }
  });

  it('each of the three views is mounted by some case (the check is not vacuous)', () => {
    const seen = new Set<string>();
    for (const item of CASES) {
      mounted.clear();
      const data = dataFor(item);
      const node: Node<NodeData> = { id: 'n1', type: item.card === 'model' ? 'model-node' : 'dynamic-node', position: { x: 0, y: 0 }, data };
      useGraphStore.setState({ nodes: [node], edges: [] });
      const props = { id: node.id, data, selected: false } as NodeProps;
      const view = render(item.card === 'model' ? <ModelNode {...props} /> : <DynamicNode {...props} />);
      for (const name of mounted) seen.add(name);
      view.unmount();
    }
    expect([...seen].sort()).toEqual(['jev', 'structured', 'viewer']);
  });

  it('does not ask for views a plain finished card never mounts', () => {
    for (const name of ['an image', 'a video', 'text', 'nothing yet', 'a Jev node still running']) {
      const item = CASES.find((c) => c.name === name)!;
      const node = { id: 'n1', type: item.card === 'model' ? 'model-node' : 'dynamic-node', position: { x: 0, y: 0 }, data: dataFor(item) } as Node<NodeData>;
      expect(cardChunksOf(node), name).toEqual([...(item.card === 'dynamic' ? [CARD_CHUNK_BY_TYPE['dynamic-node']] : [])]);
    }
  });

  it('asks for a deferred card by its type', () => {
    expect(cardChunksOf({ type: 'characterNode', data: {} as NodeData, id: 'x', position: { x: 0, y: 0 } } as Node)).toEqual([CARD_CHUNK_BY_TYPE.characterNode]);
    expect(cardChunksOf({ type: 'model-node', data: {} as NodeData, id: 'x', position: { x: 0, y: 0 } } as Node)).toEqual([]);
  });
});

describe('the idle preload brings the card chunks in before anyone adds a node', () => {
  it('asks for every card chunk the canvas can wait on', () => {
    for (const chunk of ALL_CARD_CHUNKS) expect(DEFERRED_PRELOADS, 'a card chunk missing from the idle preload').toContain(chunk.preload);
  });

  it('App starts the preload once the first paint is done, not at module load', () => {
    const app = readFileSync(join(__dirname, '../src/App.tsx'), 'utf8');
    expect(app).toMatch(/useEffect\(\(\) => whenIdle\(\(\) => preloadAll\(DEFERRED_PRELOADS\)\), \[\]\)/);
  });
});
