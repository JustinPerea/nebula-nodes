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

/** How far into the header, from the card's left edge, the node's icon is
 *  centred (the header's left padding, 12 px, and half the 13 px icon): the
 *  fallback when the page can't be measured. */
export const HEADER_ICON_X = 18;

/** The header row's mark where a header has no icon (the Cinema scene's
 *  title row starts with a glyph, 14 px in): measured from the row's left. */
const GLYPH_X = 14;

/**
 * Where a cursor aimed at a node (no handle) is DRAWN while that node's
 * header shows the waiting label (GM - Design, PR #212 round 3, item 2): the
 * header's left end with the tip over the node's icon, so the mark and the
 * name pill never cover "Waiting for your OK", which sits on the header's
 * right. Only what is drawn moves: the point it counts as for its target
 * chain stays the header's middle (`chainPoint`, as the backend counts it),
 * the same split as a port's (drawn at the port, counted at its node's
 * header; GM r62). Null for a cursor on a handle, a point or a node not drawn.
 *
 * The spot is read from the page when it can be (`pane`: React Flow's pane,
 * `zoom`): the icon's centre, on the header's row, whichever card it is. With
 * nothing to measure it is HEADER_ICON_X in, on the header's middle row.
 */
export function waitRestPoint(
  anchor: AgentCursorAnchor,
  nodeLookup: AnchorLookup,
  pane?: { dom: HTMLElement | null; zoom: number },
): Point | null {
  if (!('nodeId' in anchor) || anchor.handle) return null;
  const node = nodeLookup.get(anchor.nodeId);
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  const measured = pane ? headerMark(pane.dom, anchor.nodeId, { x, y }, pane.zoom) : null;
  if (measured) return measured;
  const middle = nodeHeaderPoint(x, y, node.measured?.width ?? 0, node.measured?.height ?? 0);
  return { x: x + HEADER_ICON_X, y: middle.y };
}

/**
 * The two points a cursor has on a node: where it is `drawn` and where it
 * counts for its target chain. They are the same (the node's header middle)
 * unless the node's header shows a wait: then it is drawn at the header's left
 * end (waitRestPoint) and still counts at the middle (chainPoint, the
 * backend's own point). Null if the node isn't drawn.
 */
export function restPoints(
  anchor: AgentCursorAnchor,
  nodeLookup: AnchorLookup,
  waiting: boolean,
  pane?: { dom: HTMLElement | null; zoom: number },
): { drawn: Point; chain: Point } | null {
  const counted = resolveAnchor(anchor, nodeLookup);
  if (!counted) return null;
  const chain = chainPoint(anchor, nodeLookup) ?? counted;
  const drawn = waiting ? waitRestPoint(anchor, nodeLookup, pane) ?? counted : counted;
  return { drawn, chain };
}

/** A card's title row while it shows a wait. */
const WAITING_HEADS = '.model-node__header[data-waiting="true"], .cinema-scene-node__title[data-waiting="true"]';
/** Any card's title row, whichever card it is (a Character or Moodboard node
 *  has no category label above it, so its row is not 44 px down). */
const CARD_HEADS = '.model-node__header, .cinema-scene-node__title, .character-node__title, .moodboard-node__title';

/**
 * Where a cursor rests on a canvas node that is the launcher of a surface
 * item (a Character or Moodboard node; GM - Design, PR #243 round 1): the
 * icon or first glyph of the card's own title row, read from the page, so it
 * sits in the header on every kind of card and never at the output port. With
 * nothing to measure it is the wait rest's fallback.
 */
export function launcherRestPoint(
  anchor: AgentCursorAnchor,
  nodeLookup: AnchorLookup,
  pane?: { dom: HTMLElement | null; zoom: number },
): Point | null {
  if (!('nodeId' in anchor) || anchor.handle) return null;
  const node = nodeLookup.get(anchor.nodeId);
  if (!node) return null;
  const measured = pane ? headerMark(pane.dom, anchor.nodeId, node.internals.positionAbsolute, pane.zoom, CARD_HEADS) : null;
  return measured ?? waitRestPoint(anchor, nodeLookup, pane);
}

/** The centre of a header's icon (or its first glyph), in flow coordinates;
 *  null when the page has no laid-out header to read. `heads`: which title
 *  rows count (the waiting ones by default). */
function headerMark(dom: HTMLElement | null, nodeId: string, origin: Point, zoom: number, heads = WAITING_HEADS): Point | null {
  if (!dom || !(zoom > 0)) return null;
  const card = [...dom.querySelectorAll<HTMLElement>('.react-flow__node')].find((el) => el.dataset.id === nodeId);
  const head = card?.querySelector<HTMLElement>(heads);
  if (!card || !head) return null;
  const box = card.getBoundingClientRect();
  const row = head.getBoundingClientRect();
  if (box.width === 0 || row.width === 0) return null;
  const icon = head.querySelector<HTMLElement>('.model-node__type-icon')?.getBoundingClientRect();
  const cx = icon && icon.width > 0 ? icon.left + icon.width / 2 : row.left + GLYPH_X * zoom;
  const cy = icon && icon.height > 0 ? icon.top + icon.height / 2 : row.top + row.height / 2;
  return { x: origin.x + (cx - box.left) / zoom, y: origin.y + (cy - box.top) / zoom };
}

/** Where a cursor aimed at a node (no handle) points: into the card's
 *  header, where a person would click to pick the node. The node box starts
 *  at the small category label above the card, hence 44px. The backend
 *  counts the same point for its target chain (agent_presence._header_point;
 *  the shared fixture backend/tests/fixtures/cursor_chains.json). */
export function nodeHeaderPoint(x: number, y: number, width: number, height: number): Point {
  return { x: x + width / 2, y: y + Math.min(44, height / 2) };
}
