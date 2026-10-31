import type { Edge, Node, Viewport } from '@xyflow/react';
import type { NodeData } from '../types';
import type { GraphSlice, OwnParamChange } from './canvasUndo';
import {
  GRAPH_MAX_DEPTH, GRAPH_MAX_VALUES, measureShape, serializeGraph, type SaveUndoStep, type ShapeMeasure,
} from './graphFileShared';

/** One Undo step as the walk reads it: a whole-canvas snapshot (the person's
 * own edit), or the slice a step puts back (an agent's edit, an add). */
export type UndoWalkStep = { nodes: Node<NodeData>[]; edges: Edge[] } | { before: GraphSlice; params?: OwnParamChange[] };

/** What Save's shape line can offer: the newest step's owner, and the steps
 * Undo can reach, newest first (graphStore.saveUndoWalk). */
export interface SaveUndoWalk { top: SaveUndoStep; steps: UndoWalkStep[] }

const isSlice = (step: UndoWalkStep): step is { before: GraphSlice; params?: OwnParamChange[] } => 'before' in step;

/**
 * How many Undos, newest first, bring the canvas back within Save's shape
 * limits (0 when it already fits), or null when no number of them does (GM
 * PR #205 r16 item 1; review 7 limits MEDIUM-4: the step whose Undo fixes the
 * refusal, not the newest). Measured a node and a connection at a time, as
 * Save's file holds them, so each step costs only what it touches; a node
 * object measured once is never measured again.
 */
export function undosToFitSave(nodes: Node<NodeData>[], edges: Edge[], viewport: Viewport | undefined,
  name: string | undefined, steps: readonly UndoWalkStep[]): number | null {
  const measured = new WeakMap<object, ShapeMeasure>();
  const nodeMeasure = (node: Node<NodeData>) => {
    let found = measured.get(node);
    if (!found) { found = measureShape(serializeGraph([node], []).nodes[0], 2); measured.set(node, found); }
    return found;
  };
  const edgeMeasure = (edge: Edge) => {
    let found = measured.get(edge);
    if (!found) { found = measureShape(serializeGraph([], [edge]).edges[0], 2); measured.set(edge, found); }
    return found;
  };
  // The file without its nodes and connections: the root, its fields, the viewport.
  const root = measureShape({ ...serializeGraph([], [], viewport, name), version: 3 }, 0);

  let count = root.count;
  let bad = root.bad ? 1 : 0;
  const depths = new Map<number, number>();
  const add = (m: ShapeMeasure, sign: 1 | -1) => {
    count += sign * m.count;
    bad += m.bad ? sign : 0;
    depths.set(m.depth, (depths.get(m.depth) ?? 0) + sign);
  };
  const nodesNow = new Map<string, Node<NodeData>>();
  const edgesNow = new Map<string, Edge>();
  const setNode = (id: string, node: Node<NodeData> | null) => {
    const was = nodesNow.get(id);
    if (was) add(nodeMeasure(was), -1);
    if (node) { nodesNow.set(id, node); add(nodeMeasure(node), 1); } else nodesNow.delete(id);
  };
  const setEdge = (id: string, edge: Edge | null) => {
    const was = edgesNow.get(id);
    if (was) add(edgeMeasure(was), -1);
    if (edge) { edgesNow.set(id, edge); add(edgeMeasure(edge), 1); } else edgesNow.delete(id);
  };
  const fits = () => {
    if (bad > 0 || count > GRAPH_MAX_VALUES) return false;
    let deepest = root.depth;
    for (const [depth, many] of depths) if (many > 0 && depth > deepest) deepest = depth;
    return deepest <= GRAPH_MAX_DEPTH;
  };

  nodes.forEach((node) => setNode(node.id, node));
  edges.forEach((edge) => setEdge(edge.id, edge));
  if (fits()) return 0;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (isSlice(step)) {
      for (const [id, node] of Object.entries(step.before.nodes)) setNode(id, node);
      for (const [id, edge] of Object.entries(step.before.edges)) setEdge(id, edge);
      for (const change of step.params ?? []) {
        const node = nodesNow.get(change.nodeId);
        if (!node) continue;
        const params = { ...(node.data.params ?? {}), ...change.before };
        for (const key of change.absent) delete params[key];
        setNode(node.id, { ...node, data: { ...node.data, params } });
      }
    } else {
      for (const id of [...nodesNow.keys()]) setNode(id, null);
      for (const id of [...edgesNow.keys()]) setEdge(id, null);
      step.nodes.forEach((node) => setNode(node.id, node));
      step.edges.forEach((edge) => setEdge(edge.id, edge));
    }
    if (fits()) return index + 1;
  }
  return null;
}

/** The step Save's shape line offers: the newest step's owner when its Undo
 * alone fixes it; "the last N changes" when it takes N; none when no number
 * of Undos does (GM PR #205 r16 item 1). */
export function saveStepToFit(walk: SaveUndoWalk, nodes: Node<NodeData>[], edges: Edge[],
  viewport: Viewport | undefined, name: string | undefined): SaveUndoStep {
  if (walk.top.kind === 'none') return walk.top;
  const undos = undosToFitSave(nodes, edges, viewport, name, walk.steps);
  if (undos === null) return { kind: 'none' };
  return undos <= 1 ? walk.top : { kind: 'steps', count: undos };
}
