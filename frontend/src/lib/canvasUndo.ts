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
import type { RemovalRecord } from './deleteNotice';
import { cleanPending, type PendingFlag } from './pendingNodes';

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

/** `edit` on a graphSync: who made the edit and, for a canvas, which tab.
 * `id` names an agent's edit (or undo) on the backend, `undoes` the edit an
 * agent's undo reverted (backend services/canvas_undo.py). */
export interface EditOrigin {
  actor?: EditActor;
  tab?: string;
  id?: string;
  undoes?: string;
  /** The nodes the edit deleted, with the pins and proposals each delete
   * removed (lib/deleteNotice.ts), so undoing it here puts those back too. */
  removals?: unknown;
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
  /** The backend's id for this edit: Undo and Redo send it, so the journal
   * tells the agent its edit was undone, and by whom. */
  editId?: string;
  /** Set when the edit is an agent undoing its own earlier edit. */
  undoes?: string;
  /** What the edit's deletes removed (from its graphSync), or what this
   * step's last redo removed: undo names them in its restore. */
  removals?: RemovalRecord[];
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
  // The person in another tab: the backend sends `tab` only for a request
  // with this launch's person token.
  if (origin.tab) return 'window';
  return 'outside';
}

/** "Claude changed the canvas": shown when an agent's edit lands, with Undo. */
export function editArrivedText(edit: ForeignEdit): string | null {
  if (edit.source !== 'agent' || !edit.agentName) return null;
  return edit.undoes ? `${edit.agentName} undid its edit` : `${edit.agentName} changed the canvas`;
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
  'runNotes', 'outputFreshness', 'error', 'errorCategory', 'errorFriendly', 'errorPerson', 'errorProviderText', 'errorProvider', 'skipReason',
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
    if (wanted.data.definitionId !== node.data.definitionId) {
      // The id holds another model now (an import gave it out again): put the
      // old node back whole, with its own results.
      nextNodes.push(keep(wanted));
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
  /** An agent's placeholder flag as the step had it, or null for none (Q125 item 3). */
  pending?: PendingFlag | null;
}
export interface RestoreBody {
  action: 'undo' | 'redo';
  nodes: RestoreNodeBody[];
  remove: string[];
  wire: WireBody[];
  unwire: WireBody[];
  /** The edit this step undoes or redoes (ForeignEdit.editId). */
  edit?: string;
  /** The deletes this step undoes, for the nodes it brings back: the
   * backend puts their pins back and reopens their proposals that still fit. */
  removals?: RemovalRecord[];
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
    const swapped = Boolean(was) && was!.data.definitionId !== now.data.definitionId;
    if (!was || swapped) {
      // Back whole. A swapped id (it holds another model now, after an
      // import) is also listed in `remove`, so the backend swaps the two.
      if (swapped) body.remove.push(id);
      const flag = cleanPending(now.data.pending);
      body.nodes.push({ id, definitionId: now.data.definitionId, params: now.data.params, label: now.data.label,
        position: { ...now.position }, outputs: now.data.outputs ?? {}, ...(flag ? { pending: flag } : {}) });
      continue;
    }
    const item: RestoreNodeBody = { id, definitionId: now.data.definitionId };
    if (stableJson(was.data.params) !== stableJson(now.data.params)) item.params = now.data.params;
    if (was.data.label !== now.data.label) item.label = now.data.label;
    if (!samePosition(was, now)) item.position = { ...now.position };
    // A placeholder the step had (or didn't): the backend takes it from the person's restore only.
    const wasFlag = cleanPending(was.data.pending);
    const nowFlag = cleanPending(now.data.pending);
    if (stableJson(wasFlag) !== stableJson(nowFlag)) item.pending = nowFlag;
    if (item.params || item.label !== undefined || item.position || item.pending !== undefined) body.nodes.push(item);
  }
  for (const id of prevById.keys()) if (!nextById.has(id)) body.remove.push(id);
  const backendWire = (edge: Edge) => CLI_NODE_ID_RE.test(edge.source) && CLI_NODE_ID_RE.test(edge.target);
  const prevWires = prevEdges.filter(backendWire);
  const nextWires = nextEdges.filter(backendWire);
  const gone = new Set(body.remove);
  for (const edge of nextWires) {
    // A swapped node loses all its wires on the backend, so send its wires even when they look unchanged.
    const replugged = gone.has(edge.source) || gone.has(edge.target);
    if (replugged || !prevWires.some((other) => sameEdge(edge, other))) body.wire.push(wire(edge));
  }
  for (const edge of prevWires) {
    if (gone.has(edge.source) || gone.has(edge.target)) continue;
    if (!nextWires.some((other) => sameEdge(edge, other))) body.unwire.push(wire(edge));
  }
  const empty = !body.nodes.length && !body.remove.length && !body.wire.length && !body.unwire.length;
  return empty ? null : body;
}

