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
import { canonicalBackendAssetUrls } from './backend';

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

/**
 * One of the person's own adds in this tab (round 14 of PR #114, review 13
 * M1 + M3): it owns exactly the ids that add created, never a whole-canvas
 * snapshot. Undo removes those nodes (their wires go with them) and nothing
 * else; Redo puts them back. A sync that brings the backend's nodes into the
 * tab (an empty tab's first add, a reconnect), another add racing this one,
 * or an agent's edit landing meanwhile never widens it, so Undo never sends
 * an id the add didn't make. `after` is filled from the canvas as the step is
 * undone (captureOwnAdd), so Redo brings the nodes back as they were then.
 */
export interface OwnAdd {
  kind: 'own-add';
  nodeIds: string[];
  /** Param keys the step changed on nodes it didn't add (an accepted
   * proposal's `updatedNodes`, round 15 of PR #114, review 14 M5): the
   * values before, and the keys that weren't set before. Undo puts back only
   * these keys; every other key keeps its value as the canvas has it then. */
  params?: OwnParamChange[];
  before: GraphSlice;
  after: GraphSlice;
  /** What its undo's restore removed, so Redo names them (as ForeignEdit). */
  removals?: RemovalRecord[];
  /** An accepted proposal's step (round 16 of PR #114, review 15 M5): its
   * nodes as Accept added them. Undo removes one only while nobody edited it
   * since; one an agent changed is kept, as the agent left it. */
  accepted?: Record<string, Node<NodeData>>;
}

export interface OwnParamChange {
  nodeId: string;
  before: Record<string, unknown>;
  absent: string[];
  /** What the step set each key to (an accepted proposal's value). Undo puts
   * a key back only while it still holds this: a key an agent changed since
   * is left as the agent set it (round 16 of PR #114, review 15 M5). */
  set?: Record<string, unknown>;
}

/** What an undo of an accepted proposal left alone, per node: the settings
 * that changed since Accept (a node it added and an agent then edited is
 * kept whole, named by the settings that changed). */
export interface KeptAfterAccept {
  nodeId: string;
  keys: string[];
  /** A node Accept added, kept whole because it changed since (GM, round 17:
   * named as one item). False for settings kept on a node it didn't add. */
  wholeNode: boolean;
}

/** Who made a change this tab saw arrive (round 17 of PR #114, review 16 L3;
 * GM's follow-up): an agent (its presence name, or null for an unnamed one),
 * the person in another window ("You"), or nobody this tab can name. A
 * change with no source on it counts as unknown: never guessed. */
export type ChangeSource = { kind: 'agent'; name: string | null } | { kind: 'you' } | { kind: 'unknown' };

export function isOwnAdd(entry: unknown): entry is OwnAdd {
  return Boolean(entry) && (entry as { kind?: unknown }).kind === 'own-add';
}

/** A step undone and redone by its slices (applySlice), its own inverse. */
export function isSliceStep(entry: unknown): entry is ForeignEdit | OwnAdd {
  return isForeignEdit(entry) || isOwnAdd(entry);
}

export function ownAddStep(nodeIds: Iterable<string>, params: OwnParamChange[] = [],
  accepted?: Node<NodeData>[]): OwnAdd {
  const ids = [...new Set(nodeIds)];
  return {
    kind: 'own-add',
    nodeIds: ids,
    ...(params.length > 0 ? { params } : {}),
    ...(accepted ? { accepted: Object.fromEntries(accepted.map((node) => [node.id, keep(node)])) } : {}),
    before: { nodes: Object.fromEntries(ids.map((id) => [id, null])), edges: {} },
    after: { nodes: {}, edges: {} },
  };
}

/** A dynamic add's card got its backend id: the step owns the new id now. */
export function renameOwnedNode(step: OwnAdd, from: string, to: string): void {
  step.nodeIds = step.nodeIds.map((id) => (id === from ? to : id));
  for (const slice of [step.before, step.after]) {
    if (from in slice.nodes) {
      const node = slice.nodes[from];
      delete slice.nodes[from];
      slice.nodes[to] = node ? { ...node, id: to } : node;
    }
  }
}

/** Before an own add is undone: what it owns as the canvas has it now (its
 * nodes, and the wires that touch them), so Redo brings that back. Returns
 * what an accepted proposal's undo leaves alone because it changed since
 * Accept (round 16 of PR #114, review 15 M5); empty for every other add. */
