import { getBezierPath, Position, type Node, type useStoreApi } from '@xyflow/react';
import type { NodeData } from '../types';
import { chainPoint, resolveAnchor, restPoints, type AnchorLookup, type Point } from './agentCursorMotion';
import { area, intersect, type AnchorResolver, type Box, type Resolution } from './agentAnchorResolve';
import { watchBoardView } from './agentBoardView';
import { surfaceOf } from './agentLauncherDots';
import type { CursorLayer } from './agentCursorLayerOf';
import type { AgentCursorAnchor } from './wsClient';

/**
 * Everything the cursor view and its layout need from the surface it is
 * drawn on (Phase 3, "Anywhere"): the coordinate space the cursor's
 * transform is written in, where an anchor sits in it, the viewport, and
 * what the cards hold. The canvas layer's space is React Flow's (flow
 * coordinates, the store's transform); a screen layer's is client pixels at
 * zoom 1. The view and the field (components/canvas/AgentCursorLayer.tsx)
 * read the surface only through this, so they run unchanged on either.
 *
 * Lives in the cursor chunk (lib/deferredChunks.ts DEFERRED_MODULES).
 */

/** A node as the cursor reads it. */
export interface CursorNodeInfo {
  /** Where it is drawn, in the space's coordinates (null while unknown). */
  at: Point | null;
  /** The person is dragging it right now. */
  dragging: boolean;
  /** Its own position (a node's parent-relative `position`), for telling a
   *  person's move from an agent's (lib/personNodeMoves). */
  position?: Point;
  /** Its data: card title, params (the say lines and the type field read it). */
  data: unknown;
}

/** The node lookup as the say lines read it: each node's card title. */
export type CursorLabels = ReadonlyMap<string, { data?: { label?: unknown } } | undefined>;

export interface CursorSpace {
  /** Which layer this space is (the hand-off writes and reads by it). */
  readonly layer: CursorLayer;
  /** The space's zoom: screen px per unit. undefined until the view exists. */
  zoom(): number | undefined;
  /** The element whose box is the visible surface (its rect is cached by the
   *  field and read again when `viewKey` changes or the surface resizes). */
  pane(): Element | null;
  /** A value that changes whenever the view moves (pan or zoom). */
  viewKey(): unknown;
  /** Called on any change to the nodes or the view. Returns its unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Where an anchor sits in this space now, or null if it isn't drawn.
   *  `owner` is the cursor asking (its key): what a screen space remembers
   *  of the last read is kept per cursor, so each rides or flies on its own. */
  resolve(anchor: AgentCursorAnchor, owner?: string): Point | null;
  /** The cursor `owner` is gone (exited, or its view unmounted): drop what
   *  was remembered for it. Absent on a space that remembers nothing. */
  forget?(owner: string): void;
  /** The point a cursor counts as for its target chain (see chainPoint). */
  chainPoint(anchor: AgentCursorAnchor, owner?: string): Point | null;
  /** Where a cursor on a node is drawn while that node's header shows a wait
   *  ("Waiting for your OK", PR #212): the header's left end, so it doesn't
   *  cover the words. It still counts for its chain at chainPoint. Null if the
   *  node isn't drawn. Absent on a space with no node headers. */
  waitRest?(anchor: AgentCursorAnchor): Point | null;
  nodeInfo(id: string): CursorNodeInfo | undefined;
  labels(): CursorLabels;
  /** A client-pixel point (inside `box`, the pane's rect) in this space, or
   *  null while there is no view. */
  fromClient(client: Point, box: DOMRect): Point | null;
  /** The inverse: a point in this space as client px, at the view as it is
   *  now (a zoom in progress included), or null while there is no view. */
  toClient(point: Point, box: DOMRect): Point | null;
  /** `p` moved to whole device pixels on screen, in this space. */
  snap(p: Point, box: DOMRect, dpr: number): Point;
  /** The anchor resolved to the same element as the last frame, so a move of
   *  its spot is the item's own (a scroll, a resize), not a new place to fly
   *  to: a resting cursor rides it. Absent on a surface with no such moves
   *  (the canvas has the person's drags instead: `nodeInfo`). */
  carried?(anchor: AgentCursorAnchor, owner?: string): boolean;
  /** Where the item is, in client px, when the cursor is parked at the edge
   *  of its panel because the item is scrolled or panned out of view (the
   *  chevron points there); null otherwise. Absent on a surface with none. */
  edgeToward?(anchor: AgentCursorAnchor, owner?: string): Point | null;
  /** The panel box (client px) a parked cursor's pills must stay inside:
   *  the clip it is parked at the edge of; null when it isn't parked. */
  labelClip?(anchor: AgentCursorAnchor, owner?: string): { left: number; top: number; right: number; bottom: number } | null;
  /** The drag wire's path from a port to the free end; absent on a surface
   *  with no wires. */
  wire?(from: Point, to: Point): string;
}

