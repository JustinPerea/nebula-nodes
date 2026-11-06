import { agentAnchor } from './agentAnchors';
import { boardView } from './agentBoardView';
import { parkReachPx } from './agentCursorPark';
import type { AgentCursorAnchor } from './wsClient';

/**
 * Where an agent cursor on a surface beside the canvas (the Moodboard panel
 * and Studio) goes, found in the DOM (Phase 3, "Anywhere"; plan section 3).
 * Pure over an injected environment, so the whole chain is tested with fake
 * rects. In the cursor chunk (lib/deferredChunks.ts DEFERRED_MODULES).
 *
 * The chain, first step that works wins:
 *  1. **The exact anchor** `data-agent-anchor`: a part that isn't drawn falls
 *     back to its item (`b/i:note` to `b/i`, `b:colors` to `b`). Among
 *     matches, one visible in its clip, then the largest visible area, then
 *     DOM order. Inside its clip the cursor aims at the item's top (its
 *     middle across, 24 px down or half its height); out of it, it parks at
 *     the clip's edge on the item's side (an edge park).
 *  2. **The board's launcher** `moodboard:<board>`: its row in the Assets
 *     dock, or its Moodboard node on the canvas, when at least half of it is
 *     visible.
 *  3. **The surface's launcher** `moodboard`: the dock's tab when the dock is
 *     open, else the rail's "Open assets".
 *  4. **The canvas launcher** `canvas` (a Studio's "Back to Canvas"), for a
 *     canvas target when no canvas is mounted.
 *  5. **Nothing:** the caller holds the cursor's last spot (GM r6).
 *
 * Steps 2 to 4 are launcher parks: the tip sits 6 px right of the launcher,
 * at its middle. Nothing here opens, scrolls or pans anything: it reads
 * rects only (tests/agentCursorNoOpen.test.ts, slice 5, scans the chunk).
 */

export interface Point { x: number; y: number }
export interface Box { left: number; top: number; width: number; height: number }

/** What the resolver reads of the page. `query` returns matches in DOM
 *  order; `measure` a viewport-px box (null: not laid out); `clip` the box an
 *  element is visible through (its overflow ancestors and the viewport). */
export interface ResolverEnv {
  query(selector: string): readonly Element[];
  measure(element: Element): Box | null;
  clip(element: Element): Box;
  /** An image card the Board view doesn't render because it is panned fully
   *  out of the pane (`onlyRenderVisibleElements`): its box in viewport px
   *  worked out from the card's position and the camera, the pane's box as
   *  its clip, and the pane as its element. null: not such a card. */
  culled?(board: string, image: string): { box: Box; clip: Box; element: Element } | null;
}

export type LauncherStep = 'board' | 'surface' | 'canvas';

export type Resolution =
  /** The exact item, visible: aim here. */
  | { kind: 'anchor'; point: Point; element: Element; clip: Box }
  /** The exact item, out of its clip: park at `point` on the clip's edge, `angle` (radians) toward it. */
  | { kind: 'edge'; point: Point; toward: Point; angle: number; element: Element; clip: Box }
  /** A launcher park: `point` is the tip, 6 px right of the launcher. */
  | { kind: 'launcher'; step: LauncherStep; point: Point; element: Element; box: Box }
  /** The item itself is gone (the caller says so): hold the last spot, or fall back to the board. */
  | { kind: 'gone' }
  /** Nothing resolves: hold the last spot, and with none, draw no cursor. */
  | { kind: 'none' };

/** How long a found element is trusted before it is looked up again. */
export const RESOLVER_REQUERY_MS = 250;
/** How far a launcher park's tip sits from its launcher, and an edge park from its clip's edge. */
export const LAUNCHER_GAP_PX = 6;
export const EDGE_INSET_PX = 12;
/** An item's aim point is its middle across and this far down at most. */
export const AIM_DOWN_PX = 24;
/** A launcher counts as visible when this much of it is. */
export const LAUNCHER_VISIBLE_SHARE = 0.5;

const RAIL = '[data-rail-item]';

export const area = ({ width, height }: Pick<Box, 'width' | 'height'>): number => Math.max(0, width) * Math.max(0, height);