export function captureOwnAdd(step: OwnAdd, nodes: Node<NodeData>[], edges: Edge[]): KeptAfterAccept[] {
  const kept: KeptAfterAccept[] = [];
  // A node Accept added that someone edited since stays, as they left it.
  const editedSince = new Set<string>();
  for (const id of step.nodeIds) {
    const added = step.accepted?.[id];
    const node = nodes.find((candidate) => candidate.id === id);
    if (!added || !node || acceptedKey(added) === acceptedKey(node)) continue;
    editedSince.add(id);
    kept.push({ nodeId: id, keys: changedSettings(added, node), wholeNode: true });
  }
  const owned = new Set(step.nodeIds.filter((id) => !editedSince.has(id)));
  step.before = { nodes: Object.fromEntries([...owned].map((id) => [id, null])), edges: {} };
  step.after = { nodes: {}, edges: {} };
  for (const node of nodes) if (owned.has(node.id)) step.after.nodes[node.id] = keep(node);
  for (const edge of edges) {
    if (!owned.has(edge.source) && !owned.has(edge.target)) continue;
    step.before.edges[edgeKey(edge)] = null;
    step.after.edges[edgeKey(edge)] = { ...edge, selected: false };
  }
  // Param keys it changed on a node it didn't add: the node as it is now,
  // with only those keys put back (a key that wasn't set is unset again),
  // and only while each still holds what the step set.
  for (const change of step.params ?? []) {
    const node = nodes.find((candidate) => candidate.id === change.nodeId);
    if (!node || step.nodeIds.includes(node.id)) continue;
    const current = node.data.params ?? {};
    const stillSet = (key: string) => !change.set || sameValue(current[key], change.set[key]);
    const restore = Object.keys(change.before).filter(stillSet);
    const unset = change.absent.filter(stillSet);
    const changed = [...Object.keys(change.before), ...change.absent].filter((key) => !stillSet(key));
    if (changed.length > 0) kept.push({ nodeId: node.id, keys: changed, wholeNode: false });
    if (restore.length === 0 && unset.length === 0) continue;
    const now = keep(node);
    const params: Record<string, unknown> = { ...node.data.params };
    for (const key of restore) params[key] = change.before[key];
    for (const key of unset) delete params[key];
    step.before.nodes[node.id] = { ...now, data: { ...now.data, params } };
    step.after.nodes[node.id] = now;
  }
  return kept;
}

/** Whether a captured own add would change nothing on undo (an accepted
 * proposal whose every change was changed again since). */
export function ownAddIsEmpty(step: OwnAdd): boolean {
  return Object.keys(step.before.nodes).length === 0 && Object.keys(step.before.edges).length === 0
    && Object.keys(step.after.nodes).length === 0;
}

/** The settings (param keys, and the name as "label") that differ. */
function changedSettings(was: Node<NodeData>, now: Node<NodeData>): string[] {
  const before = authoredParams(was);
  const after = authoredParams(now);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((key) => !sameValue(before[key], after[key]));
  if (was.data.label !== now.data.label) keys.unshift('label');
  return keys;
}

/** Two values the same as saved JSON (key order ignored), with this
 * backend's asset links compared as the backend gave them (round 17 of PR
 * #114, review 16 M2): the canvas shows them absolute (a sync's
 * rewriteBackendAssetUrls), an Accept reply sends them relative, and both
 * name the same file. */
export function sameValue(a: unknown, b: unknown): boolean {
  return stableJson(canonicalBackendAssetUrls(a)) === stableJson(canonicalBackendAssetUrls(b));
}

/** An accepted node's authoring (name and params), asset links canonical. */
function acceptedKey(node: Node<NodeData>): string {
  return stableJson(canonicalBackendAssetUrls({ definitionId: node.data.definitionId, label: node.data.label,
    params: authoredParams(node) }));
}

/**
 * A run's own param write-back reached the canvas (a sync with `runParams`,
 * round 17 of PR #114, review 16 L3): those values are the run's output,
 * nobody's edit. An accepted proposal's step takes them as what Accept left,
 * so Undo still puts its keys back and still removes a node it added.
 */
export function rebaseAcceptedOnRunOutput(step: OwnAdd, before: Node<NodeData>, after: Node<NodeData>): void {
  const was = before.data.params ?? {};
  const now = after.data.params ?? {};
  const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((key) => !sameValue(was[key], now[key]));
  if (keys.length === 0) return;
  const added = step.accepted?.[after.id];
  if (added) {
    const params: Record<string, unknown> = { ...added.data.params };
    for (const key of keys) {
      if (key in now) params[key] = now[key]; else delete params[key];
    }
    step.accepted![after.id] = { ...added, data: { ...added.data, params } };
  }
  for (const change of step.params ?? []) {
    if (change.nodeId !== after.id || !change.set) continue;
    for (const key of keys) if (key in change.set) change.set[key] = now[key];
  }
}

/**
 * What the canvas says when Undo of an accepted proposal left changes made
 * after Accept (GM - Design, rounds 16 and 17 of PR #114, verbatim; the
 * forms GM didn't word are marked).
 *
 * `kept`: per node, the settings that changed, and whether it is a node the
 * proposal added, kept whole (named as one item: "except “<node>”"). `source`:
 * who changed them all; any mix, or a change with no known source, drops the
 * actor (GM: "Never guess "An agent"").
 *
 * - One node, 1-3 settings: named, "for “<node>”" (that form only when they
 *   are all on one node). Nothing undone says the same names.
 * - One kept node, something else undone: "Undid the proposal except
 *   “<node>”. <who> changed it after you accepted."
 * - Otherwise counted: "<N> settings <agent> changed" (settings only),
 *   "<N> changes <agent> made" (kept nodes in the count); with nothing
 *   undone, "every setting in the proposal".
 * - "You": the person's other window, "… in another window after you
 *   accepted." Unknown: "Undid the proposal except <N> changes made after you
 *   accepted." / "Nothing was undone. “<s>” for “<node>” was changed after you
 *   accepted."
 */
