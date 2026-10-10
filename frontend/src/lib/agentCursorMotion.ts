import type { InternalNode, Node } from '@xyflow/react';
import type { NodeData } from '../types';
import type { AgentCursorAnchor } from './wsClient';

/**
 * Spring motion for agent cursors, integrated per animation frame.
 *
 * Tuned under critical damping (ζ ≈ 0.69). Measured at 60 fps over a 300 px
 * move: about 6 px of overshoot and at rest in under half a second, so a
 * cursor arrives with a small, readable settle instead of an ease-out slide.
 */
export interface SpringConfig {
  stiffness: number;
  damping: number;
  mass: number;
}

export const AGENT_CURSOR_SPRING: SpringConfig = { stiffness: 300, damping: 24, mass: 1 };
/** Pulling a wire is a touch slower so the gesture reads as deliberate. */
export const AGENT_DRAG_SPRING: SpringConfig = { stiffness: 120, damping: 20, mass: 1 };

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

/** Where an anchor sits in flow coordinates right now, or null if its node isn't drawn. */
export function resolveAnchor(
  anchor: AgentCursorAnchor,
  nodeLookup: Map<string, InternalNode<Node<NodeData>>>,
): Point | null {
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
  // Into the card's header, where a person would click to pick the node. The
  // node box starts at the small category label above the card, hence 44px.
  return { x: x + width / 2, y: y + Math.min(44, height / 2) };
}
