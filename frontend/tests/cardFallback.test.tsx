/**
 * The fallback card (lib/cardFallback.ts, components/nodes/CardFallback.tsx):
 * the frame of a node whose card chunk is loading or failed. Its ports are
 * the real card's (so wires stay attached when the card replaces it) and its
 * widths are the cards' own CSS widths.
 */
import { cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react';
import type { NodeData } from '../src/types';
import { DEFERRED_CARD_PRELOADS } from '../src/lib/deferredChunks';

vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), subscribe: vi.fn(() => () => {}),
} }));

import { CANVAS_EDGE_TYPES, CANVAS_NODE_TYPES } from '../src/components/canvasTypes';
import { CARD_FALLBACK_TYPE, FALLBACK_SIZE_BY_TYPE, HELD_CARD, fallbackNode, fallbackSize, heldCardOf } from '../src/lib/cardFallback';
import { CARD_CHUNK_BY_TYPE } from '../src/lib/cardChunks';

class NoResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoResizeObserver as unknown as typeof ResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };

beforeAll(async () => { await Promise.all(DEFERRED_CARD_PRELOADS.map((preload) => preload())); });
afterEach(cleanup);

/** The ten deferred cards, as the canvas draws them. */
const CARDS: Array<[type: string, definitionId: string, params?: Record<string, unknown>]> = [
  ['dynamic-node', 'dynamic-test'],
  ['editNode', 'video-edit'],
  ['remotionNode', 'remotion-node'],
  ['cinemaSceneNode', 'cinema-scene'],
  ['characterNode', 'character'],
  ['cameraRigNode', 'camera-rig'],
  ['referenceSetNode', 'reference-set'],
  ['moodboardNode', 'nebula-moodboard'],
  ['paperSourceNode', 'paper-source'],
  ['batchNode', 'batch', { items_text: 'one\ntwo' }],
];

function card(type: string, definitionId: string, params: Record<string, unknown> = {}): Node<NodeData> {
  const dynamic = type === 'dynamic-node' ? {
    isDynamic: true,
    dynamicInputPorts: [{ id: 'prompt', label: 'Prompt', dataType: 'Text', required: false }],
    dynamicOutputPorts: [{ id: 'image', label: 'Image', dataType: 'Image' }],
  } : {};
  return { id: type, type, position: { x: 0, y: 0 },
    data: { definitionId, label: `${type} name`, params, state: 'idle', outputs: {}, ...dynamic } as unknown as NodeData };
}

function handlesOf(nodes: Node[]): Map<string, string[]> {
  render(
    <ReactFlowProvider>
      <div style={{ width: 1200, height: 800 }}>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={CANVAS_NODE_TYPES} edgeTypes={CANVAS_EDGE_TYPES} />
      </div>
    </ReactFlowProvider>,
  );
  const out = new Map<string, string[]>();
  for (const el of document.querySelectorAll('.react-flow__node')) {
    const ports = [...el.querySelectorAll('.react-flow__handle')].map((h) => `${h.getAttribute('data-handlepos')}:${h.getAttribute('data-handleid')}`);
    out.set(el.getAttribute('data-id') ?? '', ports.sort());
  }
  return out;
}

describe('the fallback card draws the real card\'s ports, so its wires stay attached', () => {
  it.each(CARDS)('%s', (type, definitionId, params) => {
    const real = handlesOf([card(type, definitionId, params)]).get(type)!;
    cleanup();
    const frame = handlesOf([fallbackNode(card(type, definitionId, params))]).get(type)!;
    expect(real.length).toBeGreaterThan(0);
    // Same ids on the same sides.
    expect(frame).toEqual(real);
  });

  it('the frame carries the node\'s name as its title', () => {
    handlesOf([fallbackNode(card('characterNode', 'character'))]);
    expect(document.querySelector('.card-fallback .node-card-boundary__label')?.textContent).toBe('characterNode name');
  });
});

