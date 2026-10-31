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
import { canonicalBackendAssetUrls } from './backend';
import { keepRenderingShots, settledParams } from './cinemaScene';

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
  /** Keys a run wrote into a part the step changed that can't be split from
   * it (a shot the step added and a run rendered since): Undo keeps that
   * part as the run left it and names the key (PR #198 review 1, M1). */
  runKept?: string[];
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
  /** A list Accept reordered that was reordered again since (PR #198 review
   * 2, L3): the order now is kept, named as one item ("the shot order"). */
  order?: 'shots' | 'clips';
  /** Keys kept because a run wrote into the part Accept changed (a shot it
   * added and a run rendered): nobody's edit, so the line names no one
   * (review 2, N5). */
  runKept?: string[];
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
  // with only what the step changed put back (a key that wasn't set is unset
  // again). A compound value (a Cinema scene, a clip list) goes back path by
  // path, before ⊕ (now − set) (PR #198 review 1, M1): what changed since in
  // a part the step didn't touch (a shot a run rendered, an agent's edit to
  // another shot) stays. A part changed both by the step and since stays as
  // it is now, and its key is named in the line.
  for (const change of step.params ?? []) {
    const node = nodes.find((candidate) => candidate.id === change.nodeId);
    if (!node || step.nodeIds.includes(node.id)) continue;
    const current = node.data.params ?? {};
    const params: Record<string, unknown> = { ...current };
    const changed: string[] = [];
    const runKept: string[] = [];
    const reordered = new Set<'shots' | 'clips'>();
    let undoes = false;
    for (const key of [...Object.keys(change.before), ...change.absent]) {
      const target = Object.prototype.hasOwnProperty.call(change.before, key) ? change.before[key] : ABSENT;
      const now = has(current, key) ? current[key] : ABSENT;
      const conflicts: Path[] = [];
      const orders: Path[] = [];
      // A step from before `set` was kept puts its keys back whole.
      const value = change.set
        ? merge3(has(change.set, key) ? change.set[key] : ABSENT, target, now, [key], conflicts, orders) : target;
      // Both sides reordered a list: the order now stays, named as one item
      // (the shots, the clips); any other list's order counts as its key.
      for (const path of orders) {
        const list = orderedList(node.data.definitionId, path);
        if (list) reordered.add(list); else conflicts.push(path);
      }
      if (conflicts.length > 0 || change.runKept?.includes(key)) changed.push(key);
      if (conflicts.length === 0 && change.runKept?.includes(key)) runKept.push(key);
      if (same(value, now)) continue;
      undoes = true;
      if (value === ABSENT) delete params[key]; else params[key] = value;
    }
    if (changed.length > 0) {
      kept.push({ nodeId: node.id, keys: changed, wholeNode: false, ...(runKept.length > 0 ? { runKept } : {}) });
    }
    for (const order of reordered) kept.push({ nodeId: node.id, keys: [], wholeNode: false, order });
    if (!undoes) continue;
    const now = keep(node);
    step.before.nodes[node.id] = { ...now, data: { ...now.data, params } };
    step.after.nodes[node.id] = now;
  }
  return kept;
}

// -- putting back a compound param path by path (PR #198 review 1, M1) --------

/** A key a value doesn't have, as opposed to one set to undefined or null. */
const ABSENT: unique symbol = Symbol('absent');
type Value = unknown;
/** Where in a param a value is: object keys, and an id-keyed list's ids. */
type Path = Array<string | { id: string }>;

function has(record: Record<string, unknown> | undefined, key: string): boolean {
  return Boolean(record) && Object.prototype.hasOwnProperty.call(record, key);
}

function same(a: Value, b: Value): boolean {
  if (a === ABSENT || b === ABSENT) return a === b;
  return sameValue(a, b);
}

function isRecord(value: Value): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A list of records each with its own string id (a scene's shots, an
 * editor's clips), by id; null for any other value. */
function byId(value: Value): Map<string, Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const found = new Map<string, Record<string, unknown>>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || found.has(item.id)) return null;
    found.set(item.id, item);
  }
  return found;
}