export function intersect(a: Box, b: Box): Box {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Where a cursor aims at an item: across its middle, `AIM_DOWN_PX` down or half its height. */
export function aimPoint(box: Box): Point {
  return { x: box.left + box.width / 2, y: box.top + Math.min(box.height / 2, AIM_DOWN_PX) };
}

const inside = (p: Point, box: Box): boolean =>
  p.x >= box.left && p.x <= box.left + box.width && p.y >= box.top && p.y <= box.top + box.height;

/**
 * The edge park's point: `target` clamped into `clip` (inset `EDGE_INSET_PX`)
 * along the line from the clip's middle, and the angle (radians, 0 along +x)
 * from it toward the target, for the chevron. A target already inside the
 * inset clip stays where it is. A clip too small for the inset parks at its middle.
 */
export function clampToClip(target: Point, clip: Box): { point: Point; angle: number } {
  const centre = { x: clip.left + clip.width / 2, y: clip.top + clip.height / 2 };
  const dx = target.x - centre.x;
  const dy = target.y - centre.y;
  // The arrow hangs below and right of its tip and the chevron sits beyond it
  // toward the item, so the right and bottom edges inset the drawn cursor's
  // box (the whole cursor stays in view), not just the tip. The top and left
  // keep the tip itself inset. The chevron's angle is along the line from the
  // middle, which the point stays on.
  const reach = parkReachPx(Math.atan2(dy, dx));
  // The tip's room from the middle: to the right and down it is the box's, to the left and up it is the tip's.
  const roomX = dx > 0 ? Math.max(0, clip.width / 2 - EDGE_INSET_PX - reach.right) : Math.max(0, clip.width / 2 - EDGE_INSET_PX);
  const roomY = dy > 0 ? Math.max(0, clip.height / 2 - EDGE_INSET_PX - reach.down) : Math.max(0, clip.height / 2 - EDGE_INSET_PX);
  const along = Math.min(
    dx === 0 ? Infinity : roomX / Math.abs(dx),
    dy === 0 ? Infinity : roomY / Math.abs(dy),
    1,
  );
  const point = { x: centre.x + dx * along, y: centre.y + dy * along };
  return { point, angle: Math.atan2(target.y - point.y, target.x - point.x) };
}

/** The anchor values to try for a surface anchor, most exact first: a part
 *  that isn't drawn falls back to its item. */
export function anchorValues(anchor: Extract<AgentCursorAnchor, { surface: string }>): string[] {
  const [board, image] = anchor.itemId.split('/');
  const values = [agentAnchor(board, image, anchor.part)];
  if (anchor.part) values.push(agentAnchor(board, image));
  return values.filter((value): value is string => value !== undefined);
}

interface Seen {
  element: Element;
  box: Box;
  clip: Box;
  visible: Box;
}

/** Looks the chain up against `env`. Holds no state but a short-lived cache of what it found. */
export class AnchorResolver {
  private found = new Map<string, { at: number; elements: readonly Element[] }>();

  private env: ResolverEnv;
  private now: () => number;

  constructor(env: ResolverEnv, now: () => number = () => performance.now()) {
    this.env = env;
    this.now = now;
  }

  /** Forget what was found (a panel opened or closed). */
  invalidate(): void {
    this.found.clear();
  }

  private lookup(selector: string): readonly Element[] {
    const now = this.now();
    const kept = this.found.get(selector);
    // The elements are kept while they stay in the page, and re-queried
    // when one left or after RESOLVER_REQUERY_MS: a panel can mount another.
    if (kept && now - kept.at < RESOLVER_REQUERY_MS && kept.elements.every((element) => element.isConnected)) {
      return kept.elements;
    }
    const elements = this.env.query(selector);
    this.found.set(selector, { at: now, elements });
    return elements;
  }

  private seen(selector: string): Seen[] {
    const out: Seen[] = [];
    for (const element of this.lookup(selector)) {
      const box = this.env.measure(element);
      if (!box || area(box) === 0) continue;
      const clip = this.env.clip(element);
      out.push({ element, box, clip, visible: intersect(box, clip) });
    }
    return out;
  }

  /** The best of several matches: visible in its clip, then the largest
   *  visible area, then DOM order (the sort is stable). */
  private best(matches: Seen[]): Seen | null {
    const ranked = [...matches].sort((a, b) => area(b.visible) - area(a.visible));
    return ranked[0] ?? null;
  }

  private exact(anchor: Extract<AgentCursorAnchor, { surface: string }>): Resolution | null {
    let parked: Resolution | null = null;
    for (const value of anchorValues(anchor)) {
      const pick = this.best(this.seen(`[data-agent-anchor="${value}"]`));
      if (!pick) continue;
      const aim = aimPoint(pick.box);
      if (area(pick.visible) > 0) {
        // Its aim point is in view, else the middle of the part that is.
        const point = inside(aim, pick.visible) ? aim : aimPoint(pick.visible);
        return { kind: 'anchor', point, element: pick.element, clip: pick.clip };
      }
      // Drawn but out of its clip: an edge park, unless a less exact match is in view.
      const { point, angle } = clampToClip(aim, pick.clip);
      parked ??= { kind: 'edge', point, toward: aim, angle, element: pick.element, clip: pick.clip };
    }
    if (parked) return parked;
    // Not in the DOM at all: an image card the Board view culled (panned out
    // of its pane) is still on the board, so it parks at the pane's edge.
    const [board, image] = anchor.itemId.split('/');
    const culled = image ? this.env.culled?.(board, image) : null;
    if (!culled || area(culled.box) === 0) return null;
    const aim = aimPoint(culled.box);
    const { point, angle } = clampToClip(aim, culled.clip);
    return { kind: 'edge', point, toward: aim, angle, element: culled.element, clip: culled.clip };
  }

  private launcher(key: string, step: LauncherStep, share = LAUNCHER_VISIBLE_SHARE): Resolution | null {
    const matches = this.seen(`[data-agent-launcher="${key}"]`)
      .filter((seen) => area(seen.visible) >= area(seen.box) * share);
    // The Assets dock's own tab beats the rail's button: it is where the person looks once the dock is open.
    const pick = this.best(step === 'surface' && matches.some((seen) => !seen.element.closest(RAIL))
      ? matches.filter((seen) => !seen.element.closest(RAIL)) : matches);
    if (!pick) return null;
    const point = { x: pick.box.left + pick.box.width + LAUNCHER_GAP_PX, y: pick.box.top + pick.box.height / 2 };
    return { kind: 'launcher', step, point, element: pick.element, box: pick.box };
  }

  /**
   * Where `anchor` is now. `canvasMounted`: the canvas is on screen (a
   * canvas anchor then is the canvas layer's, not this one's). `gone`: the
   * caller knows the anchor's item no longer exists (an image removed), so
   * an exact anchor that isn't there is `{kind: 'gone'}`, not a fall back to
   * its board.
   */
  resolve(anchor: AgentCursorAnchor, { canvasMounted = false, gone = false }: { canvasMounted?: boolean; gone?: boolean } = {}): Resolution {
    if (!('surface' in anchor)) {
      return canvasMounted ? { kind: 'none' } : this.launcher('canvas', 'canvas') ?? { kind: 'none' };
    }
    const exact = this.exact(anchor);
    if (exact) return exact;
    if (gone) return { kind: 'gone' };
    const [board] = anchor.itemId.split('/');
    const launcherKey = agentAnchor(board) && `moodboard:${board}`;
    return (launcherKey ? this.launcher(launcherKey, 'board') : null)
      ?? this.launcher('moodboard', 'surface')
      ?? { kind: 'none' };
  }
}

/** The environment on the real page. */
export function domEnv(): ResolverEnv {
  const viewport = (): Box => ({ left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
  return {
    query: (selector) => Array.from(document.querySelectorAll(selector)),
    measure: (element) => {
      const rect = element.getBoundingClientRect();
      return rect.width === 0 && rect.height === 0 ? null : { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    },
    culled: (board, image) => {
      const view = boardView();
      const pane = view?.pane();
      const camera = view?.camera();
      if (!view || view.boardId !== board || !pane || !camera) return null;
      const rect = pane.getBoundingClientRect();
      const clip = intersect(viewport(), { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      const centre = { x: clip.left + clip.width / 2, y: clip.top + clip.height / 2 };
      let best: { box: Box; distance: number } | null = null;
      for (const card of view.cards()) {
        if (card.imageId !== image) continue;
        const box = { left: rect.left + camera.x + card.x * camera.zoom, top: rect.top + camera.y + card.y * camera.zoom,
          width: card.width * camera.zoom, height: card.height * camera.zoom };
        const distance = Math.hypot(box.left + box.width / 2 - centre.x, box.top + box.height / 2 - centre.y);
        if (!best || distance < best.distance) best = { box, distance };
      }
      return best ? { box: best.box, clip, element: pane } : null;
    },
    clip: (element) => {
      let clip = viewport();
      // The boxes it is visible through: every overflow ancestor (the
      // dock's scroll area, the Studio's React Flow pane, the list).
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const rect = parent.getBoundingClientRect();
        clip = intersect(clip, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      }
      return clip;
    },
  };
}
