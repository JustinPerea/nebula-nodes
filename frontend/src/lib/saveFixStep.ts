import type { Edge, Node, Viewport } from '@xyflow/react';
import type { NodeData } from '../types';
import { applySlice, edgeKey, type GraphSlice, type OwnParamChange } from './canvasUndo';
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

const EMPTY_SLICE: GraphSlice = { nodes: {}, edges: {} };
/** How many versions of one node (or connection) the walk keeps measured:
 * a step's snapshot and the canvas usually share one, an edit adds one. */
const VERSIONS_KEPT = 8;

const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Whether two records hold the same values, key for key (by identity:
 * nothing inside them is read). */
function sameRecord(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let size = 0;
  for (const key in left) {
    if (!hasOwn(left, key)) continue;
    size += 1;
    if (!hasOwn(right, key) || !Object.is(left[key], right[key])) return false;
  }
  for (const key in right) if (hasOwn(right, key)) size -= 1;
  return size === 0;
}

/** Whether two nodes write the same entry in Save's file (serializeGraph
 * reads only these parts). A snapshot step copies each node and its params
 * object (createSnapshot), never the values in them, so its unchanged nodes
 * hold the canvas's own values: the same content, a new object (review 8 of
 * PR #205, limits LOW-3). */
function sameNode(a: Node<NodeData>, b: Node<NodeData>): boolean {
  return a.type === b.type && a.data?.label === b.data?.label && a.data?.definitionId === b.data?.definitionId
    && Object.is(a.position?.x, b.position?.x) && Object.is(a.position?.y, b.position?.y)
    && sameRecord(a.data?.params, b.data?.params) && sameRecord(a.data?.outputs, b.data?.outputs);
}

function sameEdge(a: Edge, b: Edge): boolean {
  return a.id === b.id && a.source === b.source && a.sourceHandle === b.sourceHandle && a.target === b.target
    && a.targetHandle === b.targetHandle && a.type === b.type && sameRecord(a.data, b.data);
}

/** A measure per id and content version: a node (or connection) is measured
 * again only when a part Save writes changed, never because a step copied
 * the object. */
function versionedMeasure<T extends object>(same: (a: T, b: T) => boolean, measure: (item: T) => ShapeMeasure) {
  const versions = new Map<string, { item: T; measure: ShapeMeasure }[]>();
  const byObject = new WeakMap<object, ShapeMeasure>();
  const measured = (key: string, item: T): ShapeMeasure => {
    const known = byObject.get(item);
    if (known) return known;
    const list = versions.get(key) ?? [];
    let found = list.find((version) => same(version.item, item))?.measure;
    if (!found) {
      found = measure(item);
      list.push({ item, measure: found });
      if (list.length > VERSIONS_KEPT) list.shift();
      versions.set(key, list);
    }
    byObject.set(item, found);
    return found;
  };
  return { measured, same };
}

/** Keys for a canvas's nodes (by id) and connections (by edgeKey, as Undo's
 * slices key them: review 8 of PR #205, limits LOW-2), each made unique by
 * its place among those with the same key, so a duplicate counts as Save's
 * file counts it. */
function keyed<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T> {
  const seen = new Map<string, number>();
  const out = new Map<string, T>();
  for (const item of items) {
    const base = keyOf(item);
    const index = seen.get(base) ?? 0;
    seen.set(base, index + 1);
    out.set(index === 0 ? base : `${base}#${index}`, item);
  }
  return out;
}

/**
 * How many Undos, newest first, bring the canvas back within Save's shape
 * limits (0 when it already fits), or null when no number of them does (GM
 * PR #205 r16 item 1; review 7 limits MEDIUM-4: the step whose Undo fixes the
 * refusal, not the newest). Each slice step is applied as Undo applies it
 * (applySlice: a removed node takes its connections, a connection comes back
 * only between two nodes on the canvas), and the canvas is measured a node
 * and a connection at a time, as Save's file holds them: a node is measured
 * once per id and content version, so a step costs only what it changed
 * (review 8 of PR #205, limits LOW-2 and LOW-3).
 */
export function undosToFitSave(nodes: Node<NodeData>[], edges: Edge[], viewport: Viewport | undefined,
  name: string | undefined, steps: readonly UndoWalkStep[]): number | null {
  const nodeMeasure = versionedMeasure<Node<NodeData>>(sameNode,
    (node) => measureShape(serializeGraph([node], []).nodes[0], 2));
  const edgeMeasure = versionedMeasure<Edge>(sameEdge,
    (edge) => measureShape(serializeGraph([], [edge]).edges[0], 2));
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
  let nodesNow = new Map<string, Node<NodeData>>();
  let edgesNow = new Map<string, Edge>();
  /** Move one kind's measure to the next canvas: only what differs from
   * the last one (an unchanged entry, the same object or the same content,
   * keeps its measure). */
  const move = <T extends object>(now: Map<string, T>, want: Map<string, T>,
    measure: { measured: (key: string, item: T) => ShapeMeasure; same: (a: T, b: T) => boolean }) => {
    const kept = new Set<string>();
    for (const [key, was] of now) {
      const next = want.get(key);
      if (next !== undefined && (next === was || measure.same(was, next))) { kept.add(key); continue; }
      add(measure.measured(key, was), -1);
    }
    for (const [key, next] of want) if (!kept.has(key)) add(measure.measured(key, next), 1);
  };
  const syncTo = (nextNodes: readonly Node<NodeData>[], nextEdges: readonly Edge[]) => {
    const wantNodes = keyed(nextNodes, (node) => node.id);
    const wantEdges = keyed(nextEdges, edgeKey);
    move(nodesNow, wantNodes, nodeMeasure);
    move(edgesNow, wantEdges, edgeMeasure);
    nodesNow = wantNodes;
    edgesNow = wantEdges;
  };
  const fits = () => {
    if (bad > 0 || count > GRAPH_MAX_VALUES) return false;
    let deepest = root.depth;
    for (const [depth, many] of depths) if (many > 0 && depth > deepest) deepest = depth;
    return deepest <= GRAPH_MAX_DEPTH;
  };

  syncTo(nodes, edges);
  if (fits()) return 0;
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (isSlice(step)) {
      const undone = applySlice([...nodesNow.values()], [...edgesNow.values()], step.before, EMPTY_SLICE);
      let undoneNodes = undone.nodes;
      if (step.params?.length) {
        const changes = new Map(step.params.map((change) => [change.nodeId, change]));
        undoneNodes = undoneNodes.map((node) => {
          const change = changes.get(node.id);
          if (!change) return node;
          const params = { ...(node.data.params ?? {}), ...change.before };
          for (const key of change.absent) delete params[key];
          return { ...node, data: { ...node.data, params } };
        });
      }
      syncTo(undoneNodes, undone.edges);
    } else {
      syncTo(step.nodes, step.edges);
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
