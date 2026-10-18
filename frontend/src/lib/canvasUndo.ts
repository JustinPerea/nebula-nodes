/**
 * Undo for edits this tab didn't make, and the backend half of every undo.
 *
 * The canvas undo stack (graphStore) holds two kinds of steps:
 *
 * - A snapshot (`{nodes, edges}`): the whole canvas before one of the
 *   person's own edits in this tab. Undo puts the whole canvas back.
 * - A foreign edit (`ForeignEdit`): one graph change that reached this tab
 *   as a graphSync from somewhere else: an agent (CLI, MCP, in-app chat), an
 *   outside app, or the person in another window. It holds only the nodes and
 *   wires that change touched, before and after, so undoing it leaves
 *   everything else as it is now.
 *
 * Both kinds sit on one LIFO stack, so a snapshot is only ever restored after
 * every later step (foreign ones included) has been undone, which is what
 * keeps whole-canvas snapshots correct now that agents edit too.
 *
 * Whichever kind is undone, `restoreRequest` turns "the canvas before" and
 * "the canvas after" into one POST /api/graph/restore body, so the backend
 * graph (and through it agents, other tabs and the saved project) matches
 * the canvas again. Frontend-only nodes (UUID ids) never reach the backend;
 * their undo is local, as before.
 */
import type { Edge, Node } from '@xyflow/react';
import type { CinemaSceneSpec, NodeData } from '../types';

/** Backend (cli_graph) node ids: n1, n2, ... Everything else is frontend-only. */
export const CLI_NODE_ID_RE = /^n\d+$/;
/** Ids the backend gives wires (e1, e2, ...). Optimistic canvas wires use UUIDs. */
export const BACKEND_EDGE_ID_RE = /^e\d+$/;

export interface EditActor {
  kind?: string;
  id?: string;
  name?: string;
  color?: string;
}

/** `edit` on a graphSync: who made the edit and, for a canvas, which tab. */
export interface EditOrigin {
  actor?: EditActor;
  tab?: string;
}

export interface GraphSlice {
  nodes: Record<string, Node<NodeData> | null>;
  edges: Record<string, Edge | null>;
}

export interface ForeignEdit {
  kind: 'foreign';
  /** The agent's name, or null for an outside app or another window. */
  agentName: string | null;
  agentColor?: string;
  /** Where it came from, for the notice when it is undone. */
  source: 'agent' | 'window' | 'outside';
  at: number;
  before: GraphSlice;
  after: GraphSlice;
}

export function edgeKey(edge: Pick<Edge, 'source' | 'target' | 'sourceHandle' | 'targetHandle'>): string {
  return `${edge.source}:${edge.sourceHandle ?? ''}->${edge.target}:${edge.targetHandle ?? ''}`;
}

export function isForeignEdit(entry: unknown): entry is ForeignEdit {
  return Boolean(entry) && (entry as { kind?: unknown }).kind === 'foreign';
}

/** Whether a graphSync's edit is this tab's own (an echo), so not an undo step. */
export function isOwnEcho(origin: EditOrigin | undefined, tabId: string): boolean {
  return Boolean(origin?.tab) && origin?.tab === tabId;
}

export function foreignSource(origin: EditOrigin): ForeignEdit['source'] {
  if (origin.actor?.kind === 'agent') return 'agent';
  // The person (or a canvas without the person token) in another tab.
  if (origin.tab) return 'window';
  return 'outside';
}

/** "Claude changed the canvas": shown when an agent's edit lands, with Undo. */
export function editArrivedText(edit: ForeignEdit): string | null {
  return edit.source === 'agent' && edit.agentName ? `${edit.agentName} changed the canvas` : null;
}

/** "Undid Claude's edit", "Redid an edit from another window". */
export function undoNoticeText(action: 'undo' | 'redo', edit: ForeignEdit): string {
  const verb = action === 'undo' ? 'Undid' : 'Redid';
  if (edit.source === 'agent' && edit.agentName) return `${verb} ${edit.agentName}’s edit`;
  if (edit.source === 'window') return `${verb} an edit from another window`;
  return `${verb} an edit made outside Nebula`;
}

// -- comparing nodes ----------------------------------------------------------

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

/** Params as the person authored them: without the media a run put into a
 * Cinema scene's shots, and with a Paper source reduced to which source it is. */
