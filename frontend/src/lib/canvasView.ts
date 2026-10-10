import type { InternalNode, Node } from '@xyflow/react';
import type { NodeData, NodeState } from '../types';
import { apiFetch } from './backend';

export interface CanvasViewReport {
  viewport: { x: number; y: number; zoom: number };
  screen: { width: number; height: number };
  nodes: Array<{ id: string; x: number; y: number; width?: number; height?: number; state?: NodeState }>;
}

const NODE_STATES: ReadonlySet<string> = new Set(['idle', 'queued', 'executing', 'complete', 'error']);
/** Matches the backend's cap; the rest of a huge canvas is still in the graph. */
const MAX_REPORTED_NODES = 2000;

const round = (value: number) => Math.round(value * 10) / 10;

/** What the canvas looks like right now, in flow coordinates, for agents to read. */
export function buildCanvasViewReport(
  transform: [number, number, number],
  screen: { width: number; height: number },
  nodeLookup: Map<string, InternalNode<Node<NodeData>>>,
): CanvasViewReport {
  const nodes: CanvasViewReport['nodes'] = [];
  for (const node of nodeLookup.values()) {
    if (nodes.length >= MAX_REPORTED_NODES) break;
    if (node.hidden) continue;
    const { x, y } = node.internals.positionAbsolute;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const entry: CanvasViewReport['nodes'][number] = { id: node.id, x: round(x), y: round(y) };
    const width = node.measured?.width;
    const height = node.measured?.height;
    if (Number.isFinite(width) && Number.isFinite(height)) {
      entry.width = Math.round(width as number);
      entry.height = Math.round(height as number);
    }
    const state = (node.data as Partial<NodeData> | undefined)?.state;
    if (typeof state === 'string' && NODE_STATES.has(state)) entry.state = state;
    nodes.push(entry);
  }
  return {
    viewport: { x: round(transform[0]), y: round(transform[1]), zoom: Math.round(transform[2] * 1000) / 1000 },
    screen: { width: Math.round(screen.width), height: Math.round(screen.height) },
    nodes,
  };
}

export async function publishCanvasView(report: CanvasViewReport, signal?: AbortSignal): Promise<void> {
  const response = await apiFetch('/api/canvas/view', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(report),
    signal,
  });
  if (!response.ok) throw new Error(`Canvas view sync failed: HTTP ${response.status}`);
}