describe('the sizes by type', () => {
  const read = (file: string) => readFileSync(join(__dirname, '../src/styles', file), 'utf8');
  const ruleOf = (css: string, cls: string) => {
    const match = new RegExp(`(?:^|\\n)(?:body\\.app-slava-restraint )?\\.${cls} \\{([^}]*)\\}`).exec(css);
    return match?.[1] ?? '';
  };
  const width = (css: string, cls: string) => Number(/(?:^|\s)width:\s*(\d+)px/.exec(ruleOf(css, cls))?.[1]);
  const WIDTHS: Array<[type: string, file: string, cls: string]> = [
    ['characterNode', 'character-node.css', 'character-node'],
    ['moodboardNode', 'moodboard-node.css', 'moodboard-node'],
    ['referenceSetNode', 'reference-set-node.css', 'reference-set-node'],
    ['cameraRigNode', 'camera-rig-node.css', 'camera-rig-node'],
    ['cinemaSceneNode', 'cinema-node.css', 'cinema-scene-node'],
    ['paperSourceNode', 'paper-source-node.css', 'paper-source-node'],
    ['batchNode', 'batch-node.css', 'batch-node'],
    ['editNode', 'slava-restraint.css', 'edit-node'],
    ['remotionNode', 'remotion-node.css', 'remotion-node'],
  ];

  it.each(WIDTHS)('%s is as wide as its card', (type, file, cls) => {
    expect(FALLBACK_SIZE_BY_TYPE[type].width).toBe(width(read(file), cls));
  });

  it('the Dynamic card starts at the model card\'s minimum width, and the Model card (a finished card with a result) at its widest', () => {
    const nodes = read('nodes.css');
    expect(Number(/min-width:\s*(\d+)px/.exec(ruleOf(nodes, 'model-node'))?.[1])).toBe(FALLBACK_SIZE_BY_TYPE['dynamic-node'].width);
    expect(Number(/\.model-node\.model-node--switchable \{ max-width: (\d+)px; \}/.exec(nodes)?.[1])).toBe(FALLBACK_SIZE_BY_TYPE['model-node'].width);
  });

  it('the Remotion card imports its own stylesheet, so it is styled before the editor has ever been opened', () => {
    const card = readFileSync(join(__dirname, '../src/components/nodes/RemotionNode.tsx'), 'utf8');
    expect(card).toMatch(/import '\.\.\/\.\.\/styles\/remotion-node\.css';/);
    expect(read('remotion-editor.css')).not.toMatch(/\.remotion-node\b/);
  });

  it('every deferred card type has a size', () => {
    for (const type of Object.keys(CARD_CHUNK_BY_TYPE)) expect(FALLBACK_SIZE_BY_TYPE[type], type).toBeDefined();
  });
});

describe('fallbackNode', () => {
  it('keeps id, position and selection, changes only the type, and leaves the store node alone', () => {
    const node: Node = { ...card('characterNode', 'character'), selected: true, position: { x: 12, y: 34 } };
    const data = node.data;
    const copy = fallbackNode(node);
    expect(copy).toMatchObject({ id: 'characterNode', type: CARD_FALLBACK_TYPE, selected: true, position: { x: 12, y: 34 } });
    expect(node.type).toBe('characterNode');
    expect(node.data).toBe(data);
    expect(HELD_CARD in (node.data as object)).toBe(false);
    expect(heldCardOf(copy.data)).toEqual({ type: 'characterNode', size: null });
    // The same object while the node is the same.
    expect(fallbackNode(node)).toBe(copy);
  });

  it('uses the node\'s own size when it has one, else its type\'s usual', () => {
    expect(fallbackSize(heldCardOf(fallbackNode({ ...card('batchNode', 'batch'), measured: { width: 301, height: 99 } }).data))).toEqual({ width: 301, height: 99 });
    expect(fallbackSize(heldCardOf(fallbackNode(card('batchNode', 'batch')).data))).toEqual(FALLBACK_SIZE_BY_TYPE.batchNode);
  });
});