function child(value: Value, key: string): Value {
  return isRecord(value) && has(value, key) ? value[key] : ABSENT;
}

function keysOf(...values: Value[]): string[] {
  const keys: string[] = [];
  for (const value of values) if (isRecord(value)) for (const key of Object.keys(value)) if (!keys.includes(key)) keys.push(key);
  return keys;
}

/** An id-keyed list rebuilt from merged items: in `primary`'s order, with
 * the ids only `secondary` has placed after the item before them there. */
function ordered(primary: string[], secondary: string[], items: Map<string, Value>): Value[] {
  const ids = primary.filter((id) => items.has(id));
  secondary.forEach((id, index) => {
    if (!items.has(id) || ids.includes(id)) return;
    const after = secondary.slice(0, index).reverse().find((earlier) => ids.includes(earlier));
    ids.splice(after === undefined ? 0 : ids.indexOf(after) + 1, 0, id);
  });
  return ids.map((id) => items.get(id));
}

/**
 * `ours` with what `theirs` changed relative to `base`, at the deepest path
 * both can be read at: records by key, id-keyed lists by id. Where both
 * changed the same part, `theirs` wins and the path is noted in `conflicts`.
 * For an undo: base = what the step set, ours = what it replaced, theirs =
 * the canvas now, so the result is before ⊕ (now − set).
 */
function merge3(base: Value, ours: Value, theirs: Value, path: Path, conflicts: Path[], orders: Path[] = []): Value {
  if (same(theirs, base)) return ours;
  if (same(ours, base)) return theirs;
  if (isRecord(base) && isRecord(ours) && isRecord(theirs)) {
    const out: Record<string, unknown> = {};
    for (const key of keysOf(ours, theirs, base)) {
      const value = merge3(child(base, key), child(ours, key), child(theirs, key), [...path, key], conflicts, orders);
      if (value !== ABSENT) out[key] = value;
    }
    return out;
  }
  const [b, o, t] = [byId(base), byId(ours), byId(theirs)];
  if (b && o && t) {
    const items = new Map<string, Value>();
    for (const id of new Set([...o.keys(), ...t.keys(), ...b.keys()])) {
      const value = merge3(b.get(id) ?? ABSENT, o.get(id) ?? ABSENT, t.get(id) ?? ABSENT, [...path, { id }], conflicts, orders);
      if (value !== ABSENT) items.set(id, value);
    }
    // Their order unless they kept base's; then ours.
    const order = (map: Map<string, unknown>, other: Map<string, unknown>) => [...map.keys()].filter((id) => other.has(id));
    const reorders = (map: Map<string, unknown>) => order(map, b).join('\u0000') !== order(b, map).join('\u0000');
    const theirsReordered = reorders(t);
    // Both reordered, each its own way: theirs stays and the order is noted
    // (PR #198 review 2, L3), so Undo never uses up its step in silence.
    if (theirsReordered && reorders(o) && order(t, o).join('\u0000') !== order(o, t).join('\u0000')) orders.push(path);
    return theirsReordered ? ordered([...t.keys()], [...o.keys()], items) : ordered([...o.keys()], [...t.keys()], items);
  }
  conflicts.push(path);
  return theirs;
}

/** A shot's media in a Cinema scene: what a run writes there (the same
 * split as authoredParams and the backend's _author_cinema_scene). */
const SHOT_MEDIA = new Set(['output', 'variations', 'selectedVariation']);
function isRunMedia(definitionId: string, path: Path): boolean {
  return definitionId === 'cinema-scene' && path.length === 4 && path[0] === 'scene' && path[1] === 'shots'
    && typeof path[2] === 'object' && typeof path[3] === 'string' && SHOT_MEDIA.has(path[3]);
}
/** The list an order conflict is in, as the line names it: a Cinema scene's
 * shots or a video edit's clips; null for any other list. */
function orderedList(definitionId: string, path: Path): 'shots' | 'clips' | null {
  if (definitionId === 'cinema-scene' && path.length === 2 && path[0] === 'scene' && path[1] === 'shots') return 'shots';
  if (path.length === 1 && path[0] === 'clips') return 'clips';
  return null;
}

