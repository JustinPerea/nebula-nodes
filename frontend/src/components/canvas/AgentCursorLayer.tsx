import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, useStoreApi, ViewportPortal, type Node } from '@xyflow/react';
import type { NodeData } from '../../types';
import {
  AGENT_CURSOR_IDLE_MS,
  AGENT_SAY_FADE_MS,
  AGENT_SAY_MS,
  useAgentPresenceStore,
  type AgentCursor,
} from '../../store/agentPresenceStore';
import type { AgentCursorAction } from '../../lib/wsClient';
import { resolveAnchor, type Point } from '../../lib/agentCursorMotion';
import {
  AGENT_CURSOR_ENTRANCE_PX,
  AGENT_CURSOR_FADE_SPRING,
  AGENT_CURSOR_IDLE_OPACITY,
  AGENT_CURSOR_MOVING_SPEED,
  createMotion,
  cursorDurationMs,
  entranceStart,
  isMoving,
  planMove,
  stepExit,
  stepMotion,
  type CursorMotion,
} from '../../lib/agentCursorPlanner';
import { placedByPerson } from '../../lib/personNodeMoves';
import {
  AGENT_CURSOR_ARROW_PATH,
  AGENT_CURSOR_HOVER_SLOP_PX as HOVER_SLOP_PX,
  AGENT_CURSOR_NAME_FIRST_SIGHT_MS,
  AGENT_CURSOR_STACK,
  cursorShape,
  cursorsMeet,
  deStackLayout,
  inkFor,
  labelWidths,
  labelLayout,
  nameVisible,
  paintOrder,
  pillEdge,
  sessionFill,
  sessionName,
  targetsMeet,
  type StackSpot,
} from '../../lib/agentCursorLook';
import { SPRING_SOFT, springFromStiffness, springLinear } from '../../lib/springs';
import '../../styles/agentCursor.css';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Until each action has its own look (GM's agent cursor spec, phase 2), an
 * action draws today's nearest visual: these ripple on arrival, a drag also
 * pulls its wire, and move, look and think draw nothing extra.
 */
const RIPPLE_ACTIONS: ReadonlySet<AgentCursorAction> = new Set(['click', 'drag', 'type', 'run', 'propose', 'wait', 'error']);

/** The CSS springs, sampled once (agentCursor.css reads them). */
let springVars: Record<`--${string}`, string> | null = null;
function cursorSpringVars(): Record<`--${string}`, string> {
  if (springVars) return springVars;
  const soft = springLinear(SPRING_SOFT);
  const ring = springLinear(springFromStiffness(AGENT_CURSOR_FADE_SPRING.stiffness, AGENT_CURSOR_FADE_SPRING.damping));
  springVars = {
    '--agent-cursor-soft': `${soft.durationMs}ms ${soft.easing}`,
    '--agent-cursor-ring': `${ring.durationMs}ms ${ring.easing}`,
  };
  return springVars;
}


/**
 * What the cursors share: each one's resolved target, so a later cursor
 * lands beside an earlier one rather than on it, and the person's pointer,
 * for the arc's side and the name on hover.
 */
interface FieldEntry {
  target: Point;
  /** When it visibly landed on its spot (de-stacking order), Infinity while
   *  it is still on its way. */
  since: number;
  /** The spot it was stamped at. */
  at: Point | null;
  /** The node its event anchors to, and that event (seq): the same pair on
   *  a later report means the node moved, not the agent. */
  node: string | null;
  seq: number;
  /** Its say pill shows: the cursor stacked below it steps past name and say. */
  say: boolean;
  /** Its pills' widths in screen px (labelWidths), for who its label meets. */
  nameW?: number;
  sayW?: number;
  /** Where its node was drawn when `target` was read (null off a node). */
  nodeAt?: Point | null;
}

interface Label { say: boolean; nameW?: number; sayW?: number }

const samePoint = (a: Point | null | undefined, b: Point | null | undefined) =>
  a === b || (Boolean(a) && Boolean(b) && a!.x === b!.x && a!.y === b!.y);

class CursorField {
  /** Each cursor's resolved target and its place in the stack. */
  readonly targets = new Map<string, FieldEntry>();
  /** Each cursor's motion, so a new flight can see the others still under way. */
  readonly motions = new Map<string, CursorMotion>();
  readonly wakers = new Map<string, () => void>();
  /** A label shown before the cursor's first report. */
  private readonly pendingSay = new Map<string, Label>();
  readonly pointerListeners = new Set<() => void>();
  pointer: Point | null = null;
  /** The pane's box, read once and kept until it resizes or the viewport moves. */
  private pane: DOMRect | null = null;
  /** Bumped when anything on screen may have moved: cached hover boxes are stale. */
  layoutEpoch = 0;
  /** Bumped each time the page is hidden: a flight that was under way then
   *  lands unseen on return, with no arrival (GM - Design, PR #211 r5). */
  visibilityEpoch = 0;
  private arrivals = 0;

  /** A cursor's say pill showed or went: the cursors stacked below it glide
   *  to their new step on the land spring (GM - Design, PR #211 r13 item 2). */
  setSay(key: string, say: boolean, widths?: { nameW: number; sayW: number }): void {
    const label: Label = { say, nameW: widths?.nameW, sayW: widths?.sayW };
    const entry = this.targets.get(key);
    if (!entry) {
      this.pendingSay.set(key, label); // before its first report
      return;
    }
    if (entry.say === say && entry.nameW === label.nameW && entry.sayW === label.sayW) return;
    this.targets.set(key, { ...entry, ...label });
    for (const [other, wake] of this.wakers) if (other !== key) wake();
  }

  /** A cursor's resolved target, its node and event, and where that node
   *  is now (`nodeAt`, its drawn position), read this frame. */
  report(key: string, target: Point, zoom: number, node: string | null = null, seq = 0, nodeAt: Point | null = null): void {
    this.purge();
    const before = this.targets.get(key);
    let changed = false;
    if (before && before.target.x === target.x && before.target.y === target.y) {
      if (before.node !== node || before.seq !== seq || !samePoint(before.nodeAt, nodeAt)) {
        this.targets.set(key, { ...before, node, seq, nodeAt });
      }
    } else {
      this.place(key, before, target, zoom, node, seq);
      this.targets.set(key, { ...this.targets.get(key)!, nodeAt });
      changed = true;
    }
    if (node !== null && nodeAt) {
      // The node moved, so it carried every cursor on it the same way: move
      // them now, so the stack is read from where they all are this frame,
      // whichever cursor's frame runs first. Each by how far the node moved
      // since its own last report, so a cursor already moved this frame
      // isn't moved again (round 4c: the column follows its head's tip).
      for (const [other, o] of this.targets) {
        if (other === key || o.node !== node || !o.nodeAt) continue;
        const dx = nodeAt.x - o.nodeAt.x;
        const dy = nodeAt.y - o.nodeAt.y;
        if (dx === 0 && dy === 0) continue;
        this.place(other, o, { x: o.target.x + dx, y: o.target.y + dy }, zoom, o.node, o.seq);
        this.targets.set(other, { ...this.targets.get(other)!, nodeAt });
        changed = true;
      }
    }
    if (changed) for (const [other, wake] of this.wakers) if (other !== key) wake();
  }

  private place(key: string, before: FieldEntry | undefined, target: Point, zoom: number, node: string | null, seq: number): void {
    const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) * zoom <= AGENT_CURSOR_STACK.radiusPx;
    if (before && node !== null && before.node === node && before.seq === seq) {
      // Carried by its node with no event of its own (a person's drag, a
      // sync): it keeps its stamp, so the cursors one node carries keep
      // their order all the way (GM - Design, PR #211 r9 item 3). Unless the
      // node carries it onto a cursor the node doesn't carry (near enough to
      // join its column: targetsMeet): that one was there first, so this one
      // arrives now and is stamped on landing (review 2, L2).
      const as = (o: FieldEntry, at: Point) => ({ key: '', since: 0, target: at, say: o.say, nameW: o.nameW, sayW: o.sayW });
      const meets = [...this.targets].some(([other, o]) => other !== key && o.node !== node
        && targetsMeet(as(o, o.target), as(before, target), zoom) && !targetsMeet(as(o, o.target), as(before, before.target), zoom));
      const dx = target.x - before.target.x;
      const dy = target.y - before.target.y;
      this.targets.set(key, meets
        ? { target, since: Infinity, at: null, node, seq, say: before.say, nameW: before.nameW, sayW: before.sayW }
        : { ...before, target, at: before.at && { x: before.at.x + dx, y: before.at.y + dy } });
      return;
    }
    // A new event keeps its place in the stack while it stays within the
    // stack radius of the spot it landed on. Further than that, it is on its
    // way to a new spot and is stamped again on landing.
    const anchor = before?.at ?? null;
    const stays = before && anchor && near(anchor, target);
    this.targets.set(key, stays
      ? { ...before, target, node, seq }
      : before
        ? { target, since: Infinity, at: null, node, seq, say: before.say, nameW: before.nameW, sayW: before.sayW }
        : { target, since: Infinity, at: null, node, seq, say: false, ...this.pendingSay.get(key) });
    this.pendingSay.delete(key);
  }

  /** The cursor visibly landed: it takes its place in the stack now, so the
   *  one that lands second moves aside (GM - Design, PR #211 r5). No other
   *  cursor needs waking: its stamp is the newest, so every landed cursor
   *  keeps its spot, and those still on their way are awake already. */
  landed(key: string): void {
    const entry = this.targets.get(key);
    if (!entry || entry.since !== Infinity) return;
    this.targets.set(key, { ...entry, since: (this.arrivals += 1), at: { ...entry.target } });
  }

  spot(key: string, zoom: number): Point | undefined {
    return this.layout(zoom).get(key)?.at;
  }

  /** Every live cursor's spot and what put it there (deStackLayout). */
  layout(zoom: number): Map<string, StackSpot> {
    this.purge();
    if (this.targets.size < 2) {
      return new Map([...this.targets].map(([k, v]) => [k, { at: v.target, sig: '', above: [] }]));
    }
    // Cursors still on their way come after every landed one, the one due to
    // land soonest first.
    const entries = [...this.targets].map(([k, v]) => ({
      key: k,
      target: v.target,
      since: v.since !== Infinity ? v.since : UNLANDED + this.etaMs(k),
      say: v.say,
      nameW: v.nameW,
      sayW: v.sayW,
    }));
    return deStackLayout(entries, zoom);
  }

  /**
   * Is the room under this cursor's say pill clear: no other cursor's
   * drawn arrow or pills (where it is this frame, not where it is going)
   * within clearPx of this cursor's label with the say, and no other arrow
   * beside it (cursorsMeet)? So the say shows once the cursors below have
   * all but finished their glide. Cursors still
   * flying are passing through, not stacked, and don't count (GM - Design,
   * PR #211 review 6, item 3).
   */
  sayRoomClear(key: string, at: Point, zoom: number): boolean {
    this.purge();
    const own = this.targets.get(key);
    if (!own) return true;
    const mine = cursorShape({ x: at.x * zoom, y: at.y * zoom }, true, own.nameW, own.sayW);
    for (const [other, entry] of this.targets) {
      if (other === key) continue;
      const m = this.motions.get(other);
      if (!m || m.plan) continue;
      const theirs = cursorShape({ x: m.pos.x * zoom, y: m.pos.y * zoom }, entry.say, entry.nameW, entry.sayW);
      if (cursorsMeet(mine, theirs)) return false;
    }
    return true;
  }

  private etaMs(key: string): number {
    const plan = this.motions.get(key)?.plan;
    return plan ? Math.max(0, plan.durationMs - plan.elapsed * 1000) : 0;
  }

  /** Other cursors' flights still under way. */
  flightsBesides(key: string) {
    this.purge();
    return [...this.motions].filter(([k, m]) => k !== key && m.plan).map(([, m]) => m.plan!);
  }

  paneRect(dom: Element): DOMRect {
    if (!this.pane) this.pane = dom.getBoundingClientRect();
    return this.pane;
  }

  readonly invalidateLayout = (): void => {
    this.pane = null;
    this.layoutEpoch += 1;
  };

  private released = new Set<string>();

  /** A view for this key is mounted (again): a release still pending is off. */
  claim(key: string): void {
    this.released.delete(key);
  }

  /** Its view unmounted: the cursor is forgotten before any cursor next reads
   *  the field, unless a view for the key mounts again first. React's
   *  StrictMode reconnects a view's effects in dev when it moves in the paint
   *  order; forgetting at once lost its stamp, so it landed again as the
   *  newest (round 4, live). The others wake to take the room it leaves. */
  release(key: string): void {
    this.released.add(key);
    for (const [other, wake] of this.wakers) if (other !== key) wake();
  }

  private purge(): void {
    for (const key of this.released) this.forget(key);
    this.released.clear();
  }

  forget(key: string): void {
    this.targets.delete(key);
    this.pendingSay.delete(key);
    this.motions.delete(key);
    this.wakers.delete(key);
    for (const wake of this.wakers.values()) wake();
  }
}