export function acceptUndoLine(kept: { node: string; settings: string[]; wholeNode?: boolean }[],
  source: ChangeSource, nothingUndone: boolean): string {
  const total = kept.reduce((count, item) => count + (item.wholeNode && !nothingUndone ? 1 : item.settings.length), 0);
  const one = kept.length === 1 ? kept[0] : null;
  const quote = (text: string) => `\u201c${text}\u201d`;
  const names = (settings: string[]) => {
    const quoted = settings.map(quote);
    return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
  };
  const agent = source.kind === 'agent' ? source.name ?? 'An agent' : null;
  const agentInner = source.kind === 'agent' ? source.name ?? 'an agent' : null;
  const where = source.kind === 'you' ? ' in another window' : '';
  const lead = agent ?? 'You';
  // One node whose 1-3 settings are named ("for “<node>”").
  const named = one && one.settings.length >= 1 && one.settings.length <= 3 && (nothingUndone || !one.wholeNode);
  if (nothingUndone) {
    if (named) {
      if (source.kind === 'unknown') {
        return `Nothing was undone. ${names(one.settings)} for ${quote(one.node)} ${one.settings.length === 1 ? 'was' : 'were'} changed after you accepted.`;
      }
      return `Nothing was undone. ${lead} changed ${names(one.settings)} for ${quote(one.node)}${where} after you accepted.`;
    }
    // Builder's forms for "You" and unknown (GM worded the agent's).
    if (source.kind === 'unknown') return 'Nothing was undone. Every setting in the proposal was changed after you accepted.';
    return `Nothing was undone. ${lead} changed every setting in the proposal${where} after you accepted.`;
  }
  if (source.kind === 'unknown') {
    return `Undid the proposal except ${total} ${total === 1 ? 'change' : 'changes'} made after you accepted.`;
  }
  if (one?.wholeNode) {
    return `Undid the proposal except ${quote(one.node)}. ${lead} changed it${where} after you accepted.`;
  }
  if (named) {
    return `Undid the proposal except ${names(one.settings)} for ${quote(one.node)}. ${lead} changed ${one.settings.length === 1 ? 'it' : 'them'}${where} after you accepted.`;
  }
  const who = agentInner ?? 'you';
  if (kept.some((item) => item.wholeNode)) {
    return `Undid the proposal except ${total} changes ${who} made${where} after you accepted.`;
  }
  return `Undid the proposal except ${total} settings ${who} changed${where} after you accepted.`;
}

/** GM's lines (round 16 follow-up, round 17) for a rename draft dropped on
 * reconnect because the node was renamed while Nebula was offline, by who
 * renamed it: an agent, the person in another window, or unknown. */
export function droppedRenameLine(source: ChangeSource, newName: string, draft: string): string {
  if (source.kind === 'you') {
    return `You renamed this node \u201c${newName}\u201d in another window while Nebula was offline, so your rename to \u201c${draft}\u201d here wasn't saved.`;
  }
  if (source.kind === 'unknown') {
    return `This node was renamed \u201c${newName}\u201d while Nebula was offline, so your rename to \u201c${draft}\u201d wasn't saved.`;
  }
  return `${source.name ?? 'An agent'} renamed this node \u201c${newName}\u201d while Nebula was offline, so your rename to \u201c${draft}\u201d wasn't saved.`;
}

/** The param keys `updated` sets to a value other than `was` has, with the
 * values `was` had (an accepted proposal's updates against the canvas before
 * Accept). Null when nothing changed. */
export function paramChange(was: Node<NodeData>, updated: Node<NodeData>): OwnParamChange | null {
  const before: Record<string, unknown> = {};
  const absent: string[] = [];
  const set: Record<string, unknown> = {};
  const old = was.data.params ?? {};
  for (const [key, value] of Object.entries(updated.data.params ?? {})) {
    if (stableJson(old[key]) === stableJson(value)) continue;
    if (Object.prototype.hasOwnProperty.call(old, key)) before[key] = old[key];
    else absent.push(key);
    set[key] = value;
  }
  return Object.keys(before).length > 0 || absent.length > 0 ? { nodeId: was.id, before, absent, set } : null;
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

// -- a finished arrange -----------------------------------------------------------

type Point = { x: number; y: number };

/** A whole-canvas undo snapshot (graphStore's UndoSnapshot). */
interface CanvasSnapshot {
  nodes: Node<NodeData>[];
  edges: Edge[];
}

function addedBy(entry: ForeignEdit | OwnAdd | CanvasSnapshot, id: string): entry is ForeignEdit {
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
  history: Array<ForeignEdit | OwnAdd | CanvasSnapshot>,
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
    if (isSliceStep(entry)) {
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
