/**
 * An agent's placeholder on every kind of card (Q125 item 3). GM - Design,
 * 2026-10-25, verbatim: "The placeholder line “Codex is setting this up.” on
 * EVERY node type that has a preview area or body: Edit, Remotion,
 * Character, CinemaScene, Moodboard, VideoQc, PaperSource, Batch, Reroute,
 * CameraRig, ReferenceSet and any other." A Reroute is a bare connector dot
 * with no body: its line hangs below the dot, as its run error does.
 *
 * Renders the canvas's own node types (components/canvasTypes.ts), so a new
 * card type without the line fails here.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react';
import type { NodeData } from '../src/types';

vi.mock('../src/lib/wsClient', () => ({ wsClient: {
  connect: vi.fn(), disconnect: vi.fn(), send: vi.fn(), subscribe: vi.fn(() => () => {}),
} }));
const api = vi.hoisted(() => ({ lookupStoredAsset: vi.fn() }));
vi.mock('../src/lib/api', async (importOriginal) => ({ ...await importOriginal<object>(), lookupStoredAsset: api.lookupStoredAsset }));

import { CANVAS_EDGE_TYPES, CANVAS_NODE_TYPES } from '../src/components/canvasTypes';
import { useGraphStore } from '../src/store/graphStore';
import { useUIStore } from '../src/store/uiStore';
import { useStoredAssetsStore } from '../src/store/storedAssetsStore';

class NoResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoResizeObserver as unknown as typeof ResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };

const CODEX = { agent: { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: true }, at: 1 };

/** One card of each type the canvas draws, by React Flow type. */
const CARDS: Array<[type: string, definitionId: string, params?: Record<string, unknown>]> = [
  ['model-node', 'text-input', { value: 'a cat' }],
  ['dynamic-node', 'dynamic-test'],
  ['editNode', 'video-edit'],
  ['remotionNode', 'remotion-node'],
  ['cinemaSceneNode', 'cinema-scene'],
  ['characterNode', 'character', { character: 'c1' }],
  ['cameraRigNode', 'camera-rig'],
  ['referenceSetNode', 'reference-set'],
  ['moodboardNode', 'nebula-moodboard', { moodboard: 'b1' }],
  ['videoQcNode', 'qc-frame-review'],
  ['paperSourceNode', 'paper-source'],
  ['batchNode', 'batch', { items_text: 'one\ntwo' }],
  ['reroute-node', 'reroute'],
];

function card(type: string, definitionId: string, params: Record<string, unknown> = {}): Node<NodeData> {
  const dynamic = type === 'dynamic-node' ? {
    isDynamic: true,
    dynamicInputPorts: [{ id: 'prompt', label: 'Prompt', dataType: 'Text', required: false }],
    dynamicOutputPorts: [{ id: 'image', label: 'Image', dataType: 'Image' }],
  } : {};
  return { id: type, type, position: { x: 0, y: 0 },
    data: { definitionId, label: type, params, state: 'idle', outputs: {}, pending: CODEX, ...dynamic } as unknown as NodeData };
}

function renderCards() {
  useGraphStore.setState({ nodes: CARDS.map(([type, definitionId, params]) => card(type, definitionId, params)), edges: [] });
  function Flow() {
    const nodes = useGraphStore((s) => s.nodes);
    return (
      <div style={{ width: 1200, height: 800 }}>
        <ReactFlow nodes={nodes} edges={[]} nodeTypes={CANVAS_NODE_TYPES} edgeTypes={CANVAS_EDGE_TYPES} />
      </div>
    );
  }
  return render(<ReactFlowProvider><Flow /></ReactFlowProvider>);
}