/** A part of a Cinema scene that holds shot media (the scene, its shots, one shot). */
function holdsRunMedia(definitionId: string, path: Path): boolean {
  return definitionId === 'cinema-scene' && path[0] === 'scene' && path.length <= 3;
}

/**
 * A run's write-back (was → now) on a key an accepted step changed (before →
 * set), at the deepest path all four can be read at. A part the step didn't
 * change needs nothing: the undo's merge keeps now there. A shot's media the
 * step changed and a run wrote since is the run's: never put back. A part
 * the step changed that a run wrote with anything else is derived from what
 * the step set (a color parsed, a clip snapped to frames): the step takes it
 * as its own, so Undo still puts the part back. A part the step changed whose
 * run write can't be split from it (a shot the step added and a run rendered)
 * is kept as the run left it, and `runKept` says so.
 */
function rebasePart(before: Value, set: Value, was: Value, now: Value, path: Path, definitionId: string,
  runKept: { value: boolean }): { before: Value; set: Value } {
  if (same(was, now) || same(before, set)) return { before, set };
  if (isRunMedia(definitionId, path)) return { before: now, set: now };
  if (isRecord(before) && isRecord(set) && isRecord(was) && isRecord(now)) {
    const nextBefore: Record<string, unknown> = { ...before };
    const nextSet: Record<string, unknown> = { ...set };
    for (const key of keysOf(was, now)) {
      const part = rebasePart(child(before, key), child(set, key), child(was, key), child(now, key), [...path, key],
        definitionId, runKept);
      if (part.before === ABSENT) delete nextBefore[key]; else nextBefore[key] = part.before;
      if (part.set === ABSENT) delete nextSet[key]; else nextSet[key] = part.set;
    }
    return { before: nextBefore, set: nextSet };
  }
  const [b, s, w, n] = [byId(before), byId(set), byId(was), byId(now)];
  if (b && s && w && n) {
    const nextBefore = new Map<string, Value>(b);
    const nextSet = new Map<string, Value>(s);
    for (const id of new Set([...w.keys(), ...n.keys()])) {
      const [itemBefore, itemSet, itemNow] = [b.get(id), s.get(id), n.get(id)];
      if (itemBefore && itemSet && itemNow && !same(itemBefore, itemSet) && !same(w.get(id) ?? ABSENT, itemNow)) {
        // An item the step changed (a clip it sped up) that a run wrote into
        // since: everything the run wrote there is derived from what the step
        // set (a duration, a frame-snapped trim), so it goes back with the
        // item (PR #198 review 2, L2). A shot's media is the exception: it
        // is the run's, and stays.
        const media = definitionId === 'cinema-scene' && path.length === 2 && path[0] === 'scene' && path[1] === 'shots';
        const back: Record<string, unknown> = { ...itemBefore };
        if (media) {
          for (const key of SHOT_MEDIA) if (has(itemNow, key)) back[key] = itemNow[key]; else delete back[key];
        }
        nextBefore.set(id, back);
        nextSet.set(id, itemNow);
        continue;
      }
      const part = rebasePart(b.get(id) ?? ABSENT, s.get(id) ?? ABSENT, w.get(id) ?? ABSENT, n.get(id) ?? ABSENT,
        [...path, { id }], definitionId, runKept);
      if (part.before === ABSENT) nextBefore.delete(id); else nextBefore.set(id, part.before);
      if (part.set === ABSENT) nextSet.delete(id); else nextSet.set(id, part.set);
    }
    return { before: ordered([...b.keys()], [...n.keys()], nextBefore), set: ordered([...s.keys()], [...n.keys()], nextSet) };
  }
  if (holdsRunMedia(definitionId, path)) {
    runKept.value = true;
    return { before: now, set: now };
  }
  return { before, set: now };
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
 * nobody's edit. Taken path by path (PR #198 review 1, M1), never as whole
 * keys, so a run's write into one part of a compound param (a shot's image)
 * never stands for the rest of it:
 * - a node Accept added takes the run's changes as what Accept left, so Undo
 *   still removes it, while an edit someone made to it since still keeps it;
 * - on a node Accept changed, see rebasePart: a run's media stays, a value
 *   derived from what Accept set still goes back with it.
 */