function authoredParams(node: Node<NodeData>): Record<string, unknown> {
  const params = node.data.params ?? {};
  if (node.data.definitionId === 'cinema-scene') {
    const scene = params.scene as CinemaSceneSpec | undefined;
    if (!scene?.shots) return params;
    return { ...params, scene: { ...scene, shots: scene.shots.map((shot) => {
      const authored: Record<string, unknown> = { ...shot };
      delete authored.output;
      delete authored.variations;
      delete authored.selectedVariation;
      return authored;
    }) } };
  }
  if (node.data.definitionId === 'paper-source') {
    const source = params._paperSource as { id?: unknown } | undefined;
    return { ...params, _paperSource: source?.id ?? null };
  }
  return params;
}

function authoringKey(node: Node<NodeData>): string {
  return stableJson({ definitionId: node.data.definitionId, label: node.data.label, params: authoredParams(node) });
}

function samePosition(a: Node<NodeData> | null | undefined, b: Node<NodeData> | null | undefined): boolean {
  return (a?.position?.x ?? null) === (b?.position?.x ?? null) && (a?.position?.y ?? null) === (b?.position?.y ?? null);
}

function sameEdge(a: Edge, b: Edge): boolean {
  return edgeKey(a) === edgeKey(b);
}

/** A copy safe to keep on the stack: structure, params and the outputs it had. */
function keep(node: Node<NodeData>): Node<NodeData> {
  return {
    ...node,
    selected: false,
    dragging: false,
    position: { ...node.position },
    data: {
      ...node.data,
      params: { ...node.data.params },
      progress: undefined,
      runStartedAt: undefined,
      streamingText: undefined,
      streamingPartials: undefined,
      streamingSvg: undefined,
    },
  };
}

/**
 * What a graphSync changed on this canvas, as one foreign undo step's slices,
 * or null when it changed nothing a person would undo. Outputs, run state and
 * node sizes are not compared: a run's results are never an undo step.
 * Positions count only for nodes the sync says it moved, or nodes it added.
 */
export function diffCanvas(
  prevNodes: Node<NodeData>[],
  prevEdges: Edge[],
  nextNodes: Node<NodeData>[],
  nextEdges: Edge[],
  moved: ReadonlySet<string> = new Set(),
): { before: GraphSlice; after: GraphSlice } | null {
  const before: GraphSlice = { nodes: {}, edges: {} };
  const after: GraphSlice = { nodes: {}, edges: {} };
  let changed = false;
  const prevById = new Map(prevNodes.map((node) => [node.id, node]));
  const nextById = new Map(nextNodes.map((node) => [node.id, node]));
  for (const id of new Set([...prevById.keys(), ...nextById.keys()])) {
    const was = prevById.get(id);
    const now = nextById.get(id);
    if (was === now) continue;
    if (was && now && authoringKey(was) === authoringKey(now)
      && (!moved.has(id) || samePosition(was, now))) continue;
    before.nodes[id] = was ? keep(was) : null;
    after.nodes[id] = now ? keep(now) : null;
    changed = true;
  }
  const prevByKey = new Map(prevEdges.map((edge) => [edgeKey(edge), edge]));
  const nextByKey = new Map(nextEdges.map((edge) => [edgeKey(edge), edge]));
  for (const key of new Set([...prevByKey.keys(), ...nextByKey.keys()])) {
    const was = prevByKey.get(key);
    const now = nextByKey.get(key);
    if (was && now) continue;
    before.edges[key] = was ? { ...was, selected: false } : null;
    after.edges[key] = now ? { ...now, selected: false } : null;
    changed = true;
  }
  return changed ? { before, after } : null;
}

/** Runtime fields a node keeps from the live canvas when an undo restores its recipe. */
export const RUNTIME_FIELDS = [
  'outputs', 'state', 'progress', 'runStartedAt', 'batchOutputs', 'batchVariants', 'batchRunId',
  'runNotes', 'outputFreshness', 'error', 'errorCategory', 'errorFriendly', 'skipReason',
  'skipGateNodeId', 'withheldPorts', 'keyStatus', 'streamingText', 'streamingPartials', 'streamingSvg',
] as const;

/**
 * Apply one side of a foreign edit to the canvas: `target` is the slice to
 * restore (`before` to undo, `after` to redo), `other` the slice it replaces.
 * A node that still exists takes the target's recipe (definition, name,
 * params) and keeps its live outputs and run state; it takes the target's
 * position only if this edit moved it. A node the target lacks is removed with
 * its wires; one the canvas lacks comes back with the outputs it had. A wire
 * comes back only if both of its nodes are on the canvas.
 */
