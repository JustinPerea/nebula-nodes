import type { AgentCursorAnchor } from './wsClient';

/**
 * The shared agent-motion spring, integrated per animation frame: pins,
 * proposal ghosts, the camera and the offline spring-back run on it. The
 * cursor itself travels on its own springs (agentCursorPlanner.ts).
 *
 * Tuned under critical damping (ζ ≈ 0.69). Measured at 60 fps over a 300 px
 * move: about 6 px of overshoot and at rest in under half a second, so a
 * pin or ghost arrives with a small, readable settle instead of an ease-out slide.
 */
export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
}

/** What an anchor needs of a node: where it is drawn, how big, and where its
 *  ports sit. React Flow's InternalNode has all of it, so the canvas passes its
 *  own nodeLookup; any other surface can pass the same shape (CursorSpace,
 *  lib/agentCursorSpace.ts). */
export interface AnchorNode {
  measured?: { width?: number; height?: number };
  internals: {
    positionAbsolute: { x: number; y: number };
    handleBounds?: {
      source?: readonly AnchorHandle[] | null;
      target?: readonly AnchorHandle[] | null;
    } | null;
  };
}
export interface AnchorHandle {
  id?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}
export type AnchorLookup = ReadonlyMap<string, AnchorNode>;

export const AGENT_CURSOR_SPRING: SpringConfig = { stiffness: 300, damping: 24, mass: 1 };

export interface Point {
  x: number;
  y: number;
}

export interface SpringState extends Point {
  vx: number;
  vy: number;
}

const MAX_STEP_SECONDS = 1 / 30;
const REST_DISTANCE = 0.5;
const REST_SPEED = 2;

/** Advance one frame. Large frame gaps are split so the spring stays stable. */
export function stepSpring(state: SpringState, target: Point, dtSeconds: number, config: SpringConfig): SpringState {
  let { x, y, vx, vy } = state;
  let remaining = Math.max(0, dtSeconds);
  while (remaining > 0) {
    const dt = Math.min(remaining, MAX_STEP_SECONDS);
    const ax = (-config.stiffness * (x - target.x) - config.damping * vx) / config.mass;
    const ay = (-config.stiffness * (y - target.y) - config.damping * vy) / config.mass;
    vx += ax * dt;
    vy += ay * dt;
    x += vx * dt;
    y += vy * dt;
    remaining -= dt;
  }
  return { x, y, vx, vy };
}

export function isAtRest(state: SpringState, target: Point): boolean {
  return Math.hypot(state.x - target.x, state.y - target.y) < REST_DISTANCE
    && Math.hypot(state.vx, state.vy) < REST_SPEED;
}

/** Where an anchor sits in flow coordinates right now, or null if its node isn't drawn
 *  (or it is a surface item: no flow point). */
export function resolveAnchor(
  anchor: AgentCursorAnchor,
  nodeLookup: AnchorLookup,
): Point | null {
  // A surface item (the Moodboard panel) isn't in flow space: its own layer places it.
  if ('surface' in anchor) return null;
  if (!('nodeId' in anchor)) return { x: anchor.x, y: anchor.y };
  const node = nodeLookup.get(anchor.nodeId);
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  const width = node.measured?.width ?? 0;
  const height = node.measured?.height ?? 0;
  if (anchor.handle) {
    const bounds = node.internals.handleBounds;
    const handle = [...(bounds?.target ?? []), ...(bounds?.source ?? [])].find((h) => h.id === anchor.handle);
    if (handle) return { x: x + handle.x + handle.width / 2, y: y + handle.y + handle.height / 2 };
  }
  return nodeHeaderPoint(x, y, width, height);
}

/** The point a cursor counts as for its target chain (agentCursorLook
 *  targetChains): where it is drawn (resolveAnchor), except that a handle
 *  counts as its node's header point, as the backend counts it
 *  (agent_presence._target_point: the backend doesn't know where ports
 *  sit). One formula on both sides, so a cursor on a port can't put the tab
 *  and the backend on different points (GM - Design, #219 r62). Null if its
 *  node isn't drawn. */
export function chainPoint(
  anchor: AgentCursorAnchor,
  nodeLookup: AnchorLookup,
): Point | null {
  if (!('nodeId' in anchor) || !anchor.handle) return resolveAnchor(anchor, nodeLookup);
  const node = nodeLookup.get(anchor.nodeId);
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  return nodeHeaderPoint(x, y, node.measured?.width ?? 0, node.measured?.height ?? 0);
}

/** Where a cursor aimed at a node (no handle) points: into the card's
 *  header, where a person would click to pick the node. The node box starts
 *  at the small category label above the card, hence 44px. The backend
 *  counts the same point for its target chain (agent_presence._header_point;
 *  the shared fixture backend/tests/fixtures/cursor_chains.json). */
export function nodeHeaderPoint(x: number, y: number, width: number, height: number): Point {
  return { x: x + width / 2, y: y + Math.min(44, height / 2) };
}