/** A new say pill waits at most this long for the room under it to clear;
 *  the cursors below need about 230 ms on the land spring. */
const SAY_WAIT_MAX_MS = 600;

/** De-stacking order for cursors still on their way: after every landed one. */
const UNLANDED = 1e12;

function overlaps(rect: DOMRect, x: number, y: number): boolean {
  return rect.width > 0 && x >= rect.left - HOVER_SLOP_PX && x <= rect.right + HOVER_SLOP_PX
    && y >= rect.top - HOVER_SLOP_PX && y <= rect.bottom + HOVER_SLOP_PX;
}

type Phase = 'pickup' | 'travel' | 'rest';

function AgentCursorView({ cursor, zoom, peers, field, leaving = false, nameTaken = false, onExited }: {
  cursor: AgentCursor;
  zoom: number;
  peers: number;
  field: CursorField;
  /** Removed from the store: it fades out where it is, then onExited forgets it. */
  leaving?: boolean;
  /** While leaving, a live cursor shows the same name: the pill hides at once. */
  nameTaken?: boolean;
  onExited?: (key: string) => void;
}) {
  const store = useStoreApi<Node<NodeData>>();
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<SVGSVGElement | null>(null);
  const wireRef = useRef<SVGLineElement | null>(null);
  const motion = useRef<CursorMotion | null>(null);
  const phase = useRef<Phase>('rest');
  // A new event plans a fresh move from wherever the cursor is.
  const planPending = useRef(false);
  const zoomRef = useRef(zoom);
  const peersRef = useRef(peers);
  const frame = useRef<number | null>(null);
  const lastTime = useRef<number | null>(null);
  const firstSightAt = useRef<number | null>(null);
  const hovered = useRef(false);
  const sayShownRef = useRef(false);
  const idleRef = useRef(false);
  const wake = useRef<() => void>(() => {});
  const updateLabel = useRef<() => void>(() => {});
  const place = useRef<() => void>(() => {});
  const leavingRef = useRef(leaving);
  // What put it on its spot last frame (StackSpot.sig): the spot moving
  // with this unchanged is a ride (a zoom, a node carried), not a re-layout.
  const layoutSig = useRef<string | null>(null);
  // A say pill just shown waits, hidden, until the cursors below have
  // glided out of its way (review 6, item 3): since when, or null.
  const sayWaitSince = useRef<number | null>(null);
  const sayWasShown = useRef(false);
  const exited = useRef(onExited);
  const [arrivedSeq, setArrivedSeq] = useState(0);
  // Each holds the event seq whose timer ran out, so a new event resets both.
  const [sayDoneSeq, setSayDoneSeq] = useState(0);
  const [sayFadeSeq, setSayFadeSeq] = useState(0);
  const [idleSeq, setIdleSeq] = useState(0);
  const showSay = Boolean(cursor.say) && sayDoneSeq !== cursor.seq;
  // Fading out, still mounted (GM - Design, round 19); a new event's seq ends it.
  const sayLeaving = sayFadeSeq === cursor.seq;
  const idle = idleSeq === cursor.seq;

  // A pill hidden by a takeover stays hidden for the rest of that exit, even
  // if the new holder leaves first (GM - Design, PR #211 review 5, item 6).
  const [takenLatched, setTakenLatched] = useState(false);
  if (leaving && nameTaken && !takenLatched) setTakenLatched(true);
  if (!leaving && takenLatched) setTakenLatched(false);
  const taken = leaving && (nameTaken || takenLatched);

  const dragging = cursor.action === 'drag' && cursor.from !== undefined;
  const fill = sessionFill(cursor.color, cursor.session);
  const name = sessionName(cursor.name, cursor.session);
  const widths = useMemo(() => labelWidths(name, cursor.say), [name, cursor.say]);

  // Narration and idle dimming follow each new event. The bubble fades on a
  // spring about 3 s after the last event, then goes; at once under reduced
  // motion. A new event clears both timers, so a fade in progress stops.
  useEffect(() => {
    // Leaving: the say and the dimming stay as they are; the whole cursor
    // fades on the opacity spring, no pill on a curve of its own (GM -
    // Design, PR #211 review 5, item 4).
    if (leaving) return undefined;
    const seq = cursor.seq;
    // A replayed cursor (a tab that just connected) is already part way
    // through both, by its last event's age (GM - Design, PR #211 r3). A live
    // event starts them now.
    const ageMs = cursor.replayed ? Math.max(0, Date.now() - cursor.receivedAt) : 0;
    let fadeTimer: number | undefined;
    const sayTimer = window.setTimeout(() => {
      if (prefersReducedMotion()) {
        setSayDoneSeq(seq);
        return;
      }
      setSayFadeSeq(seq);
      fadeTimer = window.setTimeout(() => setSayDoneSeq(seq), AGENT_SAY_FADE_MS);
    }, Math.max(0, AGENT_SAY_MS - ageMs));
    const idleTimer = window.setTimeout(() => setIdleSeq(seq), Math.max(0, AGENT_CURSOR_IDLE_MS - ageMs));
    return () => {
      window.clearTimeout(sayTimer);
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
      window.clearTimeout(idleTimer);
    };
  }, [cursor.seq, cursor.receivedAt, cursor.replayed, leaving]);

  // What the loop, the pointer and the timers read between renders.
  useLayoutEffect(() => {
    sayShownRef.current = showSay && !idle;
    idleRef.current = idle;
    // A leaving cursor keeps the peers it had as its exit began, so its
    // label keeps its layout (review 5, M1).
    if (!leaving) peersRef.current = peers;
    leavingRef.current = leaving;
    exited.current = onExited;
    // Its label block, for the cursor stacked below it (the say pill counts
    // while it is drawn, its fade out included).
    if (leaving) return;
    field.setSay(cursor.key, showSay && !idle, widths);
    // A say pill that just appeared: hidden until the room under it is
    // clear, then it fades in. Under reduced motion everything is instant.
    const sayNow = showSay && !idle;
    const el = cursorRef.current;
    if (sayNow && !sayWasShown.current && !prefersReducedMotion() && el) {
      sayWaitSince.current = performance.now();
      // The loop sees it: a say comes with a new event, which re-runs the
      // loop's effect (below) and wakes it.
      el.dataset.sayWait = 'true';
    } else if (!sayNow && el && sayWaitSince.current !== null) {
      sayWaitSince.current = null;
      delete el.dataset.sayWait;
    }
    sayWasShown.current = sayNow;
  });

  useLayoutEffect(() => {
    const reduced = prefersReducedMotion();
    const opacityTarget = () => (idleRef.current ? AGENT_CURSOR_IDLE_OPACITY : 1);
    // The person's pointer in flow coordinates, or null off the canvas. The
    // pane's box is cached on the field: no layout read per frame.
    const pointerInFlow = (): Point | null => {
      const client = field.pointer;
      const { domNode, transform } = store.getState();
      if (!client || !domNode || !transform) return null;
      const box = field.paneRect(domNode);
      if (client.x < box.left || client.x > box.right || client.y < box.top || client.y > box.bottom) return null;
      const [tx, ty, scale] = transform;
      return { x: (client.x - box.left - tx) / scale, y: (client.y - box.top - ty) / scale };
    };
    // A cursor that isn't flying sits on whole device pixels and off its own
    // compositor layer, so its pill and the pill's edge draw crisp; it is
    // promoted (will-change) only while it flies (GM - Design, PR #211 r10
    // item 1). Snapped where it is drawn, never in the motion, so nothing
    // drifts.
    const onPixels = (p: Point): Point => {
      const { domNode, transform } = store.getState();
      if (!domNode || !transform) return p;
      const box = field.paneRect(domNode);
      const [tx, ty, scale] = transform;
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const snap = (flow: number, origin: number, shift: number) =>
        (Math.round((origin + shift + flow * scale) * dpr) / dpr - origin - shift) / scale;
      return { x: snap(p.x, box.left, tx), y: snap(p.y, box.top, ty) };
    };
    const apply = () => {
      const el = cursorRef.current;
      const m = motion.current;
      if (!el || !m) return;
      const flying = m.plan !== null || m.landing !== null;
      const at = flying ? m.pos : onPixels(m.pos);
      el.style.transform = `translate(${at.x}px, ${at.y}px) scale(${1 / zoomRef.current})`;
      el.style.willChange = flying ? 'transform, opacity' : 'auto';
      el.style.opacity = String(Math.min(1, Math.max(0, m.opacity.x)));
      if (pointerRef.current) pointerRef.current.style.transform = m.lean.x === 0 ? '' : `rotate(${m.lean.x}deg)`;
      // Set outside React so a re-render never hides a placed cursor again.
      el.dataset.placed = 'true';
    };
    place.current = apply;
    const updateWire = (start: Point | null, arrivedNow = false) => {
      const line = wireRef.current;
      const m = motion.current;
      if (!line) return;
      if (arrivedNow && start && m && dragging) {
        // The tip is at the port: the wire ends there as it fades.
        line.setAttribute('x2', String(m.pos.x));
        line.setAttribute('y2', String(m.pos.y));
      }
      if (!start || !m || phase.current !== 'travel' || !dragging) {
        line.style.opacity = '0';
        return;
      }
      line.setAttribute('x1', String(start.x));
      line.setAttribute('y1', String(start.y));
      line.setAttribute('x2', String(m.pos.x));
      line.setAttribute('y2', String(m.pos.y));
      line.style.strokeWidth = String(2 / zoomRef.current);
      line.style.opacity = '1';
    };
    // The cursor's own hover boxes (arrow and pills), read at most once per
    // landing, label change or viewport move, never per frame or per pointermove.
    let hoverBoxes: DOMRect[] | null = null;
    let hoverEpoch = -1;
    // The tip moved since the boxes were read (a flight, or following its
    // node): they are stale when it comes to rest (review 2, L1).
    let movedSinceBoxes = false;
    let seenVisibility = field.visibilityEpoch;
    const hoverHit = (x: number, y: number): boolean => {
      if (!hoverBoxes || hoverEpoch !== field.layoutEpoch) {
        const parts = [pointerRef.current, ...(cursorRef.current?.querySelectorAll('.agent-cursor__name, .agent-cursor__say') ?? [])];
        hoverBoxes = parts.filter((part): part is Element => part !== null).map((part) => part.getBoundingClientRect());
        hoverEpoch = field.layoutEpoch;
      }
      return hoverBoxes.some((rect) => overlaps(rect, x, y));
    };
    // The name and say rules (§4), written as one attribute from the loop,
    // the pointer and the timers: never React state per frame.
    updateLabel.current = () => {
      const el = cursorRef.current;
      // A leaving cursor's label keeps the layout it had (review 5, M1).
      if (!el || leavingRef.current) return;
      const m = motion.current;
      const sinceFirstSightMs = firstSightAt.current === null ? 0 : performance.now() - firstSightAt.current;
      const shown = nameVisible({
        moving: !reduced && m !== null && isMoving(m, zoomRef.current),
        peers: peersRef.current,
        hovered: hovered.current,
        sinceFirstSightMs,
      });
      const layout = labelLayout(shown, sayShownRef.current);
      if (el.dataset.label !== layout) hoverBoxes = null; // the pills changed: their boxes too
      el.dataset.label = layout;
    };
    const onPointer = () => {
      const client = field.pointer;
      // While it flies the boxes are stale; it re-tests on landing.
      const flying = phase.current !== 'rest';
      const over = client !== null && !flying && hoverHit(client.x, client.y);
      if (over === hovered.current) return;
      hovered.current = over;
      updateLabel.current();
    };

    const tick = (time: number) => {
      frame.current = null;
      if (leavingRef.current) {
        // Its exit: no events, no place in the stack, no hover; it fades out
        // where it is, then it's forgotten.
        const m = motion.current;
        const exitDt = lastTime.current === null ? 1 / 60 : (time - lastTime.current) / 1000;
        lastTime.current = time;
        if (!m || stepExit(m, exitDt)) {
          apply();
          lastTime.current = null;
          exited.current?.(cursor.key);
          return;
        }
        apply();
        updateWire(null);
        frame.current = requestAnimationFrame(tick);
        return;
      }
      const lookup = store.getState().nodeLookup;
      const resolved = resolveAnchor(cursor.target, lookup);
      const start = dragging && cursor.from ? resolveAnchor(cursor.from, lookup) : null;
      if (!resolved) return; // Node not drawn yet; the store subscription wakes us.
      // The zoom this frame, from the store: a zoom in progress carries the
      // column at its screen-px steps on this very frame (review 6, item 5).
      const z = store.getState().transform?.[2] ?? zoomRef.current;
      zoomRef.current = z;
      const nodeId = 'nodeId' in cursor.target ? cursor.target.nodeId : null;
      const nodeAt = nodeId !== null
        ? (lookup.get(nodeId) as { internals?: { positionAbsolute?: Point } } | undefined)?.internals?.positionAbsolute ?? null
        : null;
      field.report(cursor.key, resolved, z, nodeId, cursor.seq, nodeAt && { x: nodeAt.x, y: nodeAt.y });
      const laid = field.layout(z).get(cursor.key);
      const target = laid?.at ?? resolved;
      // Its layout changed (a say, a join, a leave): it glides to the new
      // spot. Anything else moving the spot (a zoom, a node carried, the
      // column's head carried) carries it there on this frame.
      const shifted = laid !== undefined && layoutSig.current !== null && laid.sig !== layoutSig.current;
      if (laid) layoutSig.current = laid.sig;
      const goal = phase.current === 'pickup' && start ? start : target;
      const pointer = pointerInFlow();
      const others = field.flightsBesides(cursor.key);

      // An event this tab heard while hidden (or long ago) snaps to its
      // target: no flight replayed, no action shown as if it were now
      // (GM - Design, PR #211 r2). The say shows only while still current.
      // So does a cursor from the replay a tab gets on connect (r3): it is
      // drawn where it is, and moves normally on its next event.
      const ageMs = Date.now() - cursor.receivedAt;
      const flightPx = motion.current
        ? Math.hypot(goal.x - motion.current.pos.x, goal.y - motion.current.pos.y) * z
        : AGENT_CURSOR_ENTRANCE_PX;
      const stale = planPending.current && !reduced && (cursor.replayed || ageMs > cursorDurationMs(flightPx));
      if (stale) {
        planPending.current = false;
        phase.current = 'rest';
        if (!motion.current) {
          motion.current = createMotion(target, opacityTarget());
          field.motions.set(cursor.key, motion.current);
        }
        const m = motion.current;
        // Back mid-exit: it is put on its spot, and the fade reverses on the
        // same spring from where it is.
        const fading = !reduced && m.opacity.x < opacityTarget() - 0.01 ? { ...m.opacity } : null;
        stepMotion(m, target, 0, { zoom: z, reduced: true, opacityTarget: opacityTarget() });
        if (fading) m.opacity = fading;
        field.landed(cursor.key);
        firstSightAt.current = performance.now();
        if (ageMs >= AGENT_SAY_MS) setSayDoneSeq(cursor.seq);
        window.setTimeout(() => updateLabel.current(), AGENT_CURSOR_NAME_FIRST_SIGHT_MS + 20);
        lastTime.current = null;
        apply();
        updateWire(null);
        field.invalidateLayout();
        updateLabel.current();
        onPointer();
        // Still fading back in, or a new say waiting for room: on next frame.
        if (fading || sayWaitSince.current !== null) frame.current = requestAnimationFrame(tick);
        return;
      }

      if (!motion.current) {
        // First sighting: in from 64 px back along the line to its first target.
        motion.current = reduced
          ? createMotion(target, opacityTarget())
          : createMotion(entranceStart(goal, start ? { from: start, to: target } : null, z), 0);
        field.motions.set(cursor.key, motion.current);
        firstSightAt.current = performance.now();
        window.setTimeout(() => updateLabel.current(), AGENT_CURSOR_NAME_FIRST_SIGHT_MS + 20);
        if (!reduced) planMove(motion.current, goal, { zoom: z, pointer, others });
      } else if (planPending.current && !reduced) {
        planMove(motion.current, goal, { zoom: z, pointer, others });
      }
      planPending.current = false;

      const m = motion.current;
      // Hidden since the last frame: whatever was under way happened unseen.
      const wasHidden = seenVisibility !== field.visibilityEpoch;
      seenVisibility = field.visibilityEpoch;
      const dt = lastTime.current === null ? 1 / 60 : wasHidden ? Infinity : (time - lastTime.current) / 1000;
      lastTime.current = time;
      // What carries the goal: the node's own point (de-stacking moves the
      // spot off it), so a ride follows the node and a de-stack shift lands.
      const carrier = goal === target ? resolved : goal;
      // The person's own move of the node it rests on (a drag, a keyboard
      // nudge, Arrange): it rides at any speed (GM - Design, PR #211 review 4,
      // item 2). A drag says so on the node; a nudge or an Arrange leaves the
      // node where the person put it. The planner reads this only when the
      // node jumped, so a node merely sitting there changes nothing.
      const anchor = 'nodeId' in cursor.target
        ? lookup.get(cursor.target.nodeId) as { dragging?: boolean; position?: { x: number; y: number } } | undefined
        : undefined;
      const dragged = goal === target && anchor !== undefined && 'nodeId' in cursor.target
        && (Boolean(anchor.dragging) || placedByPerson(cursor.target.nodeId, anchor.position));
      const fromX = m.pos.x;
      const fromY = m.pos.y;
      const restAt = onPixels(goal);
      const restOffset = { x: restAt.x - goal.x, y: restAt.y - goal.y };
      const result = stepMotion(m, goal, dt, { zoom: z, reduced, opacityTarget: opacityTarget(), pointer, carrier, dragged, restOffset, shifted });
      let arrivedNow = false;
      // A flight, a landing, or a ride carried by its node.
      if (m.plan || m.landing || m.pos.x !== fromX || m.pos.y !== fromY) movedSinceBoxes = true;

      if (result.caughtUp) {
        // The tab was hidden, throttled or stalled mid-move: the tip lands,
        // and that's all. No ring, no wire, nothing shown as if it were now
        // (GM - Design, PR #211 r5; review 2, M1).
        phase.current = 'rest';
        apply();
        updateWire(null);
        field.landed(cursor.key);
        updateLabel.current();
        lastTime.current = null;
        hoverBoxes = null;
        movedSinceBoxes = false;
        onPointer();
        if (sayWaitSince.current !== null) frame.current = requestAnimationFrame(tick);
        return;
      }

      if (phase.current === 'pickup' && start) {
        // At the port, nearly still: now pull the wire to the target.
        const near = Math.hypot(m.pos.x - start.x, m.pos.y - start.y) * z < 2;
        if (!m.plan && near && Math.hypot(m.vel.x, m.vel.y) * z < AGENT_CURSOR_MOVING_SPEED) {
          phase.current = 'travel';
          planMove(m, target, { zoom: z, pointer, others });
        }
      } else if (phase.current === 'travel' && (result.arrived || reduced || (!m.plan && !m.landing && !m.awaiting))) {
        arrivedNow = true;
        // The tip is at the target (within 2 px): the action fires and the
        // wire lets go here, never at the hand-off.
        phase.current = 'rest';
        setArrivedSeq(cursor.seq);
        field.landed(cursor.key);
        // No layout invalidation here: nothing else moved, and this
        // cursor's own hover boxes go when it comes to rest (movedSinceBoxes).
      }
      apply();
      updateWire(start, arrivedNow);
      updateLabel.current();
      const sayWaiting = sayWaitSince.current !== null;
      if (sayWaiting && (field.sayRoomClear(cursor.key, m.pos, z) || performance.now() - sayWaitSince.current! > SAY_WAIT_MAX_MS)) {
        sayWaitSince.current = null;
        if (cursorRef.current) delete cursorRef.current.dataset.sayWait;
      }

      if (phase.current === 'rest' && result.atRest && sayWaitSince.current === null) {
        lastTime.current = null;
        field.landed(cursor.key);
        if (movedSinceBoxes) {
          hoverBoxes = null;
          movedSinceBoxes = false;
        }
        onPointer(); // landed under a still pointer, or flew out from under it
        return; // At rest: sleep until the canvas, an event or a timer changes.
      }
      frame.current = requestAnimationFrame(tick);
    };

    wake.current = () => {
      if (frame.current === null) frame.current = requestAnimationFrame(tick);
    };
    if (!leaving) {
      field.wakers.set(cursor.key, () => wake.current());
      // Back mid-exit: its motion goes on from where the exit left it.
      if (motion.current) field.motions.set(cursor.key, motion.current);
      field.pointerListeners.add(onPointer);
    }

    if (!leaving) {
      phase.current = dragging && !reduced ? 'pickup' : 'travel';
      planPending.current = true;
    }
    lastTime.current = null;
    wake.current();
    // Nodes move, resize, or appear after a graph sync: follow them. A zoom
    // moves a resting cursor at once, in this frame: its spot's screen-px
    // steps change their flow size with the zoom, and a frame late they'd
    // show the wrong step while the person zooms (GM - Design, PR #211
    // review 6, item 4: zoom carries the column like a drag).
    let seenZoom = store.getState().transform?.[2];
    const unsubscribe = store.subscribe(() => {
      const zoomNow = store.getState().transform?.[2];
      const zoomed = zoomNow !== seenZoom;
      seenZoom = zoomNow;
      if (zoomed && frame.current === null && !leavingRef.current && motion.current && phase.current === 'rest') {
        tick(performance.now());
        // The next frame's step counts from that frame, not from now.
        lastTime.current = null;
        return;
      }
      wake.current();
    });
    return () => {
      unsubscribe();
      field.pointerListeners.delete(onPointer);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [cursor.seq, cursor.key, cursor.target, cursor.from, cursor.receivedAt, cursor.replayed, dragging, leaving, store, field]);

  // A cursor leaves the stack as its exit starts, so it isn't counted for
  // de-stacking while it fades: the cleanup below runs as `leaving` turns
  // true (and when a live cursor unmounts). A leaving view claims nothing.
  useEffect(() => {
    if (leaving) return undefined;
    field.claim(cursor.key);
    return () => field.release(cursor.key);
  }, [field, cursor.key, leaving]);
  // An unmounted cursor stops for good: another cursor leaving in the same
  // commit wakes it (forget), and a tick run after its cleanup would stamp
  // its old spot again, a ghost that pushes the next cursor there aside
  // (live, after a backend restart's empty replay).
  useEffect(() => () => {
    wake.current = () => {};
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  // Idle dims on the fade spring, and the say pill's own timers change the label.
  useEffect(() => {
    wake.current();
  }, [idle]);
  useLayoutEffect(() => {
    updateLabel.current();
  });

  useEffect(() => {
    zoomRef.current = zoom;
    place.current();
  }, [zoom]);

  const ripple = RIPPLE_ACTIONS.has(cursor.action);
  return (
    <>
      <svg className="agent-cursor__wire-layer" aria-hidden="true">
        <line ref={wireRef} className="agent-cursor__wire" stroke={fill} />
      </svg>
      <div
        ref={cursorRef}
        className="agent-cursor"
        style={{ ['--agent-color' as string]: fill, ['--agent-ink' as string]: inkFor(fill) }}
        data-agent={cursor.id}
        data-session={cursor.session?.key}
        data-action={cursor.action}
        data-edge={pillEdge(fill) ?? undefined}
        data-idle={idle ? 'true' : undefined}
        data-leaving={leaving ? 'true' : undefined}
        data-taken={taken ? 'true' : undefined}
        role={leaving ? undefined : 'status'}
        aria-hidden={leaving ? true : undefined}
        aria-label={leaving ? undefined : `${name}${cursor.say ? `: ${cursor.say}` : ''}`}
      >
        {ripple && arrivedSeq === cursor.seq && !prefersReducedMotion() && (
          <span key={cursor.seq} className="agent-cursor__ripple" />
        )}
        <svg ref={pointerRef} className="agent-cursor__pointer" width="20" height="22" viewBox="0 0 20 22" aria-hidden="true">
          <path d={AGENT_CURSOR_ARROW_PATH} />
        </svg>
        <div className="agent-cursor__label">
          {/* The agent's name isolated, so a right-to-left name keeps " · 2" after it. */}
          <span className="agent-cursor__name"><bdi>{cursor.name}</bdi>{name.slice(cursor.name.length)}</span>
          {showSay && !idle && (
            <span className={`agent-cursor__say${sayLeaving ? ' agent-cursor__say--leaving' : ''}`}>{cursor.say}</span>
          )}
        </div>
      </div>
    </>
  );
}

const PRUNE_INTERVAL_MS = 5_000;

/** Live cursors for agents working on the canvas, drawn in flow coordinates. */
export function AgentCursorLayer() {
  const agents = useAgentPresenceStore((s) => s.agents);
  const prune = useAgentPresenceStore((s) => s.prune);
  const zoom = useStore((s) => s.transform[2]);
  const [field] = useState(() => new CursorField());

  // The presence exit (GM - Design, PR #211 review 4): a cursor the store
  // drops (a prune, a number taken over, a demoted tab, a refused hello, a
  // forgotten token) stays drawn for one fade, from its last event. Under
  // reduced motion it goes at once. The same key coming back ends its exit.
  const [shown, setShown] = useState(() => ({ agents, leaving: {} as Record<string, AgentCursor> }));
  let leaving = shown.leaving;
  if (shown.agents !== agents) {
    const next: Record<string, AgentCursor> = {};
    const fade = !prefersReducedMotion();
    for (const [key, cursor] of Object.entries(shown.leaving)) if (!(key in agents)) next[key] = cursor;
    for (const [key, cursor] of Object.entries(shown.agents)) if (fade && !(key in agents)) next[key] = cursor;
    leaving = next;
    setShown({ agents, leaving: next });
  }
  const onExited = useCallback((key: string) => setShown((state) => {
    if (!(key in state.leaving)) return state;
    const rest = { ...state.leaving };
    delete rest[key];
    return { ...state, leaving: rest };
  }), []);

  useEffect(() => {
    const timer = window.setInterval(() => prune(), PRUNE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [prune]);

  // The cached pane box and hover boxes go stale when the viewport moves or
  // the pane resizes: drop them then, and only then.
  const storeApi = useStoreApi<Node<NodeData>>();
  useEffect(() => {
    let transform = storeApi.getState().transform;
    const unsubscribe = storeApi.subscribe((state) => {
      if (state.transform !== transform) {
        transform = state.transform;
        field.invalidateLayout();
      }
    });
    const dom = storeApi.getState().domNode;
    const observer = dom && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => field.invalidateLayout()) : null;
    if (dom) observer?.observe(dom);
    window.addEventListener('resize', field.invalidateLayout);
    return () => {
      unsubscribe();
      observer?.disconnect();
      window.removeEventListener('resize', field.invalidateLayout);
    };
  }, [storeApi, field]);

  // A tab hidden mid-flight lands its cursors unseen on return (review 2,
  // M1): count each hide. A cursor in flight then has a frame pending, which
  // runs on return and sees the count; a resting one has nothing to land.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') field.visibilityEpoch += 1;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [field]);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      field.pointer = { x: event.clientX, y: event.clientY };
      for (const listener of field.pointerListeners) listener();
    };
    const onLeave = () => {
      field.pointer = null;
      for (const listener of field.pointerListeners) listener();
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, [field]);

  const cursors = Object.values(agents);
  const exiting = Object.values(leaving);
  if (cursors.length === 0 && exiting.length === 0) return null;
  const byKey = new Map(cursors.map((cursor) => [cursor.key, cursor]));
  const names = new Set(cursors.map((cursor) => sessionName(cursor.name, cursor.session)));
  // One list, so a cursor coming back mid-exit keeps its view. Leaving
  // cursors paint under every live one; the most recently active paints on top.
  const views = [
    ...paintOrder(exiting).map((key) => ({ cursor: leaving[key], leaving: true })),
    ...paintOrder(cursors).map((key) => ({ cursor: byKey.get(key)!, leaving: false })),
  ];
  return (
    <ViewportPortal>
      <div className="agent-cursor-layer" style={cursorSpringVars()}>
        {views.map(({ cursor, leaving: out }) => (
          <AgentCursorView
            key={cursor.key}
            cursor={cursor}
            zoom={zoom}
            peers={cursors.length}
            field={field}
            leaving={out}
            nameTaken={out && names.has(sessionName(cursor.name, cursor.session))}
            onExited={onExited}
          />
        ))}
      </div>
    </ViewportPortal>
  );
}