// -- a placeholder made normal elsewhere -------------------------------------------

/**
 * Placeholders (Q125 item 3) the backend made normal since these steps were
 * taken, by something that isn't the person's undoable edit here: the
 * owning agent's `pending: false` or its run, the 10-minute idle rule, the
 * person's direct run. The steps on both stacks still hold the flag (a
 * snapshot of the person's later edit holds the whole canvas), and undoing
 * or redoing one would send it back and make the node a placeholder again.
 * Forget it in every step: `history` is every step, `ids` the nodes whose
 * flag went. A clear that is this tab's own edit's echo (the person edited
 * the placeholder) is not passed here, so undoing that edit still brings
 * the placeholder back.
 *
 * Changes the entries in place, as foldArrange does: the undo notice's
 * button and a refused restore find their step by identity.
 */
export function forgetClearedPlaceholders(
  history: Array<ForeignEdit | CanvasSnapshot>,
  ids: ReadonlySet<string>,
): void {
  if (ids.size === 0) return;
  const without = (node: Node<NodeData>): Node<NodeData> => {
    if (!ids.has(node.id) || node.data.pending === undefined) return node;
    const data = { ...node.data };
    delete data.pending;
    return { ...node, data };
  };
  for (const entry of history) {
    if (isForeignEdit(entry)) {
      for (const slice of [entry.before, entry.after]) {
        for (const id of ids) {
          const node = slice.nodes[id];
          if (node) slice.nodes[id] = without(node);
        }
      }
    } else if (entry.nodes.some((node) => ids.has(node.id) && node.data.pending !== undefined)) {
      entry.nodes = entry.nodes.map(without);
    }
  }
}

// -- a finished arrange -----------------------------------------------------------

type Point = { x: number; y: number };

/** A whole-canvas undo snapshot (graphStore's UndoSnapshot). */
interface CanvasSnapshot {
  nodes: Node<NodeData>[];
  edges: Edge[];
}

function addedBy(entry: ForeignEdit | CanvasSnapshot, id: string): entry is ForeignEdit {
  return isForeignEdit(entry) && entry.before.nodes[id] === null && Boolean(entry.after.nodes[id]);
}

/**
 * Make a finished arrange part of the agent edit that asked for it, instead
 * of a step of its own. `history` is every step, oldest first: the undo
 * stack, then the redo stack from its top down. `positions` are where the
 * arrange put the nodes, `shown` where this canvas had them before.
 *
 * The step that added the nodes (the newest foreign edit that did, on either
 * stack) gets the arranged positions in its `after`, so redoing it puts the
 * nodes there. Every later step still holds the positions the nodes had
 * before the arrange (a snapshot of the person's next edit holds the whole
 * canvas), so where one does, it gets the arranged ones too: undoing the
 * person's later edit must not put the agent's nodes back where they were.
 * With no such step (this tab opened after the edit, or the step fell off
 * the stack) only the steps it has are changed.
 *
 * Changes the entries in place: the undo notice's button and a refused
 * restore find their step by identity.
 */
export function foldArrange(
  history: Array<ForeignEdit | CanvasSnapshot>,
  positions: Record<string, Point>,
  shown: Record<string, Point | undefined>,
): void {
  const ids = Object.keys(positions);
  let start = -1;
  for (let index = history.length - 1; index >= 0 && start < 0; index -= 1) {
    if (ids.some((id) => addedBy(history[index], id))) start = index;
  }
  const adding = start >= 0 ? history[start] as ForeignEdit : null;
  // Where each node was before the arrange: as the agent's edit placed it, else as this canvas shows it.
  const was: Record<string, Point | undefined> = Object.fromEntries(ids.map((id) => {
    const placed = adding && addedBy(adding, id) ? adding.after.nodes[id] : null;
    return [id, placed ? placed.position : shown[id]];
  }));
  const arranged = (node: Node<NodeData>): Node<NodeData> => {
    const to = positions[node.id];
    const from = was[node.id];
    if (!to || !from || node.position?.x !== from.x || node.position?.y !== from.y) return node;
    return { ...node, position: { ...to } };
  };
  if (adding) {
    for (const id of ids) {
      if (addedBy(adding, id)) adding.after.nodes[id] = arranged(adding.after.nodes[id]!);
    }
  }
  for (const entry of history.slice(start + 1)) {
    if (isForeignEdit(entry)) {
      for (const slice of [entry.before, entry.after]) {
        for (const id of ids) {
          const node = slice.nodes[id];
          if (node) slice.nodes[id] = arranged(node);
        }
      }
    } else if (entry.nodes.some((node) => node.id in positions)) {
      entry.nodes = entry.nodes.map(arranged);
    }
  }
}