type FlowStoreApi = ReturnType<typeof useStoreApi<Node<NodeData>>>;

/** The canvas's space: React Flow's flow coordinates over its store. */
export function canvasSpace(store: FlowStoreApi): CursorSpace {
  const lookup = () => store.getState().nodeLookup as unknown as AnchorLookup;
  return {
    layer: 'canvas',
    zoom: () => store.getState().transform?.[2],
    pane: () => store.getState().domNode ?? null,
    viewKey: () => store.getState().transform,
    subscribe: (listener) => store.subscribe(() => listener()),
    resolve: (anchor) => resolveAnchor(anchor, lookup()),
    chainPoint: (anchor) => chainPoint(anchor, lookup()),
    waitRest: (anchor) => restPoints(anchor, lookup(), true,
      { dom: store.getState().domNode ?? null, zoom: store.getState().transform?.[2] ?? 1 })?.drawn ?? null,
    nodeInfo: (id) => {
      const node = store.getState().nodeLookup.get(id) as
        { internals?: { positionAbsolute?: Point }; dragging?: boolean; position?: Point; data?: unknown } | undefined;
      if (!node) return undefined;
      return { at: node.internals?.positionAbsolute ?? null, dragging: Boolean(node.dragging), position: node.position, data: node.data };
    },
    labels: () => store.getState().nodeLookup as unknown as CursorLabels,
    fromClient: (client, box) => {
      const transform = store.getState().transform;
      if (!transform) return null;
      const [tx, ty, scale] = transform;
      return { x: (client.x - box.left - tx) / scale, y: (client.y - box.top - ty) / scale };
    },
    toClient: (point, box) => {
      const transform = store.getState().transform;
      if (!transform) return null;
      const [tx, ty, scale] = transform;
      return { x: box.left + tx + point.x * scale, y: box.top + ty + point.y * scale };
    },
    snap: (p, box, dpr) => {
      const transform = store.getState().transform;
      if (!transform) return p;
      const [tx, ty, scale] = transform;
      const snap = (flow: number, origin: number, shift: number) =>
        (Math.round((origin + shift + flow * scale) * dpr) / dpr - origin - shift) / scale;
      return { x: snap(p.x, box.left, tx), y: snap(p.y, box.top, ty) };
    },
    wire: (from, to) => getBezierPath({
      sourceX: from.x, sourceY: from.y, sourcePosition: Position.Right,
      targetX: to.x, targetY: to.y, targetPosition: Position.Left,
    })[0],
  };
}

/** The point a resolution parks a cursor at, or null when there is none (the
 *  cursor then holds its last spot, GM r6). The edge park and the launcher
 *  park fly to their point like an exact item: their chevron and dot are the
 *  later slices' (the resolution's `kind` is how they tell them apart). */
export function resolutionPoint(resolution: Resolution): Point | null {
  switch (resolution.kind) {
    case 'anchor':
    case 'edge':
    case 'launcher': return resolution.point;
    default: return null;
  }
}

export interface ScreenSpaceOptions {
  resolver: AnchorResolver;
  /** An element's box in client px (the resolver's own measure). */
  measure: (element: Element) => Box | null;
  /** Which elements, besides a resolved item, can move it (ResolverEnv.watch). */
  watch?: (element: Element) => readonly Element[];
  /** The fixed box the cursors are drawn in (it fills the window). */
  pane: () => Element | null;
  /** The canvas is on screen (a canvas anchor is then the canvas layer's). */
  canvasMounted: () => boolean;
  /** The item this anchor names no longer exists (a removed image): the
   *  cursor holds its spot, GM r4. Decided by the caller; the resolver only
   *  takes it as an input. */
  gone: (anchor: AgentCursorAnchor) => boolean;
  /** What wakes a resting cursor: the page scrolled or resized, an anchor or
   *  launcher came or went, an item changed size. `notify` coalesces to one
   *  per frame. Default: the DOM's (`domEvents`). Returns its teardown. */
  events?: (notify: () => void, observe: { current: ResizeObserverLike | null }) => () => void;
}

/** What `domEvents` hands back for the space to say which elements to watch. */
export interface ResizeObserverLike {
  /** The elements whose size to watch now (what the live cursors resolved to, and what can move it). */
  watch(elements: readonly Element[]): void;
}