export function rebaseAcceptedOnRunOutput(step: OwnAdd, before: Node<NodeData>, after: Node<NodeData>): void {
  const was = before.data.params ?? {};
  const now = after.data.params ?? {};
  const keys = keysOf(was, now).filter((key) => !same(child(was, key), child(now, key)));
  if (keys.length === 0) return;
  const added = step.accepted?.[after.id];
  if (added) {
    const params: Record<string, unknown> = { ...added.data.params };
    for (const key of keys) {
      const value = merge3(child(was, key), child(params, key), child(now, key), [key], []);
      if (value === ABSENT) delete params[key]; else params[key] = value;
    }
    step.accepted![after.id] = { ...added, data: { ...added.data, params } };
  }
  const definitionId = after.data.definitionId;
  for (const change of step.params ?? []) {
    if (change.nodeId !== after.id || !change.set) continue;
    for (const key of keys) {
      const inBefore = has(change.before, key);
      if (!inBefore && !change.absent.includes(key)) continue;
      const runKept = { value: false };
      const part = rebasePart(inBefore ? change.before[key] : ABSENT, child(change.set, key), child(was, key),
        child(now, key), [key], definitionId, runKept);
      if (part.before === ABSENT) {
        delete change.before[key];
        if (!change.absent.includes(key)) change.absent.push(key);
      } else {
        change.before[key] = part.before;
        change.absent = change.absent.filter((absent) => absent !== key);
      }
      if (part.set === ABSENT) delete change.set[key]; else change.set[key] = part.set;
      if (runKept.value && !change.runKept?.includes(key)) change.runKept = [...(change.runKept ?? []), key];
    }
  }
}

/**
 * A run's own param write-back (was → now on one node) in a step that holds
 * that node (a snapshot of the person's edit, an edit from elsewhere, an
 * undone add waiting for Redo): wherever the step holds what the run
 * replaced, it takes what the run wrote, so undoing or redoing it never takes
 * a run's output off the canvas (PR #198 review 2, N3: a shot rendered
 * between Undo and Redo, a flat key a run wrote). A part the step holds
 * otherwise is the step's own and stays, whole within an id-keyed item (a
 * clip's duration goes back with the speed the step set, L2), except a
 * shot's media, which is always the run's. Changes the step in place.
 */
export function rebaseStepOnRunOutput(entry: unknown, was: Node<NodeData>, now: Node<NodeData>): void {
  const wasParams = was.data.params ?? {};
  const nowParams = now.data.params ?? {};
  const keys = keysOf(wasParams, nowParams).filter((key) => !same(child(wasParams, key), child(nowParams, key)));
  if (keys.length === 0) return;
  const definitionId = now.data.definitionId;
  const rebased = (held: Node<NodeData>): Node<NodeData> => {
    if (held.data.definitionId !== definitionId) return held;
    const params: Record<string, unknown> = { ...held.data.params };
    for (const key of keys) {
      const value = rebaseHeld(child(params, key), child(wasParams, key), child(nowParams, key), [key], definitionId);
      if (value === ABSENT) delete params[key]; else params[key] = value;
    }
    return { ...held, data: { ...held.data, params } };
  };
  if (isSliceStep(entry)) {
    for (const slice of [entry.before, entry.after]) {
      const held = slice.nodes[now.id];
      if (held) slice.nodes[now.id] = rebased(held);
    }
    return;
  }
  const snapshot = entry as { nodes?: Node<NodeData>[] };
  if (Array.isArray(snapshot.nodes) && snapshot.nodes.some((node) => node.id === now.id)) {
    snapshot.nodes = snapshot.nodes.map((node) => (node.id === now.id ? rebased(node) : node));
  }
}

