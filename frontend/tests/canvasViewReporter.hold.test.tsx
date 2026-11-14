/**
 * The agent's view report during a whole-graph hold (PR #244, final review L2).
 * While a held graph is off the canvas React Flow's node lookup is empty, so
 * the report lists no node: that is what is on screen. What must hold is that
 * the reporter publishes again when the graph is handed over and when a frame
 * becomes a card (sizes change), so agents never keep reading the empty view.
 */
import { act, cleanup, render } from '@testing-library/react';
import { useState } from 'react';
import { applyNodeChanges, ReactFlow, ReactFlowProvider, type Node } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), disconnect: vi.fn() } }));
const view = vi.hoisted(() => ({ publish: vi.fn(async (...args: unknown[]) => { void args; }) }));
vi.mock('../src/lib/canvasView', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/lib/canvasView')>(),
  publishCanvasView: view.publish,
}));

import { CanvasViewReporter } from '../src/components/canvas/CanvasViewReporter';
import { resetBackendConnectionForTests } from '../src/lib/backendConnection';

// The frame measures 100 x 60 and the card 200 x 80. jsdom has no layout, so a wrapper is re-reported by hand (`resize()`) when its type changes, as a browser would.
const observers = new Set<MeasuringObserver>();
class MeasuringObserver {
  private readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) { observers.add(this); }
  report(target: Element) {
    const card = isCard(target);
    this.callback([{ target, contentRect: { width: card ? 200 : 100, height: card ? 80 : 60 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  observe(target: Element) { this.targets.add(target); queueMicrotask(() => this.report(target)); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); observers.delete(this); }
  resize() { for (const target of this.targets) this.report(target); }
}
const resize = () => act(() => { for (const observer of observers) observer.resize(); });
globalThis.ResizeObserver = MeasuringObserver as unknown as typeof ResizeObserver;
(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = class { m22 = 1; };
// React Flow reads a node's size from its element.
const isCard = (element: Element) => element.classList.contains('react-flow__node-card');
Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get(this: HTMLElement) { return isCard(this) ? 200 : 100; } });
Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { return isCard(this) ? 80 : 60; } });

const NODE_TYPES = { frame: () => <div />, card: () => <div /> };
const settle = (ms = 400) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
type Report = { nodes: Array<{ id: string; width?: number; height?: number }> };
const lastReport = (): Report => view.publish.mock.calls.at(-1)![0] as Report;

/** Controlled as the canvas is: React Flow's measurements come back as changes the owner applies, which is what makes `nodes` a new array. */
function Flow({ nodes: given }: { nodes: Node[] }) {
  const [nodes, setNodes] = useState(given);
  const [last, setLast] = useState(given);
  if (last !== given) { setLast(given); setNodes(given); }
  return (
    <div style={{ width: 800, height: 600 }}>
      <ReactFlow nodes={nodes} edges={[]} nodeTypes={NODE_TYPES} nodesDraggable={false}
        onNodesChange={(changes) => setNodes((current) => applyNodeChanges(changes, current))}><CanvasViewReporter /></ReactFlow>
    </div>
  );
}
const at = (type: string): Node[] => [{ id: 'a', type, position: { x: 0, y: 0 }, data: {} }];

beforeEach(() => { resetBackendConnectionForTests(); view.publish.mockClear(); });
afterEach(cleanup);

describe('the canvas view report across a hold', () => {
  it('lists no node while the graph is held, then publishes again when it is handed over, and again when a frame becomes a card', async () => {
    const { rerender } = render(<ReactFlowProvider><Flow nodes={[]} /></ReactFlowProvider>);
    await settle();
    expect(lastReport().nodes).toEqual([]);
    const sent = () => view.publish.mock.calls.length;

    // Handed over: a node drawn as a frame.
    let before = sent();
    rerender(<ReactFlowProvider><Flow nodes={at('frame')} /></ReactFlowProvider>);
    await settle();
    expect(sent()).toBeGreaterThan(before);
    expect(lastReport().nodes).toEqual([expect.objectContaining({ id: 'a', width: 100, height: 60 })]);

    // The card replaces the frame: its size changes, and so does the report.
    before = sent();
    rerender(<ReactFlowProvider><Flow nodes={at('card')} /></ReactFlowProvider>);
    resize();
    await settle();
    expect(sent()).toBeGreaterThan(before);
    expect(lastReport().nodes).toEqual([expect.objectContaining({ id: 'a', width: 200, height: 80 })]);
  });
});