export interface ScreenSpace extends CursorSpace {
  /** Wake every cursor now (the canvas mounted or went, a panel opened). */
  refresh(): void;
  /** The last resolution of `anchor` (by `owner`, else by any cursor), if it was resolved. */
  resolution(anchor: AgentCursorAnchor, owner?: string): Resolution | undefined;
  /** How many reads are remembered (tests: it stays one per live cursor). */
  held(): number;
  /** The exact item's box as it is visible (inside its clip), for the item
   *  outline; null while the item isn't drawn, is clipped out, or the cursor
   *  parks at a launcher or an edge. */
  outlineOf(anchor: AgentCursorAnchor): Box | null;
  /** The surface colour of the host the item sits in (`--agent-launcher-surface`
   *  on it or an ancestor), '' when none sets one: the "+N" pill's fill. */
  surfaceOf(anchor: AgentCursorAnchor): string;
  /** The launcher `anchor` resolves to right now (read afresh, not from a
   *  frame's resolve), when the cursor parks at one: the launcher dots. */
  launcherOf(anchor: AgentCursorAnchor): { element: Element; box: Box } | null;
}

const anchorKey = (anchor: AgentCursorAnchor): string => JSON.stringify(anchor);
const ANCHORED = '[data-agent-anchor],[data-agent-launcher]';

/**
 * Wakes `notify` when the page scrolls (capture: any scroller), resizes,
 * gains or loses an anchor or a launcher, or when a watched element changes
 * size. Nothing runs per frame: a resting cursor reads rects only on these.
 */
export function domEvents(notify: () => void, observe: { current: ResizeObserverLike | null }): () => void {
  if (typeof window === 'undefined') return () => {};
  let frame: number | null = null;
  const schedule = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      notify();
    });
  };
  const touches = (nodes: NodeList) => Array.from(nodes).some((node) =>
    node instanceof Element && (node.matches(ANCHORED) || node.querySelector(ANCHORED) !== null));
  const mutations = typeof MutationObserver !== 'undefined'
    ? new MutationObserver((records) => {
      if (records.some((record) => touches(record.addedNodes) || touches(record.removedNodes))) schedule();
    })
    : null;
  mutations?.observe(document.body, { childList: true, subtree: true });
  const sizes = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
  let watched = new Set<Element>();
  observe.current = {
    watch: (elements) => {
      if (!sizes) return;
      const next = new Set(elements);
      for (const element of watched) if (!next.has(element)) sizes.unobserve(element);
      for (const element of next) if (!watched.has(element)) sizes.observe(element);
      watched = next;
    },
  };
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', schedule, { capture: true, passive: true });
  // A panel that slides or resizes with a transition moves its items with no
  // size change an observer would see: it settles on one of these.
  document.addEventListener('transitionend', schedule, { capture: true, passive: true });
  document.addEventListener('animationend', schedule, { capture: true, passive: true });
  // The Board view's camera: a card panned out of its pane has no element to observe.
  const unwatchBoard = watchBoardView(schedule);
  return () => {
    unwatchBoard();
    if (frame !== null) cancelAnimationFrame(frame);
    mutations?.disconnect();
    sizes?.disconnect();
    observe.current = null;
    window.removeEventListener('resize', schedule);
    document.removeEventListener('scroll', schedule, { capture: true });
    document.removeEventListener('transitionend', schedule, { capture: true });
    document.removeEventListener('animationend', schedule, { capture: true });
  };
}

/** The part of React Flow's store the wake reads (`useStoreApi`'s). */
export interface FlowStoreLike {
  getState(): { transform?: unknown; nodes?: unknown };
  subscribe(listener: () => void): () => void;
}

/**
 * Wakes `wake` (one call a frame at most) when the canvas viewport pans or
 * zooms or a node moves: a React Flow transform change fires no DOM event, so
 * a cursor parked at a Moodboard node on the canvas would stay behind
 * (review of PR #233, finding 1). Reads two store fields on a store change,
 * and no layout; the wake itself is the space's one re-read.
 */
export function watchFlowStore(store: FlowStoreLike, wake: () => void): () => void {
  let frame: number | null = null;
  let { transform, nodes } = store.getState();
  const off = store.subscribe(() => {
    const state = store.getState();
    if (state.transform === transform && state.nodes === nodes) return;
    ({ transform, nodes } = state);
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      wake();
    });
  });
  return () => {
    off();
    if (frame !== null) cancelAnimationFrame(frame);
  };
}

/**
 * A surface beside the canvas as a CursorSpace (Phase 3 slice 5): the whole
 * window, in client pixels at zoom 1, resolved through the DOM
 * (lib/agentAnchorResolve.ts). The cursor view and field run on it unchanged.
 *
 * Rects are read when a cursor resolves: every frame while it flies (the view
 * runs its loop then) and once on each wake while it rests. A resting cursor
 * rides its item's own move (`carried`) and flies only to a different element.
 */