function rebaseHeld(held: Value, was: Value, now: Value, path: Path, definitionId: string): Value {
  if (same(was, now)) return held;
  if (same(held, was) || isRunMedia(definitionId, path)) return now;
  if (isRecord(held) && isRecord(was) && isRecord(now)) {
    const out: Record<string, unknown> = { ...held };
    for (const key of keysOf(was, now)) {
      const value = rebaseHeld(child(held, key), child(was, key), child(now, key), [...path, key], definitionId);
      if (value === ABSENT) delete out[key]; else out[key] = value;
    }
    return out;
  }
  const [h, w, n] = [byId(held), byId(was), byId(now)];
  if (h && w && n) {
    const shots = definitionId === 'cinema-scene' && path.length === 2 && path[0] === 'scene' && path[1] === 'shots';
    return [...h.entries()].map(([id, item]) => {
      const [before, after] = [w.get(id), n.get(id)];
      if (!before || !after || same(before, after)) return item;
      if (same(item, before)) return after;
      if (!shots) return item;
      const back: Record<string, unknown> = { ...item };
      for (const key of SHOT_MEDIA) if (has(after, key)) back[key] = after[key]; else delete back[key];
      return back;
    });
  }
  return held;
}

/**
 * What the canvas says when Undo of an accepted proposal left changes made
 * after Accept (GM - Design, rounds 16, 17 and 18 of PR #114 and r1 of PR
 * #198, verbatim; the forms GM didn't word are marked).
 *
 * `kept`: per node, the settings that changed, and whether it is a node the
 * proposal added, kept whole (named as one item: "except “<node>”"). `source`:
 * who changed them all; any mix, or a change with no known source, drops the
 * actor (GM: "Never guess "An agent"").
 *
 * GM r18, "never count 1": a single item is always named. Items are the
 * settings (a rename is the setting "Name") and the kept nodes. GM pr198 r1:
 * settings are named only when they are all on one node (1-3 of them);
 * across nodes they are counted, from 2. Kept nodes alone are named 1-3 and
 * counted from 4; kept nodes and settings mixed are counted from 2. G2: the
 * count says "settings" when every counted item is a setting (on one node or
 * several), "changes" only when kept nodes and settings are mixed.
 *
 * - Named: "Undid the proposal except “<s>” for “<node>”. <Who> changed
 *   it/them after you accepted.", or the kept nodes by name ("except “Hero”
 *   and “Logo”"). Unknown: "… It was / They were changed after you
 *   accepted."
 * - Counted: "<N> settings <who> changed", "<N> nodes <who> changed", "<N>
 *   changes <who> made"; unknown drops the actor ("<N> settings changed").
 * - Nothing undone: one node's 1-3 settings named, else "every setting in the
 *   proposal".
 * - "You": the person's other window, "… in another window after you
 *   accepted."
 * - A setting with no readable name (null: a provider setting the Inspector
 *   shows only by its key) is "a setting on “<node>”" (GM, PR #198 r2 ask
 *   3); more than one setting with one of them unnamed is counted.
 * - A list both reordered (`order`, GM's follow-up for PR #198 r2 and r3
 *   items 2 and 5): "Undid the proposal except the shot order in “<scene>”.
 *   You reordered them in another window after you accepted." ("The shots
 *   were reordered after you accepted." for an unknown source), or "Nothing
 *   was undone. …" when that was all.
 * - Nothing undone with an unnamed setting (GM r3 item 7): "a setting on
 *   “<node>”", "3 settings on “<node>”", "settings on “A” and “B”", "settings
 *   on 4 nodes".
 */
