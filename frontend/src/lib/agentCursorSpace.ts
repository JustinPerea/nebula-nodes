import { getBezierPath, Position, type Node, type useStoreApi } from '@xyflow/react';
import type { NodeData } from '../types';
import { chainPoint, resolveAnchor, type AnchorLookup, type Point } from './agentCursorMotion';
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
  /** The space's zoom: screen px per unit. undefined until the view exists. */
  zoom(): number | undefined;
  /** The element whose box is the visible surface (its rect is cached by the
   *  field and read again when `viewKey` changes or the surface resizes). */
  pane(): Element | null;
  /** A value that changes whenever the view moves (pan or zoom). */
  viewKey(): unknown;
  /** Called on any change to the nodes or the view. Returns its unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** Where an anchor sits in this space now, or null if it isn't drawn. */
  resolve(anchor: AgentCursorAnchor): Point | null;
  /** The point a cursor counts as for its target chain (see chainPoint). */
  chainPoint(anchor: AgentCursorAnchor): Point | null;
  nodeInfo(id: string): CursorNodeInfo | undefined;
  labels(): CursorLabels;
  /** A client-pixel point (inside `box`, the pane's rect) in this space, or
   *  null while there is no view. */
  fromClient(client: Point, box: DOMRect): Point | null;
  /** `p` moved to whole device pixels on screen, in this space. */
  snap(p: Point, box: DOMRect, dpr: number): Point;
  /** The drag wire's path from a port to the free end; absent on a surface
   *  with no wires. */
  wire?(from: Point, to: Point): string;
}

type FlowStoreApi = ReturnType<typeof useStoreApi<Node<NodeData>>>;

/** The canvas's space: React Flow's flow coordinates over its store. */
export function canvasSpace(store: FlowStoreApi): CursorSpace {
  const lookup = () => store.getState().nodeLookup as unknown as AnchorLookup;
  return {
    zoom: () => store.getState().transform?.[2],
    pane: () => store.getState().domNode ?? null,
    viewKey: () => store.getState().transform,
    subscribe: (listener) => store.subscribe(() => listener()),
    resolve: (anchor) => resolveAnchor(anchor, lookup()),
    chainPoint: (anchor) => chainPoint(anchor, lookup()),
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