export function screenSpace({ resolver, measure, watch, pane, canvasMounted, gone, events = domEvents }: ScreenSpaceOptions): ScreenSpace {
  const listeners = new Set<() => void>();
  // What each cursor last read, by the cursor (its key, and `${key}>from` for
  // a drag's start): the second of two cursors resting on one item compares
  // with its own last read, not the other's. One entry a cursor, so it never
  // outgrows the live cursors; an entry whose element left the page is dropped.
  interface Read { anchor: string; resolution: Resolution; point: Point | null; same: boolean; watched: readonly Element[] }
  const last = new Map<string, Read>();
  const observe: { current: ResizeObserverLike | null } = { current: null };
  let teardown: (() => void) | null = null;

  const notify = () => {
    resolver.invalidate();
    for (const listener of [...listeners]) listener();
  };
  const elementOf = (resolution: Resolution): Element | null => ('element' in resolution ? resolution.element : null);
  const watching = () => {
    const live = new Set<Element>();
    for (const [key, read] of [...last]) {
      const element = elementOf(read.resolution);
      if (element === null) continue;
      if (!element.isConnected) {
        last.delete(key); // a card that was replaced or a panel that closed: nothing to hold or watch
        continue;
      }
      live.add(element);
      for (const around of read.watched) if (around.isConnected) live.add(around);
    }
    observe.current?.watch([...live]);
  };
  const slot = (anchor: AgentCursorAnchor, owner?: string): string => owner ?? anchorKey(anchor);
  const read = (anchor: AgentCursorAnchor, owner?: string): Read | undefined => {
    const found = last.get(slot(anchor, owner));
    return found && found.anchor === anchorKey(anchor) ? found : undefined;
  };

  const locate = (anchor: AgentCursorAnchor): Resolution =>
    resolver.resolve(anchor, { canvasMounted: canvasMounted(), gone: gone(anchor) });
  const sameSpot = (a: Resolution | undefined, b: Resolution): boolean =>
    a !== undefined && a.kind === b.kind && 'element' in a && 'element' in b && a.element === b.element;

  return {
    layer: 'screen',
    zoom: () => 1,
    pane,
    viewKey: () => 0,
    subscribe(listener) {
      listeners.add(listener);
      teardown ??= events(notify, observe);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          teardown?.();
          teardown = null;
        }
      };
    },
    resolve(anchor, owner) {
      const resolution = locate(anchor);
      const key = slot(anchor, owner);
      const before = read(anchor, owner);
      const element = elementOf(resolution);
      // What can move the item besides its own size: found once per element, not per frame.
      const watched = element === null ? [] : before && elementOf(before.resolution) === element
        ? before.watched : watch?.(element) ?? [];
      const point = resolutionPoint(resolution);
      last.set(key, { anchor: anchorKey(anchor), resolution, point, same: sameSpot(before?.resolution, resolution), watched });
      watching();
      return point;
    },
    forget(owner) {
      const dropped = last.delete(owner);
      if (last.delete(`${owner}>from`) || dropped) watching();
    },
    // The same read as this frame's resolve: a cursor's chain is its own.
    chainPoint: (anchor, owner) => read(anchor, owner)?.point ?? resolutionPoint(locate(anchor)),
    carried: (anchor, owner) => read(anchor, owner)?.same === true,
    edgeToward: (anchor, owner) => {
      const resolution = read(anchor, owner)?.resolution;
      return resolution?.kind === 'edge' ? resolution.toward : null;
    },
    labelClip: (anchor, owner) => {
      const resolution = read(anchor, owner)?.resolution;
      if (resolution?.kind !== 'edge') return null;
      const { left, top, width, height } = resolution.clip;
      return { left, top, right: left + width, bottom: top + height };
    },
    nodeInfo: () => undefined,
    labels: () => new Map(),
    fromClient: (client) => client,
    toClient: (point) => point,
    snap: (p, _box, dpr) => ({ x: Math.round(p.x * dpr) / dpr, y: Math.round(p.y * dpr) / dpr }),
    refresh: notify,
    held: () => last.size,
    resolution: (anchor, owner) => {
      if (owner !== undefined) return read(anchor, owner)?.resolution;
      const key = anchorKey(anchor);
      for (const found of last.values()) if (found.anchor === key) return found.resolution;
      return undefined;
    },
    launcherOf(anchor) {
      const resolution = locate(anchor);
      return resolution.kind === 'launcher' ? { element: resolution.element, box: resolution.box } : null;
    },
    // Read afresh, as the launcher is: a container that resized clips the item
    // differently now, before the cursor's own frame has read it again.
    surfaceOf(anchor) {
      const resolution = locate(anchor);
      return resolution.kind === 'anchor' ? surfaceOf(resolution.element) : '';
    },
    outlineOf(anchor) {
      const resolution = locate(anchor);
      if (resolution.kind !== 'anchor') return null;
      const box = measure(resolution.element);
      if (!box) return null;
      const visible = intersect(box, resolution.clip);
      return area(visible) > 0 ? visible : null;
    },
  };
}