export function acceptUndoLine(
  kept: { node: string; settings: (string | null)[]; wholeNode?: boolean; order?: 'shots' | 'clips' }[],
  source: ChangeSource, nothingUndone: boolean): string {
  const quote = (text: string) => `\u201c${text}\u201d`;
  const andList = (items: string[]) =>
    items.length <= 1 ? items[0] ?? '' : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  const names = (settings: (string | null)[]) => andList(settings.map((setting) => quote(setting ?? '')));
  const agent = source.kind === 'agent' ? source.name ?? 'An agent' : null;
  const agentInner = source.kind === 'agent' ? source.name ?? 'an agent' : null;
  const where = source.kind === 'you' ? ' in another window' : '';
  const lead = agent ?? 'You';
  const orders = kept.filter((item) => item.order);
  if (orders.length > 0) {
    if (orders.length === 1 && kept.length === 1) {
      const { order, node } = orders[0];
      // GM, PR #198 r3 item 5 (unknown) and item 2 ("You … them"): "Undid
      // the proposal except the shot order in “X”. The shots were reordered
      // after you accepted." / "… You reordered them in another window after
      // you accepted." "Nothing was undone." has no order to point back to,
      // so its "You" line names the list.
      const who = (pointsBack: boolean) => (source.kind === 'agent' ? `${agent} reordered the ${order} after you accepted.`
        : source.kind === 'you'
          ? `You reordered ${pointsBack ? 'them' : `the ${order}`} in another window after you accepted.`
          : `The ${order} were reordered after you accepted.`);
      if (nothingUndone) return `Nothing was undone. ${who(false)}`;
      return `Undid the proposal except the ${order === 'shots' ? 'shot' : 'clip'} order in ${quote(node)}. ${who(true)}`;
    }
    // An order kept with other changes: counted, as kept nodes and settings
    // mixed are (builder's, after GM's counted forms).
    const total = kept.reduce((count, item) => count + (item.order || item.wholeNode ? 1 : item.settings.length), 0);
    if (nothingUndone) {
      if (source.kind === 'unknown') return 'Nothing was undone. Every change in the proposal was changed again after you accepted.';
      return `Nothing was undone. ${lead} changed every setting in the proposal${where} after you accepted.`;
    }
    if (source.kind === 'unknown') return `Undid the proposal except ${total} changes made after you accepted.`;
    return `Undid the proposal except ${total} changes ${agentInner ?? 'you'} made${where} after you accepted.`;
  }
  if (nothingUndone) {
    const one = kept.length === 1 ? kept[0] : null;
    // GM, PR #198 r3 item 7: a setting with no readable name is never named.
    // One: "Nothing was undone. Codex changed a setting on “Hero still” after
    // you accepted."; several on one node: "…changed 3 settings on “Hero
    // still”…"; across nodes: "…changed settings on “A” and “B”…" or "…on 4
    // nodes…". The unknown source's forms are builder's, on GM's pattern.
    const settingsOnly = kept.every((item) => !item.order && item.settings.length > 0);
    if (settingsOnly && kept.some((item) => item.settings.includes(null))) {
      let what: string;
      let several = true;
      if (one) {
        several = one.settings.length > 1;
        what = several ? `${one.settings.length} settings on ${quote(one.node)}` : `a setting on ${quote(one.node)}`;
      } else {
        what = kept.length >= 4 ? `settings on ${kept.length} nodes` : `settings on ${andList(kept.map((item) => quote(item.node)))}`;
      }
      if (source.kind === 'unknown') {
        return `Nothing was undone. ${what[0].toUpperCase()}${what.slice(1)} ${several ? 'were' : 'was'} changed after you accepted.`;
      }
      return `Nothing was undone. ${lead} changed ${what}${where} after you accepted.`;
    }
    if (one && one.settings.length >= 1 && one.settings.length <= 3) {
      if (source.kind === 'unknown') {
        return `Nothing was undone. ${names(one.settings)} for ${quote(one.node)} ${one.settings.length === 1 ? 'was' : 'were'} changed after you accepted.`;
      }
      return `Nothing was undone. ${lead} changed ${names(one.settings)} for ${quote(one.node)}${where} after you accepted.`;
    }
    // Builder's forms for "You" and unknown (GM worded the agent's).
    if (source.kind === 'unknown') return 'Nothing was undone. Every setting in the proposal was changed after you accepted.';
    return `Nothing was undone. ${lead} changed every setting in the proposal${where} after you accepted.`;
  }
  const wholeNodes = kept.filter((item) => item.wholeNode);
  const settingNodes = kept.filter((item) => !item.wholeNode && item.settings.length > 0);
  const total = wholeNodes.length + settingNodes.reduce((count, item) => count + item.settings.length, 0);
  const mixed = wholeNodes.length > 0 && settingNodes.length > 0;
  // GM pr198 r1 (1): settings are named only when they are all on one node;
  // across nodes they are counted (from 2). (2): kept nodes alone, 1-3 named.
  // r2 ask 3: an unnamed setting is named only alone ("a setting on").
  const unnamed = settingNodes.some((item) => item.settings.includes(null));
  const named = mixed ? total < 2 : settingNodes.length > 1 ? false : unnamed ? total === 1 : total < 4;
  if (named) {
    // Named: one node's settings "for" it, or the kept nodes by their names.
    const list = settingNodes.length === 1
      ? unnamed ? `a setting on ${quote(settingNodes[0].node)}`
        : `${names(settingNodes[0].settings)} for ${quote(settingNodes[0].node)}`
      : andList(wholeNodes.map((item) => quote(item.node)));
    if (source.kind === 'unknown') {
      return `Undid the proposal except ${list}. ${total === 1 ? 'It was' : 'They were'} changed after you accepted.`;
    }
    return `Undid the proposal except ${list}. ${lead} changed ${total === 1 ? 'it' : 'them'}${where} after you accepted.`;
  }
  // Counted (GM r18 G2, pr198 r1 (1)-(3)): "settings", "nodes" (4 or more
  // kept nodes alone), or "changes" when kept nodes and settings are mixed.
  const word = mixed ? 'changes' : wholeNodes.length > 0 ? 'nodes' : 'settings';
  const verb = mixed ? 'made' : 'changed';
  if (source.kind === 'unknown') return `Undid the proposal except ${total} ${word} ${verb} after you accepted.`;
  return `Undid the proposal except ${total} ${word} ${agentInner ?? 'you'} ${verb}${where} after you accepted.`;
}