export function applySlice(
  nodes: Node<NodeData>[],
  edges: Edge[],
  target: GraphSlice,
  other: GraphSlice,
): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const removed = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const nextNodes: Node<NodeData>[] = [];
  for (const node of nodes) {
    if (!(node.id in target.nodes)) {
      nextNodes.push(node);
      continue;
    }
    const wanted = target.nodes[node.id];
    if (wanted === null) {
      removed.add(node.id);
      continue;
    }
    const runtime = Object.fromEntries(RUNTIME_FIELDS.map((field) => [field, node.data[field]]));
    const movedHere = !samePosition(target.nodes[node.id], other.nodes[node.id]);
    nextNodes.push({
      ...node,
      type: wanted.type ?? node.type,
      position: movedHere ? { ...wanted.position } : node.position,
      data: { ...wanted.data, params: { ...wanted.data.params }, ...runtime },
    });
  }
  for (const [id, wanted] of Object.entries(target.nodes)) {
    if (wanted && !byId.has(id)) nextNodes.push(keep(wanted));
  }
  const present = new Set(nextNodes.map((node) => node.id));
  let nextEdges = edges.filter((edge) => !removed.has(edge.source) && !removed.has(edge.target)
    && target.edges[edgeKey(edge)] !== null);
  for (const [key, wanted] of Object.entries(target.edges)) {
    if (!wanted || !present.has(wanted.source) || !present.has(wanted.target)) continue;
    if (nextEdges.some((edge) => edgeKey(edge) === key)) continue;
    nextEdges = [...nextEdges, { ...wanted }];
  }
  return { nodes: nextNodes, edges: nextEdges };
}

// -- the backend half -----------------------------------------------------------

interface WireBody { source: string; sourceHandle: string; target: string; targetHandle: string }
interface RestoreNodeBody {
  id: string;
  definitionId: string;
  params?: Record<string, unknown>;
  label?: string;
  position?: { x: number; y: number };
  outputs?: Record<string, unknown>;
}
export interface RestoreBody {
  action: 'undo' | 'redo';
  nodes: RestoreNodeBody[];
  remove: string[];
  wire: WireBody[];
  unwire: WireBody[];
}

function wire(edge: Edge): WireBody {
  return { source: edge.source, sourceHandle: edge.sourceHandle ?? '', target: edge.target, targetHandle: edge.targetHandle ?? '' };
}

/**
 * The POST /api/graph/restore body that makes the backend graph match this
 * canvas after an undo or redo, or null when no backend node or wire changed.
 * Only backend nodes (n1, n2, ...) and wires between two of them count. A
 * node that is still there sends only what changed (params, name, position);
 * one that comes back sends everything, outputs included.
 */
export function restoreRequest(
  action: 'undo' | 'redo',
  prevNodes: Node<NodeData>[],
  prevEdges: Edge[],
  nextNodes: Node<NodeData>[],
  nextEdges: Edge[],
): RestoreBody | null {
  const body: RestoreBody = { action, nodes: [], remove: [], wire: [], unwire: [] };
  const prevById = new Map(prevNodes.filter((node) => CLI_NODE_ID_RE.test(node.id)).map((node) => [node.id, node]));
  const nextById = new Map(nextNodes.filter((node) => CLI_NODE_ID_RE.test(node.id)).map((node) => [node.id, node]));
  for (const [id, now] of nextById) {
    const was = prevById.get(id);
    if (was === now) continue;
    if (!was) {
      body.nodes.push({ id, definitionId: now.data.definitionId, params: now.data.params, label: now.data.label,
        position: { ...now.position }, outputs: now.data.outputs ?? {} });
      continue;
    }
    const item: RestoreNodeBody = { id, definitionId: now.data.definitionId };
    if (stableJson(was.data.params) !== stableJson(now.data.params)) item.params = now.data.params;
    if (was.data.label !== now.data.label) item.label = now.data.label;
    if (!samePosition(was, now)) item.position = { ...now.position };
    if (item.params || item.label !== undefined || item.position) body.nodes.push(item);
  }
  for (const id of prevById.keys()) if (!nextById.has(id)) body.remove.push(id);
  const backendWire = (edge: Edge) => CLI_NODE_ID_RE.test(edge.source) && CLI_NODE_ID_RE.test(edge.target);
  const prevWires = prevEdges.filter(backendWire);
  const nextWires = nextEdges.filter(backendWire);
  const gone = new Set(body.remove);
  for (const edge of nextWires) {
    if (!prevWires.some((other) => sameEdge(edge, other))) body.wire.push(wire(edge));
  }
  for (const edge of prevWires) {
    if (gone.has(edge.source) || gone.has(edge.target)) continue;
    if (!nextWires.some((other) => sameEdge(edge, other))) body.unwire.push(wire(edge));
  }
  const empty = !body.nodes.length && !body.remove.length && !body.wire.length && !body.unwire.length;
  return empty ? null : body;
}