function cardEl(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`);
  if (!element) throw new Error(`no card ${id}`);
  return element;
}

beforeEach(() => {
  api.lookupStoredAsset.mockReset().mockResolvedValue({ status: 'missing' });
  useStoredAssetsStore.setState({ entries: {
    'moodboard:b1': { status: 'ready', summary: { id: 'b1', name: 'Dusk', thumbnail: '/api/outputs/b1.png', imageCount: 3, mode: 'look' } },
    'character:c1': { status: 'ready', summary: { id: 'c1', name: 'Mara', thumbnail: '/api/outputs/c1.png' } },
  } });
  useUIStore.setState({ skin: 'slava-restraint', selectedNodeId: null, canvasZoomedOut: false });
});
afterEach(cleanup);

describe('the placeholder line on every card', () => {
  for (const [type] of CARDS) {
    it(`${type} says whose placeholder it is, inside its card, and marks the card pending`, () => {
      renderCards();
      const element = cardEl(type);
      const line = element.querySelector<HTMLElement>('.model-node__pending');
      expect(line?.textContent).toBe('Codex is setting this up.');
      expect(line?.style.getPropertyValue('--pending-color')).toBe('#F2C14E');
      // The card's own root holds it (not a sibling under the card), and says it is pending.
      const root = element.firstElementChild as HTMLElement;
      expect(root.contains(line)).toBe(true);
      expect(root.getAttribute('data-pending')).toBe('true');
    });
  }

  it('a Reroute (a bare connector, no body) hangs its line below the dot, as its run error does', () => {
    renderCards();
    expect(cardEl('reroute-node').querySelector('.model-node__pending')?.classList.contains('reroute-node__pending')).toBe(true);
  });

  it('a normal card has neither', () => {
    useGraphStore.setState({ nodes: [{ ...card('editNode', 'video-edit'), data: { ...card('editNode', 'video-edit').data, pending: undefined } }] });
    function Flow() {
      const nodes = useGraphStore((s) => s.nodes);
      return <div style={{ width: 800, height: 600 }}><ReactFlow nodes={nodes} edges={[]} nodeTypes={CANVAS_NODE_TYPES} /></div>;
    }
    render(<ReactFlowProvider><Flow /></ReactFlowProvider>);
    const element = cardEl('editNode');
    expect(element.querySelector('.model-node__pending')).toBeNull();
    expect((element.firstElementChild as HTMLElement).hasAttribute('data-pending')).toBe(false);
  });
});

// ---- the look: only the preview area dims ------------------------------------

const nodesCss = readFileSync(join(__dirname, '../src/styles/nodes.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const gatingCss = readFileSync(join(__dirname, '../src/styles/gating.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleBodies = (css: string, test: (selector: string) => boolean) => [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
  .filter(([, selector]) => selector.split(',').some((part) => test(part.trim())))
  .map(([, , body]) => body);

describe('a placeholder dims only its preview area', () => {
  it('dims each card kind\'s preview, never the whole card', () => {
    for (const preview of ['model-node__preview', 'edit-node__preview', 'character-node__thumb', 'cinema-scene-node__thumb',
      'moodboard-node__preview', 'paper-source-node__preview', 'camera-rig-node__diagram', 'reference-set-node__preview']) {
      const bodies = ruleBodies(nodesCss, (selector) => selector.includes("[data-pending='true']") && selector.endsWith(preview));
      expect(bodies.join('')).toMatch(/opacity:\s*0\.4/);
    }
  });

  it('wins over the Skipped style: the header, the text and the Skipped badge stay at full contrast', () => {
    // GM, 2026-10-25: "The placeholder rule wins over the Skipped style: dim only the preview area."
    const undim = ruleBodies(gatingCss, (selector) => selector.includes('.model-node--skipped')
      && selector.includes("[data-pending='true']") && selector.endsWith(':not(.node-skip)'));
    expect(undim.join('')).toMatch(/opacity:\s*1/);
    expect(undim.join('')).toMatch(/filter:\s*none/);
    const preview = ruleBodies(gatingCss, (selector) => selector.includes('.model-node--skipped')
      && selector.includes("[data-pending='true']") && selector.endsWith('.model-node__preview'));
    expect(preview.join('')).toMatch(/opacity:\s*0\.4/);
  });
});