/** GM's lines (round 16 follow-up, round 17) for a rename draft dropped on
 * reconnect because the node was renamed while Nebula was offline, by who
 * renamed it: an agent, the person in another window, or unknown. */
export function droppedRenameLine(source: ChangeSource, newName: string, draft: string): string {
  if (source.kind === 'you') {
    return `You renamed this node \u201c${newName}\u201d in another window while Nebula was offline, so your rename to \u201c${draft}\u201d here wasn\u2019t saved.`;
  }
  if (source.kind === 'unknown') {
    return `This node was renamed \u201c${newName}\u201d while Nebula was offline, so your rename to \u201c${draft}\u201d wasn\u2019t saved.`;
  }
  return `${source.name ?? 'An agent'} renamed this node \u201c${newName}\u201d while Nebula was offline, so your rename to \u201c${draft}\u201d wasn\u2019t saved.`;
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

/** "Claude changed the canvas.": shown when an agent's edit lands, with
 * Undo. A sentence, so it ends with its period (GM #198 r22 note 1). */
export function editArrivedText(edit: ForeignEdit): string | null {
  if (edit.source !== 'agent' || !edit.agentName) return null;
  return edit.undoes ? `${edit.agentName} undid its edit.` : `${edit.agentName} changed the canvas.`;
}

/** "Undid Claude’s edit.", "Redid an edit from another window.": a
 * sentence, so it ends with its period (GM #198 r24 answer 2). */
export function undoNoticeText(action: 'undo' | 'redo', edit: ForeignEdit): string {
  const verb = action === 'undo' ? 'Undid' : 'Redid';
  if (edit.source === 'agent' && edit.agentName) return `${verb} ${edit.agentName}’s edit.`;
  if (edit.source === 'window') return `${verb} an edit from another window.`;
  return `${verb} an edit made outside Nebula.`;
}

// -- comparing nodes ----------------------------------------------------------

export function stableJson(value: unknown): string {
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
      // A shot's optimistic "running" never goes on the stack (review 2, M1).
      params: { ...settledParams(node.data.definitionId, node.data.params ?? {}) },
      state: node.data.state === 'executing' || node.data.state === 'queued' ? 'idle' : node.data.state,
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
      data: { ...wanted.data, params: { ...keepRenderingShots(node.data.definitionId, wanted.data.params ?? {}, node.data.params) }, ...runtime },
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
