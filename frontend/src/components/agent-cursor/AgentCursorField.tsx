import { type ReactElement, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, StickyNote } from 'lucide-react';
import {
  AGENT_CURSOR_IDLE_MS,
  AGENT_SAY_FADE_MS,
  useAgentPresenceStore,
  type AgentCursor,
} from '../../store/agentPresenceStore';
import { stepSpring, type Point, type SpringState } from '../../lib/agentCursorMotion';
import type { CursorLabels, CursorSpace } from '../../lib/agentCursorSpace';
import {
  frameAt,
  nextChangeAt,
  onArrival,
  onEvent,
  onKeystroke,
  onSettled,
  type Expression,
  type ExpressionFrame,
} from '../../lib/agentCursorExpression';
import { defaultSay, errorCause, heldDefault, sayHoldMs, surfaceSay, type SayContext } from '../../lib/agentCursorSays';
import { isSettled } from '../../lib/agentCursorSettled';
import { useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { fieldBox, fieldTextChanged, findTypeField, onScreen, type FieldBox, type TypeField } from '../../lib/agentCursorField';
import {
  AGENT_CURSOR_CLICK,
  AGENT_CURSOR_DASHED,
  AGENT_CURSOR_HALO,
  AGENT_CURSOR_LOOK,
  AGENT_CURSOR_RUN,
  AGENT_CURSOR_TYPE,
  AGENT_CURSOR_WIRE,
  AGENT_CURSOR_WIRE_SPRING,
} from '../../lib/agentCursorTuning';
import {
  AGENT_CURSOR_ENTRANCE_PX,
  AGENT_CURSOR_IDLE_OPACITY,
  AGENT_CURSOR_MOVING_SPEED,
  createMotion,
  cursorDurationMs,
  entranceStart,
  isMoving,
  planMove,
  AGENT_CURSOR_REST_HOLD_MAX_MS,
  stepExit,
  stepMotion,
  type CursorMotion,
} from '../../lib/agentCursorPlanner';
import { cursorHandoff } from '../../lib/agentCursorHandoff';
import type { CursorLayer } from '../../lib/agentCursorLayerOf';
import { parkChevron, parkLabelNudge, PARK_CHEVRON_PX } from '../../lib/agentCursorPark';
import { placedByPerson } from '../../lib/personNodeMoves';
import {
  AGENT_CURSOR_ARROW_PATH,
  AGENT_CURSOR_ARROW_TIP,
  AGENT_CURSOR_HOVER_SLOP_PX as HOVER_SLOP_PX,
  AGENT_CURSOR_NAME_FIRST_SIGHT_MS,
  AGENT_CURSOR_NAME_FONT,
  AGENT_CURSOR_SAY_FONT,
  AGENT_CURSOR_STACK,
  countLabel,
  cursorShape,
  deStackLayout,
  cursorsMeet,
  sayPillBox,
  stackStepPx,
  targetChains,
  sameChain,
  inkFor,
  labelWidths,
  labelLayout,
  nameVisible,
  paintOrder,
  pillEdge,
  sessionFill,
  type StackSpot,
} from '../../lib/agentCursorLook';
import { cursorLabel } from '../../lib/agentCursorLabel';
import { cursorSpringVars } from '../../lib/agentCursorSpringVars';
import '../../styles/agentCursor.css';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** The arrow's middle (its box is 1.5–14.7 × 1.5–20.1): the arcs' centre. */
const ARROW_MIDDLE = { x: 8, y: 11 } as const;
/** An arc of `deg` degrees on a circle drawn with pathLength 360. */
const arcDash = (deg: number) => `${deg} ${360 - deg}`;
/** The dashed halo: the arrow grown about its tip (propose, wait), so
 *  nothing paints above or left of the tip and the column spacing holds
 *  (GM r56 item D). */
const DASHED_GROW = `translate(${AGENT_CURSOR_ARROW_TIP.x} ${AGENT_CURSOR_ARROW_TIP.y}) scale(${AGENT_CURSOR_DASHED.grow}) translate(${-AGENT_CURSOR_ARROW_TIP.x} ${-AGENT_CURSOR_ARROW_TIP.y})`;

interface SayInfo {
  /** The line beside the cursor ('' for none). */
  text: string;
  /** It is the action's default line, not the agent's. */
  isDefault: boolean;
  /** type: the field the caret or underline goes on, if the card shows one. */
  field: TypeField | null;
}

/** The cursor's line for this event: its own say, or its action's default (r54). */
function sayFor(cursor: AgentCursor, lookup: CursorLabels | undefined): SayInfo {
  const nodeId = 'nodeId' in cursor.target ? cursor.target.nodeId : null;
  const handle = 'nodeId' in cursor.target ? cursor.target.handle : undefined;
  const field = cursor.action === 'type' && nodeId ? findTypeField(nodeId, handle) : null;
  if (cursor.say) return { text: cursor.say, isDefault: false, field };
  if ('surface' in cursor.target && cursor.anchorNames) {
    // A moodboard item: its default line names what `anchorNames` carries
    // (the board, the image's number, the control), so it reads right even
    // for an item that isn't on screen (GM - Design, PR #233 r4 item 4).
    const names = cursor.anchorNames;
    const line = surfaceSay(cursor.action, {
      board: names.board,
      image: names.image ?? null,
      hasImage: cursor.target.itemId.includes('/'),
      part: cursor.target.part ?? null,
    });
    if (line) return { text: line, isDefault: true, field: null };
  }
  const labelOf = (id: string | null): string | null => {
    if (!id) return null;
    const label = lookup?.get(id)?.data?.label;
    return typeof label === 'string' && label.trim() ? label.trim() : null;
  };
  const fromId = cursor.from && 'nodeId' in cursor.from ? cursor.from.nodeId : null;
  const context: SayContext = {
    node: labelOf(nodeId),
    from: labelOf(fromId),
    pulled: cursor.from !== undefined,
    field: field ? (field.kind === 'param' ? { kind: 'param', label: field.label } : { kind: 'text' }) : null,
    cause: cursor.action === 'error' ? errorCause(cursor.did, nodeId, cursor.receivedAt) : null,
  };
  return { text: defaultSay(cursor.action, context), isDefault: true, field };
}

/**
 * type's caret at the end of the field's text, or its underline under a
 * param row (§2), drawn in flow coordinates beside the cursor so it rides
 * with its node and zooms with the card's text. Measured when the state
 * starts and on each keystroke, never per frame; a node move only moves it.
 */
function FieldMark({ space, field, nodeId, blinking, keystrokeAt }: {
  space: CursorSpace;
  field: TypeField;
  nodeId: string;
  blinking: boolean;
  keystrokeAt: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [kind, setKind] = useState<FieldBox['kind']>(field.kind === 'param' ? 'underline' : 'caret');
  useLayoutEffect(() => {
    let box: FieldBox | null = null;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const at = space.nodeInfo(nodeId)?.at;
      if (!box || !at) {
        el.style.visibility = 'hidden';
        return;
      }
      el.style.visibility = '';
      el.style.transform = `translate(${at.x + box.x}px, ${at.y + box.y}px)`;
      el.style.width = `${box.width}px`;
      el.style.height = `${box.height}px`;
    };
    const measure = () => {
      box = fieldBox(field, nodeId, space.zoom() ?? 1, AGENT_CURSOR_TYPE.caretPx, AGENT_CURSOR_TYPE.underlinePx);
      if (box) setKind(box.kind);
      place();
    };
    measure();
    // Once more after the card has drawn the text this keystroke brought.
    const frame = requestAnimationFrame(measure);
    const unsubscribe = space.subscribe(place);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [field, nodeId, space, keystrokeAt]);
  return (
    <div
      ref={ref}
      className="agent-cursor__field-mark"
      data-kind={kind}
      data-blink={blinking && kind === 'caret' ? 'true' : undefined}
      aria-hidden="true"
    />
  );
}


/**
 * What the cursors share: each one's resolved target, so a later cursor
 * lands beside an earlier one rather than on it, and the person's pointer,
 * for the arc's side and the name on hover.
 */
interface FieldEntry {
  target: Point;
  /** Its place in the column order once it visibly landed: the backend's
   *  arrival (`rank`), Infinity while it is still on its way (GM - Design,
   *  PR #211 r21). */
  since: number;
  /** The backend's arrival for its cursor (AgentCursor.arrivedAt). */
  rank: number;
  /** Whether `rank` is the backend's own arrival: ties then go by the
   *  cursor's key, the same in every tab (#211 review 9, LOW-2). */
  known: boolean;
  /** Ties in `since` with no backend arrival (an older event): this tab's
   *  landing order. */
  landedSeq: number;
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
  /** From `target` to the point it counts as for its target chain
   *  (chainPoint): zero, except on a handle, which counts as its node's
   *  header point, as the backend counts it (#219 r62). A carry moves the
   *  node whole, so the offset holds through it. */
  chainOff?: Point;
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
  /** Told when a cursor first lands on its target (the screen layer's item
   *  outlines start there: the action fires at the tip, design section 2). */
  readonly landedListeners = new Set<(key: string) => void>();
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
  /** Bumped whenever anything the layout reads changes. */
  private version = 0;
  private laid: { key: string; spots: Map<string, StackSpot> } | null = null;
  /** Per cursor, how many events moved its target (review 7, MEDIUM-1). */
  private readonly revs = new Map<string, number>();
  /** Each cursor's say pill as painted on the canvas now: its side, or
   *  absent while it has none, waits, or shows in the Agent log only. */
  readonly paint = new Map<string, 'right' | 'left'>();
  /** Each view draws its cursor where its motion is now (the column floor). */
  readonly placers = new Map<string, () => void>();
  /** Cursors unfolding from a count cursor, not yet a step under the
   *  member above (hold). */
  readonly opening = new Set<string>();
  /** Cursors a merge put under a member they are drawn above: they glide
   *  past it to their slot, not floored, until they come to rest (hold). */
  readonly crossing = new Set<string>();
  /** The members of every column one of whose cursors glides now: drawn in
   *  column order, the head on top (inOrder). */
  readonly ordered = new Set<string>();
  /** Cursors drawn over every other cursor and wire (GM - Design, #219
   *  r103): from the frame a flight starts until it has landed and its
   *  column's glide is at rest (aloftRank). Each with the order its flight
   *  started in, so of two flights that overlap the later one is on top. */
  readonly aloft = new Map<string, { seq: number; flight: object | null }>();
  private flightSeq = 0;
  /** Cursors whose loop stopped with their node gone (the view's tick finds
   *  no target): they glide and fly no more, so they hold no column order,
   *  no crossing and no place on top (#219 review 6, NIT-1). */
  readonly stalled = new Set<string>();
  /** Count cursors on their way out, by key, with the members they stood
   *  for: the count that takes their slot (one of those members) waits,
   *  unseen, until they are gone, so a column never shows more than three
   *  (review 8, MEDIUM-2; spec, exit keeps its layout). Keyed by the group,
   *  not the column's head, so a head leaving in the same moment can't
   *  release it (#211 review 9, NIT-2). */
  readonly exitingCounts = new Map<string, readonly string[]>();
  /** Cursors a node move is carrying, each with its target before the
   *  carry: while its target chain differs from the one it had there, it is
   *  laid out as the newest arrival (r24 insert) in the column it is passing
   *  (a preview, GM - Design, #219 r47 Q1). Not the literal bottom slot: the
   *  insert puts it above a member aimed over 16 canvas units below its
   *  target, as the backend does at the drop, so nothing moves there (r52,
   *  r62). Display only: the backend's arrival (agentPresenceArrival)
   *  governs, and ends it; with no arrival CARRY_PREVIEW_HOLD_MS after the
   *  drop, the backend disagreed, and the cursor glides back. */
  readonly carriedFrom = new Map<string, Point>();
  /** Nodes the person is dragging now (React Flow's `dragging`). */
  private readonly draggedNodes = new Set<string>();
  private lastCarryAt = 0;
  private carryTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether a count cursor on its way out still holds the slot this one
   *  (a member it stood for) would take. */
  countExiting(key: string): boolean {
    for (const [other, group] of this.exitingCounts) if (other !== key && group.includes(key)) return true;
    return false;
  }

  /** Wakes every live cursor (a count cursor's exit ended). */
  wakeAll(): void {
    for (const wake of this.wakers.values()) wake();
  }
  private readonly folded = new Set<string>();
  /** Each cursor's name as its pill shows it, for the count cursor's list. */
  readonly names = new Map<string, string>();

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
    this.version += 1;
    for (const [other, wake] of this.wakers) if (other !== key) wake();
  }

  /** A cursor's resolved target, its node and event, and where that node
   *  is now (`nodeAt`, its drawn position), read this frame. */
  report(key: string, target: Point, zoom: number, node: string | null = null, seq = 0, nodeAt: Point | null = null, rank = 0, known = false, dragging = false, chain: Point = target): void {
    this.purge();
    let changed = false;
    const chainOff = { x: chain.x - target.x, y: chain.y - target.y };
    if (node !== null) {
      if (dragging) {
        if (!this.draggedNodes.has(node)) {
          this.draggedNodes.add(node);
          this.version += 1;
        }
      } else if (this.draggedNodes.delete(node)) {
        // The drop: the backend's arrival follows its write, so the wait
        // for it starts here. An overlap join's preview ends now: the
        // backend counts no arrival for it (r52 Q1, r62).
        this.version += 1;
        changed = true;
        this.lastCarryAt = performance.now();
        this.settleCarries();
      }
    }
    let before = this.targets.get(key);
    if (before && (before.rank !== rank || before.known !== known)) {
      // The backend's word on a carry, if one was previewed: it governs now.
      this.carriedFrom.delete(key);
      // The backend's arrival moved (it went somewhere new, or a node move
      // changed its target chain: agentPresenceArrival): its place in the
      // column follows it, in every tab alike.
      before = { ...before, rank, known, since: before.since === Infinity ? Infinity : rank };
      this.targets.set(key, before);
      this.version += 1;
      changed = true;
    }
    if (before && before.target.x === target.x && before.target.y === target.y) {
      if (before.node !== node || before.seq !== seq || !samePoint(before.nodeAt, nodeAt) || !samePoint(before.chainOff, chainOff)) {
        this.targets.set(key, { ...before, node, seq, nodeAt, chainOff });
        if (!samePoint(before.chainOff, chainOff)) {
          // Its chain point moved on its own (a node resized under a port
          // cursor): the others' previews and band read it, so they lay out
          // again now, whichever cursor's frame ran first (review 3, C3/C4).
          this.version += 1;
          changed = true;
        }
      }
    } else {
      // Carried only when its node itself moved: a node measured or resized
      // (after a reload, the graph measures its nodes after the replay)
      // moves the point on it, and that is no carry (live r4i).
      const moved = Boolean(before?.nodeAt && nodeAt && !samePoint(before.nodeAt, nodeAt));
      this.place(key, before, target, zoom, node, seq, rank, known, moved);
      this.targets.set(key, { ...this.targets.get(key)!, nodeAt, chainOff });
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
        this.place(other, o, { x: o.target.x + dx, y: o.target.y + dy }, zoom, o.node, o.seq, o.rank, o.known, true);
        this.targets.set(other, { ...this.targets.get(other)!, nodeAt });
        changed = true;
      }
    }
    if (changed) for (const [other, wake] of this.wakers) if (other !== key) wake();
  }

  private place(key: string, before: FieldEntry | undefined, target: Point, zoom: number, node: string | null, seq: number, rank = before?.rank ?? 0, known = before?.known ?? false, moved = false): void {
    this.version += 1;
    const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) * zoom <= AGENT_CURSOR_STACK.radiusPx;
    if (before && node !== null && before.node === node && before.seq === seq) {
      // Carried by its node with no event of its own (a person's drag, an
      // agent's move, an undo, a node measured): it keeps its place, so the
      // cursors one node carries keep their order all the way (GM - Design,
      // PR #211 r9 item 3). Whether a carry makes it arrive now is never
      // this tab's call: the backend decides from its target chain
      // (agent_presence.carry_nodes) and tells every tab
      // (agentPresenceArrival, the rank change in report), so live tabs and
      // a reload agree (#219 r24 Q2).
      const dx = target.x - before.target.x;
      const dy = target.y - before.target.y;
      this.targets.set(key, { ...before, target, at: before.at && { x: before.at.x + dx, y: before.at.y + dy } });
      if (moved) {
        if (!this.carriedFrom.has(key)) this.carriedFrom.set(key, { ...before.target });
        this.lastCarryAt = performance.now();
        this.settleCarries();
      }
      return;
    }
    // An event of its own: no carry to preview.
    this.carriedFrom.delete(key);
    // Its target moved by an event of its own, not carried: the cursors
    // stacked under it glide to their new spots (review 7, MEDIUM-1).
    this.revs.set(key, (this.revs.get(key) ?? 0) + 1);
    // A new event keeps its place in the stack while it stays within the
    // stack radius of the spot it landed on. Further than that, it is on its
    // way to a new spot and is stamped again on landing.
    const anchor = before?.at ?? null;
    const stays = before && anchor && near(anchor, target);
    this.targets.set(key, stays
      ? { ...before, target, node, seq }
      : before
        ? { target, since: Infinity, rank, known, landedSeq: 0, at: null, node, seq, say: before.say, nameW: before.nameW, sayW: before.sayW }
        : { target, since: Infinity, rank, known, landedSeq: 0, at: null, node, seq, say: false, ...this.pendingSay.get(key) });
    this.pendingSay.delete(key);
  }

  /** The cursor visibly landed: it takes its place in the stack now, so the
   *  one that lands second moves aside (GM - Design, PR #211 r5). When its
   *  stamp is the newest, every landed cursor keeps its spot, and those
   *  still on their way are awake already. When it isn't (an older backend
   *  arrival landing after a newer one: two agents sent to one node a
   *  moment apart, the far one landing second), the column re-sorts under
   *  it: the others wake and glide to their new slots on the layout spring,
   *  never left on their old ones until it reaches its own (#219 review 6,
   *  LOW-3). */
  landed(key: string): void {
    const entry = this.targets.get(key);
    if (!entry || entry.since !== Infinity) return;
    // Its place: the backend's arrival, the same in every tab and after a
    // reload (r21).
    this.targets.set(key, { ...entry, since: entry.rank, landedSeq: (this.arrivals += 1), at: { ...entry.target } });
    this.version += 1;
    for (const listener of this.landedListeners) listener(key);
    const newer = [...this.targets].some(([other, v]) => other !== key && v.since !== Infinity && v.since >= entry.rank);
    if (newer) for (const [other, wake] of this.wakers) if (other !== key) wake();
  }

  spot(key: string, zoom: number): Point | undefined {
    return this.layout(zoom).get(key)?.at;
  }

  /** Every live cursor's spot and what put it there (deStackLayout), worked
   *  out once for every view while nothing it reads changes (review 7,
   *  NIT-1): the targets, stamps, labels, zoom, and the order the cursors
   *  still on their way are due to land in. */
  layout(zoom: number): Map<string, StackSpot> {
    this.purge();
    const due = [...this.targets].filter(([, v]) => v.since === Infinity).map(([k]) => ({ k, eta: this.etaMs(k) }));
    due.sort((a, b) => a.eta - b.eta || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
    const cacheKey = `${this.version}|${zoom}|${due.map((d) => d.k).join(',')}`;
    if (this.laid && this.laid.key === cacheKey) return this.laid.spots;
    let spots: Map<string, StackSpot>;
    if (this.targets.size < 2) {
      spots = new Map([...this.targets].map(([k, v]) => [k, { at: v.target, sig: '', above: [] }]));
    } else {
      // Cursors still on their way come after every landed one, the one due
      // to land soonest first.
      const order = new Map(due.map((d, i) => [d.k, i]));
      // A carry the backend would count as an arrival: laid out as the
      // newest arrival (r24 insert) for now, in its own order among the
      // cursors one node carries (r47). Not the literal bottom slot (r52).
      const preview = this.previewed();
      const shift = (p: Point, off: Point | null | undefined) => (off ? { x: p.x + off.x, y: p.y + off.y } : p);
      const entries = (later: ReadonlySet<string>, was = false, chain = false) => [...this.targets].map(([k, v]) => ({
        key: k,
        target: shift(was ? this.carriedFrom.get(k) ?? v.target : v.target, chain ? v.chainOff : null),
        since: v.since !== Infinity ? (later.has(k) ? CARRY_PREVIEW + v.since : v.since) : UNLANDED + order.get(k)!,
        // A backend arrival never ties (it strictly increases), and when
        // two did, the key breaks it in every tab alike; this tab's landing
        // order only for events with no backend arrival (review 9, LOW-2).
        seq: v.known ? undefined : v.landedSeq,
        say: v.say,
        nameW: v.nameW,
        sayW: v.sayW,
      }));
      // During a live drag, a carried cursor that joins a column by overlap
      // alone (arrow meets label, targets still over 16 apart) is laid out
      // as the newest arrival too, the slot the r24 insert gives it: the
      // bottom, unless a member aims more than 16 canvas units below its
      // target, then above that member. So the overlap band and chain range
      // agree, and a straight drag moves the carry's slot one way only
      // (GM - Design, #219 r62; r52 Q1's "drawn last" meant this). Display
      // only, and it ends at the drop: the backend counts no arrival for it,
      // so its slot follows its arrival order, with one glide if that
      // differs (r52 Q1's one accepted motion).
      // The band is measured in chain space, as the chain is: only a member
      // whose chain-input point (a port cursor's: its node's header point,
      // r62) the carry's own comes within band range of gives it that slot.
      // A carry that meets a port cursor's drawn tip, far from its node's
      // header, joins its column (drawn overlap) in plain arrival order,
      // which is what the backend's arrival order gives at the drop: nothing
      // moves mid-drag or there (GM - Design, #219 r75.3; review 3,
      // drag MEDIUM-1). For node cursors the two spaces are one.
      const dragged = [...this.carriedFrom.keys()].filter((k) => {
        const node = this.targets.get(k)?.node;
        return !preview.has(k) && node != null && this.draggedNodes.has(node);
      });
      spots = deStackLayout(entries(preview), zoom);
      if (dragged.length > 0) {
        // Read each one's column where the carry has put it, at its own
        // arrival, against its column before the carry: any new member is
        // a join. Not read with it as the newest arrival: that slot moves
        // it down the column, and could make the join it then previews.
        // Both read in chain space: each cursor at its chain-input point.
        // And in canvas units, as the chain is: the join deStackLayout makes
        // at zoom 1, at every zoom. In screen px it would grow as 1/zoom in
        // canvas units, and at zoom-out a carry on a port cursor's drawn tip
        // would reach that cursor's node header, 120 or so canvas units off
        // (GM - Design, #219 r85 rule b; review 4, MEDIUM-1). Drawn overlap
        // at any zoom still forms the column, in arrival order (r75.3).
        const before = deStackLayout(entries(new Set(), true, true), BAND_ZOOM);
        const after = deStackLayout(entries(new Set(), false, true), BAND_ZOOM);
        const members = (laid: Map<string, StackSpot>, k: string) =>
          [...laid].filter(([, s]) => s.column === laid.get(k)!.column).map(([o]) => o);
        const now = spots;
        const joined = dragged.filter((k) => {
          const had = new Set(members(before, k));
          const near = new Set(members(after, k).filter((o) => !had.has(o)));
          // A new member of the column it is drawn in, in band range of it.
          return members(now, k).some((o) => near.has(o));
        });
        if (joined.length > 0) spots = deStackLayout(entries(new Set([...preview, ...joined])), zoom);
      }
    }
    // A cursor no longer folded opens out of its count cursor (hold).
    for (const [k, spot] of spots) {
      if (spot.collapsedInto) this.folded.add(k);
      else if (this.folded.delete(k)) this.opening.add(k);
    }
    for (const k of this.folded) if (!spots.has(k)) this.folded.delete(k);
    this.laid = { key: cacheKey, spots };
    return spots;
  }

  /** How many events have moved this cursor's target (place). */
  revOf(key: string): number {
    return this.revs.get(key) ?? 0;
  }

  /**
   * The column floor (review 7, MEDIUM-1 and LOW-1): a landed cursor in a
   * column is never drawn less than its step under the member above it,
   * where that one is drawn now (its say counted while it paints), so a
   * head moving by its own event leads the cursors under it, and they glide
   * in lockstep whichever frame runs first. A cursor gliding on the land
   * spring is held; one at rest is held only while the member above glides
   * or flies (its spring's overshoot, a head's own move), and then glides
   * back to its spot. A ride is exact as it is, and a cursor still flying in
   * comes from anywhere. True when it moved it.
   */
  hold(key: string, zoom: number): boolean {
    const m = this.motions.get(key);
    const entry = this.targets.get(key);
    // A crossing lasts until the glide ends, however it ends (it landed, it
    // flies on an event of its own, it heads its column now): its paint
    // order goes back with it. So does a hold's start (restGate): a landed
    // cursor holds nothing (review 3, drag NIT-1).
    if (m && !m.landing) {
      this.crossing.delete(key);
      this.heldSince.delete(key);
    }
    if (!m || !entry || m.plan || entry.since === Infinity) return false;
    // Its loop stopped (its node gone): it is moved and marked no more.
    if (this.stalled.has(key)) {
      this.crossing.delete(key);
      return false;
    }
    // Not stepped at this zoom yet (a zoom's frame, before its own turn):
    // its own step carries it to this zoom first, then holds it.
    if (m.lastZoom !== null && m.lastZoom !== zoom) return false;
    const spot = this.layout(zoom).get(key);
    if (!spot || spot.collapsedInto || spot.above.length === 0) {
      this.crossing.delete(key); // nobody above it now to pass
      return false;
    }
    const upKey = spot.above[spot.above.length - 1];
    const up = this.motions.get(upKey);
    if (!up || (!m.landing && !up.plan && !up.landing)) return false;
    // The member above is still to step in this frame: its position is last
    // frame's, and a floor read from it would count this one's own step in
    // lockstep with it as a push past its slot (a crossing). Judged once it
    // has stepped: its holdBelow holds this one then, in the same frame
    // (review 4, drag LOW-1).
    const upDue = this.dueAt.get(upKey);
    if (this.steppedAt.get(upKey) !== this.frameTime && upDue !== undefined && upDue < this.frameTime) return false;
    // A merge can put a cursor under one it is drawn above now: it glides
    // past that member to its new slot, never floored there in one frame
    // (review 8, MEDIUM-1: nothing jumps), until it comes to rest.
    if (this.crossing.has(key)) {
      if (m.landing) return false;
      this.crossing.delete(key);
    }
    if (m.pos.y < up.pos.y - 1e-9) {
      this.crossing.add(key);
      return false;
    }
    const floor = up.pos.y + stackStepPx(Boolean(this.paint.get(upKey))) / zoom;
    if (m.pos.y >= floor - 1e-9) {
      this.opening.delete(key);
      return false;
    }
    // Opening out of a count cursor: it starts on the slot the member
    // above is gliding up from, and is held once they are a step apart.
    if (this.opening.has(key)) return false;
    // A push of more than a pixel past its own slot is a crossing, not a
    // hold: the member above is below its slot and turned back toward it (a
    // wobble back across the chain 1 to 3 frames after a crossing), and
    // setting this one on the floor would jump it in one frame. Gliding, it
    // glides to its slot on the layout spring instead; at rest, it stays on
    // its slot. Either way it is drawn under the one above until it lands or
    // the one above is a step over it again (GM - Design, #219 r75.2;
    // review 3, MEDIUM-2). At rest too: when the frame that moved the
    // member above ran after this one's (a browser's rAF order varies), this
    // one never started the glide, and the floor would jump it 8.6 px
    // (review 4, drag LOW-1, k = 0 in reverse order). A push toward its own
    // slot (a glide that ends on the floor, a head leading its column down)
    // holds as before, and so does one in lockstep with the member above, a
    // fraction of a pixel a frame, at rest or gliding.
    if ((floor - Math.max(m.pos.y, spot.at.y)) * zoom > CROSSING_PUSH_PX) {
      this.crossing.add(key);
      return false;
    }
    m.pos.y = floor;
    if (m.vel.y < up.vel.y) m.vel.y = up.vel.y;
    if (!m.landing) {
      // Off its spot now: it glides back once the member above has settled.
      m.attached = null;
      m.landing = { ...m.pos };
      m.lastZoom = zoom;
      this.wakers.get(key)?.();
    }
    return true;
  }

  /** `orderZoom`: the zoom the order is read at, the store's, one value for
   *  every view (the layer passes it). Each view's own zoom changes at its
   *  own tick, so two views read in one moment could see two layouts, one
   *  ordering the column and the other not, and each repaint undo the
   *  other's without end (#219 review 6, drag-live HIGH-1). */
  readonly orderZoom: () => number;
  constructor(orderZoom: () => number = () => 1) {
    this.orderZoom = orderZoom;
  }
  /** Each view's paint of its marks (aloft, crossing, column order) from
   *  the field's state as it is: it never works the order out again
   *  (syncOrder), so a repaint from there can't re-enter it. */
  readonly markers = new Map<string, () => void>();
  private syncing = false;

  /**
   * The draw order's state, worked out once, at the store's zoom, for every
   * cursor at once (GM - Design, #219 r95, r103 and r106):
   *
   * - **Aloft.** A flight stays on top until it lands: from the frame its
   *   flight starts, the cursor draws over every column member, every other
   *   cursor and every wire, and it takes its column's order only once it
   *   has landed (its own landing glide over) and its column's glide is at
   *   rest, so the z swap happens with nothing moving and it never falls
   *   under a member still passing. Of two flights that overlap, the
   *   later-started one is on top: a new event's flight (a new plan) starts
   *   again on top of the others.
   * - **Column order.** While any member of a column of two or more glides
   *   on the land spring, or is marked crossing, every member of it draws in
   *   column order, the head on top, so a gliding cursor never draws under
   *   a member it passes, however far down the column (a carry going from
   *   the bottom slot back to the head passes two; the crossing mark only
   *   ever judges the member right above). After the glide the column's
   *   normal order returns. A flight is not a glide, nor is a ride, and a
   *   member whose loop stopped (its node gone) glides no more. A cursor
   *   alone in its column has no order to keep.
   * - **Known limit, accepted (GM - Design, #219 r111).** The order's band
   *   (agentCursor.css) raises a gliding column over other columns'
   *   resting cursors, never lowers it. z-index alone can't keep the exact
   *   at-rest order between columns whose DOM orders interleave, and
   *   columns don't overlap at rest, so nothing visible changes. Don't go
   *   back to a negative z-index for it: that put columns under the wires
   *   (r106).
   *
   * Every other cursor whose marks this changes is repainted here, by its
   * marker, which only reads this state. Re-entry (a marker can't reach it,
   * but nothing else may either) returns at once.
   */
  syncOrder(key: string): void {
    if (this.syncing) return;
    this.syncing = true;
    try {
      const laid = this.layout(this.orderZoom());
      const { size, gliding } = this.glides(laid);
      const changed = new Set<string>();
      for (const k of new Set([...this.aloft.keys(), ...this.motions.keys()])) {
        const m = this.motions.get(k);
        const entry = this.aloft.get(k);
        const stalled = this.stalled.has(k);
        if (m?.plan && !stalled) {
          if (entry?.flight !== m.plan) {
            this.aloft.set(k, { seq: (this.flightSeq += 1), flight: m.plan });
            changed.add(k);
          }
          continue;
        }
        if (!entry) continue;
        entry.flight = null;
        const column = laid.get(k)?.column;
        if (m && !stalled && (m.landing || (column !== undefined && gliding.has(column)))) continue;
        this.aloft.delete(k);
        changed.add(k);
      }
      if (this.aloft.size === 0) this.flightSeq = 0;
      const want = new Set<string>();
      for (const [k, spot] of laid) {
        if (spot.column !== undefined && !spot.collapsedInto && gliding.has(spot.column) && size.get(spot.column)! > 1) want.add(k);
      }
      for (const k of new Set([...this.ordered, ...want])) if (want.has(k) !== this.ordered.has(k)) changed.add(k);
      this.ordered.clear();
      for (const k of want) this.ordered.add(k);
      for (const k of changed) if (k !== key) this.markers.get(k)?.();
    } finally {
      this.syncing = false;
    }
  }

  /** The columns one of whose members glides on the land spring now (not a
   *  flight, a ride, or a member whose loop stopped) or is marked crossing,
   *  and each column's size. */
  private glides(laid: Map<string, StackSpot>): { size: Map<string, number>; gliding: Set<string> } {
    const size = new Map<string, number>();
    const gliding = new Set<string>();
    for (const [k, spot] of laid) {
      if (spot.column === undefined || spot.collapsedInto) continue;
      size.set(spot.column, (size.get(spot.column) ?? 0) + 1);
      if (this.stalled.has(k)) continue;
      const m = this.motions.get(k);
      const stepped = this.steppedAt.get(k);
      if (this.crossing.has(k) || (m?.landing && !m.plan && stepped !== undefined && this.frameTime - stepped < 100)) gliding.add(spot.column);
    }
    return { size, gliding };
  }

  /** How many members sit above this cursor's slot, read at the order's
   *  zoom: its place in its column's order (0 for the head). */
  depthOf(key: string): number {
    return this.layout(this.orderZoom()).get(key)?.above.length ?? 0;
  }

  /** This cursor came to rest outside a frame's own step (a caught-up frame
   *  after a stall or a hidden tab, a stale or replayed event snapped to its
   *  spot): no glide is left for it to pass the member above in, so its
   *  crossing mark and its hold's start go with it, as on a landing in hold
   *  (review 4, layout LOW-1). */
  snapped(key: string): void {
    this.crossing.delete(key);
    this.heldSince.delete(key);
  }

  /** This cursor was just drawn at frame `time`: the members under it that
   *  have already stepped in this frame are held to the column floor now
   *  and drawn again; one still to step holds itself after its own step,
   *  so no cursor moves twice in one frame. */
  holdBelow(key: string, zoom: number, time: number, depth = 0): void {
    if (depth > this.targets.size) return;
    for (const [other, spot] of this.layout(zoom)) {
      if (spot.collapsedInto || spot.above[spot.above.length - 1] !== key) continue;
      // Still to step in this frame: it holds itself after its own step.
      const due = this.dueAt.get(other);
      if (this.steppedAt.get(other) !== time && due !== undefined && due < time) continue;
      // Drawn again when it moved, or when it started crossing (its paint
      // order changes on this frame, not its next).
      const crossing = this.crossing.has(other);
      if (this.hold(other, zoom) || this.crossing.has(other) !== crossing) this.placers.get(other)?.();
      this.holdBelow(other, zoom, time, depth + 1);
    }
  }

  /** The frame each cursor last stepped in, and the frame each pending
   *  frame was asked for in (holdBelow). */
  readonly steppedAt = new Map<string, number>();
  readonly dueAt = new Map<string, number>();
  frameTime = -Infinity;

  /** The time a zoom's carry steps a cursor at: the frame it happens in,
   *  one value for every cursor it carries. A clock read per cursor gives
   *  each its own frame (the one above stepped at t, this one at t + a few
   *  µs), so hold() took the member above for one still to step and left
   *  this one off the floor, 1.1 px under the step mid-zoom on CI's slower
   *  clock (#219 r3h). Before any frame has run (no cursor can have a
   *  motion yet, so no carry steps one: kept safe all the same), 0: one
   *  value for the whole carry, and never past the next frame's timestamp,
   *  as a clock read can be (review 5, NIT-2). */
  carryTime(): number {
    return Number.isFinite(this.frameTime) ? this.frameTime : 0;
  }

  /**
   * Is there room for this cursor's say pill on `side`, drawn at `at`
   * (where the cursor is this frame)? Against every other cursor as it is
   * drawn now, its own say included (with its real widths): `wait` when one
   * of its own column's cursors below is still in the way (they glide out
   * of it), or a flying cursor the say waits for; `foreign` when a cursor
   * of another column is in the way, which the say never moves (GM - Design,
   * PR #211 r17 item 2). A flyer counts only when its drawn block (arrow
   * and name pill, GM r22) is in the say's room or it is on its way to a
   * spot under this cursor; one just passing through elsewhere doesn't
   * (r17 item 3). Folded cursors aren't
   * drawn and don't count.
   */
  sayRoom(key: string, side: 'right' | 'left', at: Point, zoom: number, strict = false): { wait: boolean; foreign: boolean } {
    this.purge();
    const out = { wait: false, foreign: false };
    const own = this.targets.get(key);
    if (!own) return out;
    const laid = this.layout(zoom);
    const mySpot = laid.get(key);
    const origin = { x: at.x * zoom, y: at.y * zoom };
    const mine = cursorShape(origin, side, own.nameW, own.sayW);
    const bare = cursorShape(origin, false, own.nameW);
    const room = sayPillBox(mine)!;
    const gap = AGENT_CURSOR_STACK.gapPx;
    for (const [other, entry] of this.targets) {
      if (other === key) continue;
      const spot = laid.get(other);
      const m = this.motions.get(other);
      if (!m || spot?.collapsedInto) continue;
      const theirs = cursorShape({ x: m.pos.x * zoom, y: m.pos.y * zoom }, this.paint.get(other) ?? false, entry.nameW, entry.sayW);
      const under = spot?.above.includes(key) ?? false;
      // A flyer: on its arc, or still landing at speed (its last frames
      // after the arc hands off are part of the same pass).
      // `strict` (a say whose wait is capped, about to show): a moving
      // cursor is in the way like any other, so the say never lands on one
      // carried at speed, or a flyer still passing (#211 review 9, LOW-6).
      if (!strict && isMoving(m, zoom)) {
        // Its whole drawn block, arrow and name pill: two labels on top of
        // each other are as unreadable as a say over an arrow (GM r22).
        const box = theirs.bounds;
        const inRoom = box.left < room.right + gap && box.right > room.left - gap && box.top < room.bottom + gap && box.bottom > room.top - gap;
        if (inRoom || under) out.wait = true;
        continue;
      }
      // The cursor right under it waits until it is a full say step down,
      // so the column floor never has to push it as the say shows.
      if (under && spot!.above[spot!.above.length - 1] === key
        && (m.pos.y - at.y) * zoom < stackStepPx(true) - 0.01) {
        out.wait = true;
        continue;
      }
      // In the way of the say: they meet with it and not without it.
      if (!cursorsMeet(mine, theirs) || cursorsMeet(bare, theirs)) continue;
      if (under || (mySpot?.above.includes(other) ?? false)) out.wait = true;
      else out.foreign = true;
    }
    return out;
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

  /** A node a drag holds is gone (deleted mid-drag): no drop will come for
   *  it, so its drag ends here, as a drop does. Its carries' previews then
   *  end CARRY_PREVIEW_HOLD_MS on unless the backend says otherwise, and the
   *  wait's timer stops with them (#219 review 2, NIT-1). */
  nodeGone(node: string): void {
    if (!this.draggedNodes.delete(node)) return;
    this.version += 1;
    this.lastCarryAt = performance.now();
    this.settleCarries();
  }

  private gates = new Map<string, boolean | undefined>();
  private gatesAt = -Infinity;

  /**
   * One glide, one landing (GM - Design, #219 r65): the cursors gliding on
   * the land spring in this cursor's column come to rest on the same frame,
   * the frame after every one of them is within the rest distance and
   * speed. Before that none rests, so a member with a short way to go never
   * sits on its slot while another is still on its way. Read once per
   * column per frame, before any of them steps in it (all of one frame's
   * steps share `time`). Undefined (rest on its own) for a cursor gliding
   * alone. A member whose loop stopped (its node gone) doesn't hold the rest.
   * A cursor waits at most AGENT_CURSOR_REST_HOLD_MAX_MS past its own rest,
   * then lands on its own (r66). The hold changes only when a cursor counts
   * as at rest: it keeps drawing its spring position, and what the eye sees
   * on its own rest (the hover re-test) doesn't wait for it (the view's
   * loop, `ownRest`).
   */
  restGate(key: string, zoom: number, time: number): boolean | undefined {
    const gate = this.columnGate(key, zoom, time);
    const m = this.motions.get(key);
    if (m?.landing && !m.plan && m.nearRest === true) {
      if (!this.heldSince.has(key)) this.heldSince.set(key, time);
    } else {
      this.heldSince.delete(key);
    }
    if (gate === false && time - (this.heldSince.get(key) ?? Infinity) >= AGENT_CURSOR_REST_HOLD_MAX_MS) return true;
    return gate;
  }

  /** When each held cursor first counted as at rest on its own (restGate). */
  private readonly heldSince = new Map<string, number>();

  private columnGate(key: string, zoom: number, time: number): boolean | undefined {
    if (time !== this.gatesAt) {
      this.gates.clear();
      this.gatesAt = time;
    }
    const laid = this.layout(zoom);
    const column = laid.get(key)?.column;
    if (column === undefined) return undefined;
    if (this.gates.has(column)) return this.gates.get(column);
    const gliding = [...laid].filter(([k, spot]) => {
      const m = this.motions.get(k);
      const stepped = this.steppedAt.get(k);
      return spot.column === column && m?.landing && !m.plan && stepped !== undefined && time - stepped < 100;
    }).map(([k]) => this.motions.get(k)!);
    const gate = gliding.length < 2 ? undefined : gliding.every((m) => m.nearRest === true);
    this.gates.set(column, gate);
    return gate;
  }

  /** The layer unmounted: no timer outlives it. */
  dispose(): void {
    if (this.carryTimer !== null) clearTimeout(this.carryTimer);
    this.carryTimer = null;
  }

  /** Ends the carry previews no drag holds any more, CARRY_PREVIEW_HOLD_MS
   *  after the last carry: by then the backend's arrival has come for every
   *  carry it counts (it follows the drop's graph sync), so one still
   *  previewed is one it didn't, and its cursor glides back to its place. */
  private settleCarries(): void {
    if (this.carryTimer !== null) clearTimeout(this.carryTimer);
    this.carryTimer = null;
    if (this.carriedFrom.size === 0) return;
    const wait = this.lastCarryAt + CARRY_PREVIEW_HOLD_MS - performance.now();
    const held = [...this.carriedFrom.keys()].some((k) => {
      const node = this.targets.get(k)?.node;
      return node != null && this.draggedNodes.has(node);
    });
    if (held || wait > 0) {
      this.carryTimer = setTimeout(() => this.settleCarries(), Math.max(wait, 50));
      return;
    }
    this.carriedFrom.clear();
    this.version += 1;
    this.wakeAll();
  }

  /** The carried cursors whose target chain differs from the one they had
   *  before the carry: the backend would count each as arriving now. Each
   *  at its chain point (chainOff: a handle counts as its node's header
   *  point, as the backend counts it, r62), in canvas units. */
  private previewed(): Set<string> {
    if (this.carriedFrom.size === 0) return new Set();
    const at = (p: Point, v: FieldEntry) => ({ x: p.x + (v.chainOff?.x ?? 0), y: p.y + (v.chainOff?.y ?? 0) });
    const now = new Map([...this.targets].map(([k, v]) => [k, at(v.target, v)]));
    const was = new Map([...this.targets].map(([k, v]) => [k, at(this.carriedFrom.get(k) ?? v.target, v)]));
    const before = targetChains(was);
    const after = targetChains(now);
    return new Set([...this.carriedFrom.keys()].filter((k) => this.targets.has(k) && !sameChain(before.get(k), after.get(k))));
  }

  forget(key: string): void {
    // A node being dragged whose every cursor is forgotten mid-drag: no
    // cursor reports it again, so its drag ends with them. Otherwise a node
    // that reuses its id later (another project) would count as a drop on
    // its first report (review 3, layout NIT-2).
    const node = this.targets.get(key)?.node;
    if (node != null && this.draggedNodes.has(node)
      && ![...this.targets].some(([other, v]) => other !== key && v.node === node)) this.draggedNodes.delete(node);
    this.carriedFrom.delete(key);
    this.heldSince.delete(key);
    this.targets.delete(key);
    this.pendingSay.delete(key);
    this.motions.delete(key);
    this.wakers.delete(key);
    this.paint.delete(key);
    this.placers.delete(key);
    this.markers.delete(key);
    this.names.delete(key);
    this.revs.delete(key);
    this.opening.delete(key);
    this.crossing.delete(key);
    this.ordered.delete(key);
    this.aloft.delete(key);
    this.stalled.delete(key);
    this.steppedAt.delete(key);
    this.dueAt.delete(key);
    this.version += 1;
    for (const wake of this.wakers.values()) wake();
  }
}

/** A new say pill waits at most this long for the room under it to clear;
 *  the cursors below need about 230 ms on the land spring. */
const SAY_WAIT_MAX_MS = 600;

/** The depths the order band has room for (agentCursor.css: a marked
 *  cursor draws at 10 - depth, over an unmarked one at 1). A column shows
 *  at most three, so a deeper slot isn't drawn. */
const AGENT_CURSOR_ORDER_DEPTHS = 8;

/** De-stacking order for cursors still on their way: after every landed one. */
// Past any backend arrival (wall-clock ms).
const UNLANDED = 1e15;
/** A previewed carry's place: after every landed cursor, before any still
 *  on its way (r47 Q1). */
const CARRY_PREVIEW = 1e14;
/** How far past its own slot the column floor may push a gliding member, in
 *  screen px, and hold it; further, the member crosses (CursorField.hold,
 *  GM r75.2). */
const CROSSING_PUSH_PX = 1;
/** How far, in screen px, a cursor is drawn off where its hover boxes were
 *  read before they are read again when it comes to rest. */
const HOVER_STALE_PX = 1;
/** The zoom the band's chain-space join is measured at, whatever the view's
 *  zoom: deStackLayout's join at zoom 1, a fixed radius in canvas units, as
 *  the chain's 16 is (CursorField.layout, GM r85 rule b). */
const BAND_ZOOM = 1;
/** How long a carry's preview waits after the drop for the backend's
 *  arrival before it lets go (r47 Q1). */
export const CARRY_PREVIEW_HOLD_MS = 1500;

function overlaps(rect: DOMRect, x: number, y: number): boolean {
  return rect.width > 0 && x >= rect.left - HOVER_SLOP_PX && x <= rect.right + HOVER_SLOP_PX
    && y >= rect.top - HOVER_SLOP_PX && y <= rect.bottom + HOVER_SLOP_PX;
}

type Phase = 'pickup' | 'travel' | 'rest';

/** Where a say pill is: on the canvas right or left of its arrow; held
 *  hidden while another column is in its way, with nothing moving; waiting
 *  hidden while its own column glides out of its way; or in the Agent log
 *  only (GM - Design, PR #211 r17, r19 item 2). */
type SayState = 'none' | 'hold' | 'wait' | 'log' | 'right' | 'left';

/** Whether the layout keeps room for a say in this state: only once it
 *  waits for its own column or shows (r18 item 3, r19 item 2). */
const sayKeepsRoom = (state: SayState): boolean => state === 'wait' || state === 'right' || state === 'left';

/** The count cursor's fill: neutral, no agent's colour (r17 item 1). */
const COUNT_FILL = '#52525b';

/** The count cursor's list: up to this many names, then how many more. */
const COUNT_LIST_NAMES = 3;

function AgentCursorView({ space, cursor, zoom, peers, field, fontVersion = 0, leaving = false, held = false, nameTaken = false, onExited }: {
  /** The surface it is drawn on. */
  space: CursorSpace;
  cursor: AgentCursor;
  zoom: number;
  peers: number;
  field: CursorField;
  /** Bumped when the page's fonts finish loading: the pills are measured again. */
  fontVersion?: number;
  /** Removed from the store: it fades out where it is, then onExited forgets it. */
  leaving?: boolean;
  /** Handed to the other layer, which has not drawn it yet: this layer holds
   *  the last spot (GM - Design 6) until that one claims it. */
  held?: boolean;
  /** While leaving, a live cursor shows the same name: the pill hides at once. */
  nameTaken?: boolean;
  onExited?: (key: string) => void;
}) {
  const haloId = `agent-cursor-halo-${useId().replace(/:/g, '')}`;
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const pointerRef = useRef<SVGSVGElement | null>(null);
  const wireRef = useRef<SVGPathElement | null>(null);
  // The drag wire's free end, trailing the tip on its lag spring (§2 drag).
  const wireEnd = useRef<SpringState | null>(null);
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
  const writeHandoff = useRef<(final?: boolean) => void>(() => {});
  const handoffEpoch = useRef(cursorHandoff.epoch);
  // Parked at the edge of its panel, its item scrolled out of view (the
  // chevron's render only: its angle is written from the loop, never state per frame).
  const [parked, setParked] = useState(false);
  const parkedRef = useRef(false);
  const parkRef = useRef<SVGSVGElement | null>(null);
  const placeLabelRef = useRef<(toward: Point | null) => void>(() => {});
  const leavingRef = useRef(leaving);
  // What put it on its spot last frame (StackSpot.sig), and the events that
  // moved the targets of the members above it: the spot moving with neither
  // changed is a ride (a zoom, a node carried), not a re-layout.
  const layoutSig = useRef<string | null>(null);
  const layoutRevs = useRef('');
  // Its say pill (r17 item 2): a new one waits, hidden, until the cursors
  // below have glided out of its way (review 6, item 3), moves to the left
  // of its arrow when another column is in the way on the right, and after
  // SAY_WAIT_MAX_MS shows in the Agent log only until the room clears.
  const sayState = useRef<SayState>('none');
  const sayWaitSince = useRef<number | null>(null);
  // The say is held by the cap's strict check (a cursor in the way on both
  // sides, moving ones included): from there it shows only on a side that
  // is strictly clear, or goes to the Agent log when the cap is up, and
  // never back to waiting (#219 review 1, NIT-1).
  const capHold = useRef(false);
  const sayWasShown = useRef(false);
  const sayText = useRef<string | null>(null);
  // In a full column: folded into the count cursor, or the count cursor
  // with the keys it stands for (r17 item 1).
  const [fold, setFold] = useState<{ into: string | null; group: readonly string[] | null }>({ into: null, group: null });
  const foldKey = useRef('');
  const collapsedRef = useRef(false);
  const countingRef = useRef(false);
  // The backend's arrival, read by the frame loop (a new one comes with a
  // new event, which runs the loop's effect again anyway).
  const arrivedRef = useRef(cursor.arrivedAt);
  arrivedRef.current = cursor.arrivedAt;
  const knownRef = useRef(cursor.arrivalKnown);
  knownRef.current = cursor.arrivalKnown;
  // Its column (StackSpot.column), as last laid out.
  const exited = useRef(onExited);
  // Each holds the event seq whose timer ran out, so a new event resets both.
  const [sayDoneSeq, setSayDoneSeq] = useState(0);
  const [sayFadeSeq, setSayFadeSeq] = useState(0);
  const [idleSeq, setIdleSeq] = useState(0);
  // The line beside the cursor: the agent's own say, else the action's
  // default line (GM - Design r54, lib/agentCursorSays), worked out once per
  // event from the canvas as it is then. A default is display only: the
  // accessible name and the Agent log keep the agent's own words.
  const sayInfo = useMemo(() => sayFor(cursor, space.labels()),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per event: cursor.seq names it
    [cursor.seq, cursor.say, cursor.action]);
  const say = sayInfo.text;
  // How long it shows before its exit (r54): max(3 s, 60 ms × characters),
  // capped at 8 s; a default tied to a held state (think, propose, wait)
  // has no timer and holds as long as its state.
  const sayHold = sayInfo.isDefault && heldDefault(cursor.action) ? null : sayHoldMs(say);
  // propose and wait wait for the person: their default stays through idle.
  const sayOutlastsIdle = sayInfo.isDefault && (cursor.action === 'propose' || cursor.action === 'wait');
  // propose and wait end when the person settles what they wait on (their
  // lines go with the state; an agent's own say keeps its own timer).
  const proposalsSynced = useCanvasProposalsStore((s) => s.synced);
  const proposals = useCanvasProposalsStore((s) => s.proposals);
  const questionSets = useAgentQuestionsStore((s) => s.sets);
  const settled = isSettled(cursor, { proposalsSynced, proposals, questionSets });
  const showSay = Boolean(say) && sayDoneSeq !== cursor.seq && !(settled && sayInfo.isDefault && heldDefault(cursor.action));
  const sayHoldRef = useRef(sayHold);
  sayHoldRef.current = sayHold;

  // What the cursor expresses (§2; lib/agentCursorExpression). A new event
  // ends the current state at once (or holds it to its minimum, for a bare
  // move); the new one begins when the tip arrives (arrive, from the loop).
  const [expr, setExpr] = useState<Expression | null>(null);
  const [, setExprClock] = useState(0);
  const arrivedFor = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (leaving) return;
    setExpr((current) => onEvent(current, cursor.action, performance.now()));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per event
  }, [cursor.seq]);
  // The person settled what propose or wait waited on: it ends at once (also
  // when the settled state is what a reload brings, before the cursor lands).
  useLayoutEffect(() => {
    if (settled) setExpr((current) => onSettled(current, cursor.seq, performance.now()));
  }, [settled, expr, cursor.seq]);
  const arrive = useRef<(watched: boolean) => void>(() => {});
  arrive.current = (watched: boolean) => {
    if (arrivedFor.current === cursor.seq) return;
    arrivedFor.current = cursor.seq;
    const { action, seq } = cursor;
    setExpr((current) => onArrival(current, action, seq, performance.now(), watched));
  };
  const idleSince = useRef<number | null>(null);
  // Fading out, still mounted (GM - Design, round 19); a new event's seq ends it.
  const sayLeaving = sayFadeSeq === cursor.seq;
  const idle = idleSeq === cursor.seq;
  if (idle && idleSince.current === null) idleSince.current = performance.now();
  if (!idle) idleSince.current = null;
  // The frame showing now; a timer re-renders when it next changes by itself.
  const exprNow = performance.now();
  const expressed: ExpressionFrame = frameAt(expr, exprNow, idleSince.current);
  useEffect(() => {
    const at = nextChangeAt(expr, performance.now(), idleSince.current);
    if (at === null) return undefined;
    const timer = window.setTimeout(() => setExprClock((c) => c + 1), Math.max(0, at - performance.now()) + 1);
    return () => window.clearTimeout(timer);
  });
  // type: the field's text changing is a keystroke (the caret blinks).
  const typingNode = expressed.action === 'type' && !expressed.lingering && 'nodeId' in cursor.target ? cursor.target.nodeId : null;
  const typingHandle = typingNode && 'handle' in cursor.target ? cursor.target.handle ?? null : null;
  useEffect(() => {
    if (!typingNode) return undefined;
    // Only the field's text counts: a run status or any other change to the
    // node's data is not a keystroke (the blink doesn't restart, nothing is
    // measured again).
    const dataOf = () => space.nodeInfo(typingNode)?.data;
    let seen = dataOf();
    return space.subscribe(() => {
      const now = dataOf();
      if (now === seen) return;
      const typed = fieldTextChanged(seen, now, typingHandle);
      seen = now;
      if (typed) setExpr((current) => onKeystroke(current, performance.now()));
    });
  }, [typingNode, typingHandle, space]);

  // A pill hidden by a takeover stays hidden for the rest of that exit, even
  // if the new holder leaves first (GM - Design, PR #211 review 5, item 6).
  const [takenLatched, setTakenLatched] = useState(false);
  if (leaving && nameTaken && !takenLatched) setTakenLatched(true);
  if (!leaving && takenLatched) setTakenLatched(false);
  const taken = leaving && (nameTaken || takenLatched);

  const dragging = cursor.action === 'drag' && cursor.from !== undefined;
  // A leaving cursor keeps the fold it had as its exit began: a count
  // cursor exits as the count ("3 more", grey), a folded one stays unseen
  // (review 8, MEDIUM-2; spec: exit keeps its layout).
  const exitFold = useRef<typeof fold | null>(null);
  if (leaving && exitFold.current === null) exitFold.current = fold;
  if (!leaving && exitFold.current !== null) exitFold.current = null;
  const shownFold = leaving ? exitFold.current! : fold;
  const counting = shownFold.group !== null && shownFold.group.length > 1;
  const collapsed = shownFold.into !== null;
  const fill = counting ? COUNT_FILL : sessionFill(cursor.color, cursor.session);
  const name = cursorLabel(cursor.name, cursor.session);
  const countText = counting ? countLabel(shownFold.group!.length) : null;
  // Measured again when the page's fonts finish loading: a pill measured
  // with the fallback font can be narrower than it is drawn (review 7,
  // MEDIUM-4). No layout read.
  const widths = useMemo(
    () => labelWidths(countText ?? name, countText === null ? say : ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fontVersion: the fonts changed under the same text
    [name, say, countText, fontVersion],
  );
  const widthsRef = useRef(widths);
  useLayoutEffect(() => { widthsRef.current = widths; });
  // The pills' text in the font they draw in: a subset not loaded yet loads
  // now, and the layer measures again when it has (fontVersion).
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || typeof fonts.load !== 'function') return;
    fonts.load(AGENT_CURSOR_NAME_FONT, countText ?? name).catch(() => {});
    if (say) fonts.load(AGENT_CURSOR_SAY_FONT, say).catch(() => {});
  }, [name, say, countText]);
  // A count cursor and a folded one draw no say pill: the says of a full
  // column's later members show in the Agent log.
  const drawsSay = !counting && !collapsed;
  // The names the count cursor stands for, in arrival order.
  const countNames = counting ? shownFold.group!.map((key) => (key === cursor.key ? name : field.names.get(key) ?? '')) : [];

  // Narration and idle dimming follow each new event. The bubble fades on a
  // spring after its hold (sayHold, GM r54), then goes; at once under reduced
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
    // A default held by its state has no timer: the next event ends it.
    const sayTimer = sayHold === null ? undefined : window.setTimeout(() => {
      if (prefersReducedMotion()) {
        setSayDoneSeq(seq);
        return;
      }
      setSayFadeSeq(seq);
      fadeTimer = window.setTimeout(() => setSayDoneSeq(seq), AGENT_SAY_FADE_MS);
    }, Math.max(0, sayHold - ageMs));
    const idleTimer = window.setTimeout(() => setIdleSeq(seq), Math.max(0, AGENT_CURSOR_IDLE_MS - ageMs));
    return () => {
      window.clearTimeout(sayTimer);
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
      window.clearTimeout(idleTimer);
    };
  }, [cursor.seq, cursor.receivedAt, cursor.replayed, leaving, sayHold]);

  // The say pill's place, set outside React like the label: on the canvas
  // (and which side), waiting hidden, or in the Agent log only.
  const setSay = useRef<(state: SayState) => void>(() => {});
  setSay.current = (state: SayState) => {
    sayState.current = state;
    capHold.current = false;
    if (state === 'none' || state === 'right' || state === 'left') sayWaitSince.current = null;
    const el = cursorRef.current;
    if (el) {
      if (state === 'hold' || state === 'wait' || state === 'log') el.dataset.sayWait = state === 'log' ? 'log' : 'true';
      else delete el.dataset.sayWait;
      if (state === 'left') el.dataset.saySide = 'left';
      else delete el.dataset.saySide;
    }
    if (state === 'right' || state === 'left') field.paint.set(cursor.key, state);
    else field.paint.delete(cursor.key);
    // The layout counts only what is drawn (GM - Design, PR #211 r18 item
    // 3), and nothing moves for a say that may never show (r19 item 2): a
    // say held for another column or in the Agent log keeps no room; once
    // its room is clear it waits while the cursors below glide out of its
    // way, then fades in.
    field.setSay(cursor.key, sayKeepsRoom(state), widths);
  };
  // Where a hidden say goes now, from where the cursors are drawn this
  // frame (GM - Design, PR #211 r17 items 2-3, r18 item 3, r19 item 2):
  // - held: while another column is in the way on both sides, nothing
  //   moves. Once a side is clear, it waits for its room. When
  //   SAY_WAIT_MAX_MS of holding is up (or at once, `capNow`), it goes to
  //   the Agent log only, and nothing has moved.
  // - in the log: once a side is clear, it waits for its room, while it is
  //   still current.
  // - waiting: the cursors below glide out of its way (the layout counts
  //   it now), then it shows right of its arrow, or left when another
  //   column is in the way on the right. A flyer in its way holds it up to
  //   SAY_WAIT_MAX_MS, counted from when the wait began; another column
  //   back in the way on both sides holds it again.
  const decideSay = useRef<(capNow?: boolean) => void>(() => {});
  decideSay.current = (capNow = false) => {
    const state = sayState.current;
    if (state !== 'hold' && state !== 'wait' && state !== 'log') return;
    const m = motion.current;
    if (!m) {
      if (capNow) setSay.current('right');
      return;
    }
    const z = zoomRef.current;
    const since = sayWaitSince.current;
    const capped = capNow || (since !== null && performance.now() - since > SAY_WAIT_MAX_MS);
    if (state === 'hold' && capHold.current) {
      // A moving cursor is still in the way here: the loose check below
      // would send it back to waiting each frame, and the cap would start
      // over, every SAY_WAIT_MAX_MS while the cursor kept moving.
      if (!field.sayRoom(cursor.key, 'right', m.pos, z, true).foreign) setSay.current('right');
      else if (!field.sayRoom(cursor.key, 'left', m.pos, z, true).foreign) setSay.current('left');
      else if (capped) setSay.current('log');
      return;
    }
    const right = field.sayRoom(cursor.key, 'right', m.pos, z);
    const left = right.foreign ? field.sayRoom(cursor.key, 'left', m.pos, z) : null;
    const blocked = right.foreign && left!.foreign;
    if (state === 'hold' || state === 'log') {
      if (blocked) {
        if (state === 'hold' && capped) setSay.current('log');
        return;
      }
      sayWaitSince.current = performance.now();
      setSay.current('wait');
      // In the same frame: with its room already clear, it shows now.
      decideSay.current(capNow || prefersReducedMotion());
      return;
    }
    if (blocked) {
      sayWaitSince.current = performance.now();
      setSay.current('hold');
      return;
    }
    if (!right.wait && !right.foreign) {
      setSay.current('right');
      return;
    }
    if (left && !left.wait) {
      setSay.current('left');
      return;
    }
    if (!capped) return;
    // Capped: it shows now, on a side where nothing is drawn, moving
    // cursors included (LOW-6); with neither side clear it holds again,
    // and from there goes to the Agent log (the cap, unchanged).
    const strictRight = field.sayRoom(cursor.key, 'right', m.pos, z, true);
    if (!strictRight.foreign) {
      setSay.current('right');
      return;
    }
    if (!field.sayRoom(cursor.key, 'left', m.pos, z, true).foreign) {
      setSay.current('left');
      return;
    }
    sayWaitSince.current = performance.now();
    setSay.current('hold');
    capHold.current = true;
  };
  // A say that replaces one still drawn: does its side still have room?
  const sayFits = useRef<() => boolean>(() => false);
  sayFits.current = () => {
    const m = motion.current;
    const side = sayState.current;
    if (!m || (side !== 'right' && side !== 'left')) return false;
    const room = field.sayRoom(cursor.key, side, m.pos, zoomRef.current);
    return !room.wait && !room.foreign;
  };

  // What the loop, the pointer and the timers read between renders.
  useLayoutEffect(() => {
    sayShownRef.current = showSay && (!idle || sayOutlastsIdle);
    idleRef.current = idle;
    // A leaving cursor keeps the peers it had as its exit began, so its
    // label keeps its layout (review 5, M1).
    if (!leaving) peersRef.current = peers;
    leavingRef.current = leaving;
    exited.current = onExited;
    // Its label block, for the cursor stacked below it (the say pill counts
    // while it is drawn, its fade out included).
    if (leaving) return;
    collapsedRef.current = collapsed;
    countingRef.current = counting;
    field.names.set(cursor.key, name);
    const sayNow = showSay && (!idle || sayOutlastsIdle) && drawsSay;
    // A folded member's say is in the Agent log only (r18 item 1); one in
    // the log keeps no room (setSay below sets it as it is drawn).
    field.setSay(cursor.key, sayNow && sayKeepsRoom(sayState.current), widths);
    if (!sayNow) {
      setSay.current('none');
    } else if (!sayWasShown.current || sayText.current !== say) {
      // A new say pill: held hidden, nothing moving, until another column
      // is out of its way; then its own column glides and it fades in.
      // Under reduced motion everything is instant: it takes its place
      // now, or the log. A say that replaces one still drawn keeps its side
      // while that side has room.
      const fresh = !sayWasShown.current;
      sayWaitSince.current = performance.now();
      if (prefersReducedMotion()) {
        setSay.current('hold');
        decideSay.current(true);
      } else if (fresh || !sayFits.current()) {
        // The loop sees it: a say comes with a new event, which re-runs the
        // loop's effect (below) and wakes it. (Waking it from here would
        // queue the old loop, which the new one then can't replace.)
        setSay.current('hold');
      }
    }
    sayWasShown.current = sayNow;
    sayText.current = sayNow ? say : null;
  });

  useLayoutEffect(() => {
    const reduced = prefersReducedMotion();
    // A cursor folded into its column's count cursor fades out where it is
    // (the count's slot), and back in when the column opens up again.
    // A new count cursor waits unseen while the one it replaces exits from
    // the same slot (review 8, MEDIUM-2).
    const opacityTarget = () => (collapsedRef.current
      || (countingRef.current && field.countExiting(cursor.key))
      ? 0 : idleRef.current ? AGENT_CURSOR_IDLE_OPACITY : 1);
    const sayPending = () => sayState.current === 'hold' || sayState.current === 'wait' || sayState.current === 'log';
    // The person's pointer in flow coordinates, or null off the canvas. The
    // pane's box is cached on the field: no layout read per frame.
    const pointerInFlow = (): Point | null => {
      const client = field.pointer;
      const dom = space.pane();
      if (!client || !dom) return null;
      const box = field.paneRect(dom);
      if (client.x < box.left || client.x > box.right || client.y < box.top || client.y > box.bottom) return null;
      return space.fromClient(client, box);
    };
    // A cursor that isn't flying sits on whole device pixels and off its own
    // compositor layer, so its pill and the pill's edge draw crisp; it is
    // promoted (will-change) only while it flies (GM - Design, PR #211 r10
    // item 1). Snapped where it is drawn, never in the motion, so nothing
    // drifts.
    const onPixels = (p: Point): Point => {
      const dom = space.pane();
      if (!dom) return p;
      const box = field.paneRect(dom);
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      return space.snap(p, box, dpr);
    };
    // The hand-off registry (lib/agentCursorHandoff.ts): where this cursor is
    // on screen and how fast, written each frame it is drawn and as its view
    // goes, for the other layer to start from if a new event moves it there.
    // `final`: the view is going. It writes under the epoch of its last drawn
    // frame, not the current one: a resting view that goes because the screen
    // under it did must not carry its point across the switch.
    writeHandoff.current = (final = false) => {
      const m = motion.current;
      const dom = space.pane();
      if (!m || !dom || leavingRef.current) return;
      const z = zoomRef.current;
      const at = space.toClient(m.pos, field.paneRect(dom));
      if (!at) return;
      if (!final) handoffEpoch.current = cursorHandoff.epoch;
      cursorHandoff.write(cursor.key, {
        layer: space.layer, at, velocity: { x: m.vel.x * z, y: m.vel.y * z }, opacity: m.opacity.x, lean: m.lean.x,
      }, handoffEpoch.current);
    };
    // A cursor parked at the edge of its panel keeps its pills inside the
    // panel and clear of the arrow and the chevron (lib/agentCursorPark.ts
    // parkLabelNudge): the label's own offset, as CSS variables. Widths are
    // the measured ones, never a layout read; a cursor that isn't parked
    // has no offset.
    let labelOffset = '';
    const placeLabel = (toward: Point | null) => {
      const el = cursorRef.current;
      const m = motion.current;
      if (!el || !m) return;
      const clip = toward !== null && !leavingRef.current && el.dataset.saySide !== 'left' ? space.labelClip?.(cursor.target, cursor.key) ?? null : null;
      let x = 0;
      let y = 0;
      if (clip) {
        const layout = el.dataset.label ?? '';
        const { angle, distance } = parkChevron(m.pos, toward!);
        const nudge = parkLabelNudge({
          origin: m.pos, clip,
          nameShown: layout.startsWith('name'), nameW: widthsRef.current.nameW,
          sayW: layout.endsWith('say') ? widthsRef.current.sayW : 0,
          chevron: { x: m.pos.x + AGENT_CURSOR_ARROW_TIP.x + Math.cos(angle) * distance, y: m.pos.y + AGENT_CURSOR_ARROW_TIP.y + Math.sin(angle) * distance },
        });
        x = nudge.x;
        y = nudge.y;
      }
      const next = `${x}px ${y}px`;
      if (next === labelOffset) return;
      labelOffset = next;
      if (x === 0 && y === 0) {
        el.style.removeProperty('--label-dx');
        el.style.removeProperty('--label-dy');
      } else {
        el.style.setProperty('--label-dx', `${x}px`);
        el.style.setProperty('--label-dy', `${y}px`);
      }
    };
    placeLabelRef.current = placeLabel;
    const apply = () => {
      const el = cursorRef.current;
      const m = motion.current;
      if (!el || !m) return;
      const flying = m.plan !== null || m.landing !== null;
      const at = flying ? m.pos : onPixels(m.pos);
      el.style.transform = `translate(${at.x}px, ${at.y}px) scale(${1 / zoomRef.current})`;
      writeHandoff.current();
      el.style.willChange = flying ? 'transform, opacity' : 'auto';
      el.style.opacity = String(Math.min(1, Math.max(0, m.opacity.x)));
      if (pointerRef.current) pointerRef.current.style.transform = m.lean.x === 0 ? '' : `rotate(${m.lean.x}deg)`;
      // The edge park's chevron: toward the item from where the tip is drawn now.
      const toward = leaving ? null : space.edgeToward?.(cursor.target, cursor.key) ?? null;
      if ((toward !== null) !== parkedRef.current) {
        parkedRef.current = toward !== null;
        setParked(toward !== null);
      }
      if (toward !== null && parkRef.current) {
        const { angle, distance } = parkChevron(m.pos, toward);
        parkRef.current.style.setProperty('--park-angle', `${angle}rad`);
        parkRef.current.style.setProperty('--park-x', `${AGENT_CURSOR_ARROW_TIP.x + Math.cos(angle) * distance}px`);
        parkRef.current.style.setProperty('--park-y', `${AGENT_CURSOR_ARROW_TIP.y + Math.sin(angle) * distance}px`);
      }
      placeLabel(toward);
      // Set outside React so a re-render never hides a placed cursor again.
      el.dataset.placed = 'true';
      // Gliding past or under the member above it: drawn under it, so the
      // one above draws on top and their labels never interleave (GM r75.2).
      // Two crossing at once keep their column's order between themselves,
      // the upper one on top, not the DOM's (GM r85 NIT): its depth is how
      // many members its slot has above it (agentCursor.css). And while any
      // member of its column glides, the whole column draws in that order
      // (GM r95). The order is worked out once for every cursor, at one
      // zoom (CursorField.syncOrder), then this one's marks are painted
      // from it.
      if (!leaving) field.syncOrder(cursor.key);
      paintMarks();
    };
    // Its marks only, from the field's state: what syncOrder repaints.
    // A flight draws over everything until it has landed and its column is
    // at rest (GM r103): no crossing and no column order show while it is
    // aloft. Crossing and column order share one band inside the cursor
    // layer, over the wires, the head on top (r106; agentCursor.css).
    const paintMarks = () => {
      const el = cursorRef.current;
      if (!el) return;
      const aloft = leaving ? null : field.aloft.get(cursor.key)?.seq ?? null;
      const crossing = aloft === null && !leaving && field.crossing.has(cursor.key);
      const ordered = aloft === null && !leaving && field.ordered.has(cursor.key);
      if (aloft !== null) {
        el.dataset.aloft = 'true';
        el.style.setProperty('--agent-cursor-aloft', String(aloft));
      } else {
        delete el.dataset.aloft;
        el.style.removeProperty('--agent-cursor-aloft');
      }
      if (crossing) el.dataset.crossing = 'true';
      else delete el.dataset.crossing;
      if (ordered) el.dataset.columnOrder = 'true';
      else delete el.dataset.columnOrder;
      if (crossing || ordered) {
        el.style.setProperty('--agent-cursor-crossing-depth', String(Math.min(AGENT_CURSOR_ORDER_DEPTHS, field.depthOf(cursor.key))));
      } else {
        el.style.removeProperty('--agent-cursor-crossing-depth');
      }
    };
    place.current = apply;
    if (!leaving) {
      field.placers.set(cursor.key, apply);
      field.markers.set(cursor.key, paintMarks);
    }
    // The drag's wire: the surface's own bezier (the canvas's is React Flow's
    // getBezierPath, as the edges draw it) from the port to an end that trails the tip on
    // the wire's lag spring, so it visibly gets pulled (§2 drag). Its width
    // is in flow units, like an edge's.
    const drawWire = (path: SVGPathElement, from: Point, to: Point) => {
      const d = space.wire?.(from, to);
      if (d !== undefined) path.setAttribute('d', d);
    };
    const updateWire = (start: Point | null, arrivedNow = false, dt = 0) => {
      const path = wireRef.current;
      const m = motion.current;
      if (!path) return;
      if (arrivedNow && start && m && dragging) {
        // The tip is at the port: the wire ends there as it fades.
        drawWire(path, start, m.pos);
      }
      if (!start || !m || phase.current !== 'travel' || !dragging) {
        path.style.opacity = '0';
        wireEnd.current = null;
        return;
      }
      const end = wireEnd.current ?? { x: start.x, y: start.y, vx: 0, vy: 0 };
      wireEnd.current = stepSpring(end, m.pos, Number.isFinite(dt) ? Math.min(dt, 0.1) : 0, AGENT_CURSOR_WIRE_SPRING);
      drawWire(path, start, wireEnd.current);
      path.style.strokeWidth = String(AGENT_CURSOR_WIRE.strokePx);
      path.style.opacity = '1';
    };
    // The cursor's own hover boxes (arrow and pills), read at most once per
    // landing, label change or viewport move, never per frame or per pointermove.
    let hoverBoxes: DOMRect[] | null = null;
    let hoverEpoch = -1;
    // Where the tip was drawn when the boxes were read: once it is more than
    // HOVER_STALE_PX off that spot (a flight, following its node, a glide,
    // a hold riding a dragged node), they are stale when it comes to rest
    // (review 2, L1). Measured, not inferred from its state: a landing the
    // column held moves by hundredths of a pixel, so it reads its boxes once
    // (review 3, layout NIT-1), but one held on a moving aim can travel far
    // while it counts as near rest (review 4, NIT F4).
    let boxesAt: Point | null = null;
    const boxesMoved = (): boolean => {
      const m = motion.current;
      return boxesAt !== null && m !== null
        && Math.hypot(m.pos.x - boxesAt.x, m.pos.y - boxesAt.y) * zoomRef.current > HOVER_STALE_PX;
    };
    // Its own rest was seen, held by the column or not (ownRest, below).
    let restNoted = false;
    let seenVisibility = field.visibilityEpoch;
    const hoverHit = (x: number, y: number): boolean => {
      if (!hoverBoxes || hoverEpoch !== field.layoutEpoch) {
        const parts = [pointerRef.current, ...(cursorRef.current?.querySelectorAll('.agent-cursor__name, .agent-cursor__say') ?? [])];
        hoverBoxes = parts.filter((part): part is Element => part !== null).map((part) => part.getBoundingClientRect());
        hoverEpoch = field.layoutEpoch;
        boxesAt = motion.current ? { ...motion.current.pos } : null;
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
      placeLabelRef.current(leaving ? null : space.edgeToward?.(cursor.target, cursor.key) ?? null);
      // The count cursor lists its names on hover (r17 item 1).
      if (hovered.current) el.dataset.hover = 'true';
      else delete el.dataset.hover;
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

    // A frame asked for now runs in the next frame (the column floor reads
    // which cursors still step in this one: field.holdBelow).
    const request = () => {
      frame.current = requestAnimationFrame(tick);
      field.dueAt.set(cursor.key, field.frameTime);
    };
    // The other layer's hand-off, as this space's motion at the viewport as
    // it is now (mid-zoom safe), or null.
    const handedOff = (z: number): CursorMotion | null => {
      const dom = space.pane();
      const entry = dom ? cursorHandoff.take(cursor.key, space.layer) : null;
      const at = entry ? space.fromClient(entry.at, field.paneRect(dom!)) : null;
      if (!entry || !at) return null;
      const m = createMotion(at, entry.opacity);
      m.vel = { x: entry.velocity.x / z, y: entry.velocity.y / z };
      m.lean = { x: entry.lean, v: 0 };
      return m;
    };
    const tick = (time: number, carried = false) => {
      frame.current = null;
      field.dueAt.delete(cursor.key);
      // A frame's own timestamp is the frame, even one behind a time a
      // carry stepped at: frameTime never stays ahead of it, so hold() and
      // holdBelow() still tell this frame's steps from the last one's
      // (review 5, NIT-2). A carry steps at the frame's time, or a glide's
      // own last one, and never moves it.
      if (!carried) field.frameTime = time;
      if (leavingRef.current) {
        // Its exit: no events, no place in the stack, no hover; it fades out
        // where it is, then it's forgotten.
        const m = motion.current;
        const exitDt = lastTime.current === null ? 1 / 60 : (time - lastTime.current) / 1000;
        lastTime.current = time;
        if (!m || stepExit(m, exitDt)) {
          apply();
          lastTime.current = null;
          if (field.exitingCounts.delete(cursor.key)) field.wakeAll();
          cursorHandoff.forget(cursor.key);
          exited.current?.(cursor.key);
          return;
        }
        apply();
        updateWire(null);
        request();
        return;
      }
      const resolved = space.resolve(cursor.target, cursor.key);
      const start = dragging && cursor.from ? space.resolve(cursor.from, `${cursor.key}>from`) : null;
      if (!resolved) {
        // Its node deleted mid-drag: that drag ends here (field.nodeGone).
        if ('nodeId' in cursor.target) field.nodeGone(cursor.target.nodeId);
        if (motion.current && !field.stalled.has(cursor.key)) {
          // Its loop stops where it is (its node gone mid-glide or
          // mid-flight): no crossing, column order or place on top outlives
          // it, and its column's order ends now if it was the one gliding
          // (#219 review 6, NIT-1).
          field.stalled.add(cursor.key);
          field.snapped(cursor.key);
          apply();
        }
        return; // Node not drawn yet; the store subscription wakes us.
      }
      // Back on a drawn node (an undo): its loop runs again.
      field.stalled.delete(cursor.key);
      // The zoom this frame, from the store: a zoom in progress carries the
      // column at its screen-px steps on this very frame (review 6, item 5).
      const z = space.zoom() ?? zoomRef.current;
      zoomRef.current = z;
      const nodeId = 'nodeId' in cursor.target ? cursor.target.nodeId : null;
      const nodeState = nodeId !== null ? space.nodeInfo(nodeId) : undefined;
      const nodeAt = nodeState?.at ?? null;
      const nodeDragged = nodeState?.dragging ?? false;
      field.report(cursor.key, resolved, z, nodeId, cursor.seq, nodeAt && { x: nodeAt.x, y: nodeAt.y }, arrivedRef.current, knownRef.current, nodeDragged,
        space.chainPoint(cursor.target, cursor.key) ?? resolved);
      const laid = field.layout(z).get(cursor.key);
      const target = laid?.at ?? resolved;
      // Its layout changed (a say, a join, a leave), or a member above it
      // moved by an event of its own (its head nudged its target): it glides
      // to the new spot, held under the member above as that one is drawn
      // (field.hold). Anything else moving the spot (a zoom, a node carried,
      // the column's head carried) carries it there on this frame (review 7,
      // MEDIUM-1).
      const revs = laid ? laid.above.map((k) => field.revOf(k)).join(',') : '';
      const shifted = laid !== undefined && layoutSig.current !== null
        && (laid.sig !== layoutSig.current || revs !== layoutRevs.current);
      if (laid) {
        layoutSig.current = laid.sig;
        layoutRevs.current = revs;
      }
      // Folded into a full column's count cursor, or that count cursor: a
      // render only when that changes, never per frame.
      const into = laid?.collapsedInto ?? null;
      const group = laid?.group && laid.group.length > 1 ? laid.group : null;
      const nextFold = into ? `>${into}` : group ? group.join(',') : '';
      if (nextFold !== foldKey.current) {
        foldKey.current = nextFold;
        collapsedRef.current = into !== null;
        countingRef.current = group !== null;
        setFold({ into, group });
      }
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
        cursorHandoff.claim(cursor.key, space.layer);
        const m = motion.current;
        // Back mid-exit: it is put on its spot, and the fade reverses on the
        // same spring from where it is.
        const fading = !reduced && m.opacity.x < opacityTarget() - 0.01 ? { ...m.opacity } : null;
        stepMotion(m, target, 0, { zoom: z, reduced: true, opacityTarget: opacityTarget() });
        if (fading) m.opacity = fading;
        field.landed(cursor.key);
        field.snapped(cursor.key);
        firstSightAt.current = performance.now();
        if (sayHoldRef.current !== null && ageMs >= sayHoldRef.current) setSayDoneSeq(cursor.seq);
        // Landed with no flight to show: a held state shows as it is, no gesture plays.
        arrive.current(false);
        window.setTimeout(() => updateLabel.current(), AGENT_CURSOR_NAME_FIRST_SIGHT_MS + 20);
        lastTime.current = null;
        apply();
        // The members under it judged against where it is now: a mark one
        // of them carries at rest (r89) has no frame of its own to end on
        // (review 5, LOW-1 and LOW-2).
        field.steppedAt.set(cursor.key, time);
        field.holdBelow(cursor.key, z, time);
        updateWire(null);
        field.invalidateLayout();
        updateLabel.current();
        onPointer();
        // Still fading back in, or a new say waiting for room: on next frame.
        decideSay.current();
        if (fading || sayPending()) request();
        return;
      }

      if (!motion.current) {
        // First sighting. Handed off from the other layer a moment ago (a new
        // event moved it from the canvas to a panel, or back): it goes on from
        // where that layer drew it, at its speed, opacity and lean: one cursor
        // travelling, no jump and no fade. A reduced-motion hand-off is a snap.
        const handed = reduced ? null : handedOff(z);
        // Otherwise in from 64 px back along the line to its first target.
        motion.current = reduced
          ? createMotion(target, opacityTarget())
          : handed ?? createMotion(entranceStart(goal, start ? { from: start, to: target } : null, z), 0);
        field.motions.set(cursor.key, motion.current);
        cursorHandoff.claim(cursor.key, space.layer);
        // A hand-off lands like any first arrival: the name hides while it
        // flies and shows for its first-sight moment where it rests, so the
        // rest is the one the reduced-motion snap draws (GM r136, ruling 2).
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
      const anchor = 'nodeId' in cursor.target ? space.nodeInfo(cursor.target.nodeId) : undefined;
      // On a surface with no nodes (the screen layer) a resting cursor's item
      // moving under it (the person scrolled the list, a panel resized) is
      // theirs: it rides at any distance, never a flight. A new element, or
      // one the cursor is still flying to, is not (space.carried).
      const dragged = (goal === target && anchor !== undefined && 'nodeId' in cursor.target
        && (Boolean(anchor.dragging) || placedByPerson(cursor.target.nodeId, anchor.position)))
        || (goal === target && !m.plan && !m.landing && space.carried?.(cursor.target, cursor.key) === true);
      const restAt = onPixels(goal);
      const restOffset = { x: restAt.x - goal.x, y: restAt.y - goal.y };
      const restGate = field.restGate(cursor.key, z, time);
      const result = stepMotion(m, goal, dt, { zoom: z, reduced, opacityTarget: opacityTarget(), pointer, carrier, dragged, restOffset, shifted, restGate });
      let arrivedNow = false;

      if (result.caughtUp) {
        // The tab was hidden, throttled or stalled mid-move: the tip lands,
        // and that's all. No ring, no wire, nothing shown as if it were now
        // (GM - Design, PR #211 r5; review 2, M1).
        phase.current = 'rest';
        field.snapped(cursor.key);
        apply();
        // And the members under it, as on any frame: one marked crossing at
        // rest (r89) ends its mark here, with no frame of its own to do it
        // (review 5, LOW-1 and LOW-2).
        field.steppedAt.set(cursor.key, time);
        field.holdBelow(cursor.key, z, time);
        updateWire(null);
        field.landed(cursor.key);
        arrive.current(false);
        updateLabel.current();
        lastTime.current = null;
        hoverBoxes = null;
        onPointer();
        decideSay.current();
        if (sayPending()) request();
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
        // Its expression begins here (§2: the action fires at the tip).
        arrive.current(true);
        field.landed(cursor.key);
        // No layout invalidation here: nothing else moved, and this
        // cursor's own hover boxes go when it comes to rest (boxesMoved).
      }
      // The column floor: held under the member above as it is drawn now,
      // and the members under this one held under it, in this frame.
      field.hold(cursor.key, z);
      field.steppedAt.set(cursor.key, time);
      apply();
      field.holdBelow(cursor.key, z, time);
      updateWire(start, arrivedNow, dt);
      updateLabel.current();
      decideSay.current();

      // Its own rest, though the column's rest gate may hold its landing
      // (r66): what shows on a landing doesn't wait for the hold. A pointer
      // still over where it came to rest hovers it now (within the rest
      // distance of its spot), not when the column lands.
      const ownRest = result.atRest || (m.landing !== null && !m.plan && m.nearRest === true);
      if (phase.current === 'rest' && ownRest && !restNoted) {
        restNoted = true;
        if (boxesMoved()) hoverBoxes = null;
        onPointer();
      }
      if (!ownRest) restNoted = false;

      if (phase.current === 'rest' && result.atRest && !sayPending()) {
        lastTime.current = null;
        field.landed(cursor.key);
        if (boxesMoved()) hoverBoxes = null;
        onPointer(); // landed under a still pointer, or flew out from under it
        return; // At rest: sleep until the canvas, an event or a timer changes.
      }
      request();
    };

    wake.current = () => {
      if (frame.current === null) request();
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
    let seenZoom = space.zoom();
    const unsubscribe = space.subscribe(() => {
      const zoomNow = space.zoom();
      const zoomed = zoomNow !== seenZoom;
      seenZoom = zoomNow;
      if (zoomed && !leavingRef.current && motion.current) {
        // At rest, or mid-glide (review 7, MEDIUM-3): moved now, at this
        // zoom. A glide steps no time here (its frame's own time is spent
        // already), so only the zoom moves it; its next frame runs as usual.
        const resting = frame.current === null && phase.current === 'rest';
        // Woken by an event and not stepped since (its frame still to
        // come): no clock of its own yet, like one at rest. The carry steps
        // it at the frame it happens in, and its first frame counts one
        // frame's step from there, not from the carry's time: that can be
        // seconds old when every cursor rested (no frame ran), and the gap
        // read as a stall would land it with no flight and no ring (#219
        // review 5, MEDIUM-1).
        const fresh = resting || lastTime.current === null;
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        field.dueAt.delete(cursor.key);
        // Woken and not stepped yet, it steps no time here either: its
        // clock is the carry's for this one step, so each zoom update
        // before its first frame moves it by the zoom alone, never by a
        // frame's travel each (N updates were N frames at once: #219
        // review 6, LOW-2). One at rest steps as before.
        if (fresh && !resting) lastTime.current = field.carryTime();
        tick(fresh ? field.carryTime() : lastTime.current!, true);
        // The next frame's step counts from that frame, not from now.
        if (fresh) lastTime.current = null;
        return;
      }
      wake.current();
    });
    return () => {
      unsubscribe();
      field.pointerListeners.delete(onPointer);
      if (field.placers.get(cursor.key) === apply) field.placers.delete(cursor.key);
      if (field.markers.get(cursor.key) === paintMarks) field.markers.delete(cursor.key);
      field.dueAt.delete(cursor.key);
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [cursor.seq, cursor.key, cursor.target, cursor.from, cursor.receivedAt, cursor.replayed, dragging, leaving, space, field]);

  // A cursor leaves the stack as its exit starts, so it isn't counted for
  // de-stacking while it fades: the cleanup below runs as `leaving` turns
  // true (and when a live cursor unmounts). A leaving view claims nothing.
  useEffect(() => {
    if (leaving) return undefined;
    field.claim(cursor.key);
    return () => {
      field.release(cursor.key);
      space.forget?.(cursor.key);
    };
  }, [field, space, cursor.key, leaving]);
  // An unmounted cursor stops for good: another cursor leaving in the same
  // commit wakes it (forget), and a tick run after its cleanup would stamp
  // its old spot again, a ghost that pushes the next cursor there aside
  // (live, after a backend restart's empty replay).
  useLayoutEffect(() => () => writeHandoff.current(true), []);
  // Held for the other layer: its entry for the cursor is written as it goes
  // to hold, so the receiving layer's first frame still carries it on.
  useLayoutEffect(() => {
    // Unless the other layer has already drawn it: its frames are the truth now.
    if (held && cursorHandoff.claimedBy(cursor.key) !== otherLayer(space.layer)) writeHandoff.current(true);
  }, [held, cursor.key, space.layer]);
  useEffect(() => () => {
    wake.current = () => {};
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  // Idle dims on the fade spring, and the say pill's own timers change the
  // label. A member unfolding from its count cursor (no new event) may now
  // draw a say still current: the loop finds it its room (r18 item 1).
  useEffect(() => {
    wake.current();
  }, [idle, drawsSay]);
  // A new backend arrival with no new event (a node move carried it,
  // agentPresenceArrival): the loop reads it and takes its new place.
  useEffect(() => {
    wake.current();
  }, [cursor.arrivedAt, cursor.arrivalKnown]);
  // A count cursor on its way out holds its slot until it is gone (its exit
  // ends in the loop, above), or until it comes back.
  const exitGroup = leaving && counting ? shownFold.group : null;
  useLayoutEffect(() => {
    if (!exitGroup) return undefined;
    field.exitingCounts.set(cursor.key, exitGroup);
    return () => {
      if (field.exitingCounts.delete(cursor.key)) field.wakeAll();
    };
  }, [exitGroup, field, cursor.key]);
  useLayoutEffect(() => {
    updateLabel.current();
  });

  useEffect(() => {
    zoomRef.current = zoom;
    place.current();
  }, [zoom]);
  // The chevron just mounted: it is placed now, not on the next frame.
  useLayoutEffect(() => {
    if (parked) place.current();
  }, [parked]);

  // The expression as drawn (§2). Under reduced motion each state is a
  // still frame (§3): no sweep, breath, press, ring or shake.
  const still = prefersReducedMotion();
  const fx = leaving || collapsed ? null : expressed.action;
  const playing = expressed.gesture && !still;
  const gestureKey = expr?.startedAt ?? 0;
  const typeNode = 'nodeId' in cursor.target ? cursor.target.nodeId : null;
  const fieldShown = fx === 'type' && sayInfo.field !== null && typeNode !== null && onScreen(sayInfo.field);
  const sayCaret = fx === 'type' && !fieldShown;
  // type with no field mark and no say pill to end (a count cursor, a say
  // whose hold is over, a field off screen with no say): the caret sits on the
  // cursor itself, beside the tip, so the state never shows nothing.
  const sayPillShown = showSay && (!idle || sayOutlastsIdle) && drawsSay;
  const tipCaret = sayCaret && !sayPillShown;
  return (
    <>
      <svg className="agent-cursor__wire-layer" aria-hidden="true">
        <path ref={wireRef} className="agent-cursor__wire" stroke={fill} fill="none" />
      </svg>
      {fieldShown && (
        <div className="agent-cursor__field-layer" style={{ ['--agent-color' as string]: fill }}>
          <FieldMark space={space} field={sayInfo.field!} nodeId={typeNode!} blinking={expressed.blinking} keystrokeAt={expr?.keystrokeAt ?? 0} />
        </div>
      )}
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
        data-count={counting ? shownFold.group!.length : undefined}
        data-collapsed={collapsed ? 'true' : undefined}
        data-expr={fx ?? undefined}
        data-gesture={fx && playing ? 'true' : undefined}
        data-still={fx && still ? 'true' : undefined}
        role={leaving || collapsed ? undefined : 'status'}
        aria-hidden={leaving || collapsed ? true : undefined}
        aria-label={leaving || collapsed ? undefined : counting
          ? `${countText}: ${countNames.join(', ')}`
          : `${name}${cursor.say ? `: ${cursor.say}` : ''}`}
      >
        <svg ref={pointerRef} className="agent-cursor__pointer" width="20" height="22" viewBox="0 0 20 22" aria-hidden="true">
          <defs>
            <filter id={haloId} x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation={AGENT_CURSOR_HALO.blur} />
            </filter>
          </defs>
          {/* One sideways shake (error), then the press (click, a drag's arrival): each remounts per gesture. */}
          <g key={`shake-${gestureKey}`} className={fx === 'error' && playing ? 'agent-cursor__shake agent-cursor__fx' : undefined}>
            <g className={(fx === 'click' || fx === 'drag') && playing ? 'agent-cursor__press' : undefined}>
              {/* The halo in place of a drop shadow (§1): the state surface. */}
              <path className="agent-cursor__halo" d={AGENT_CURSOR_ARROW_PATH} filter={`url(#${haloId})`} />
              {fx === 'error' && (playing || still) && (
                <path className="agent-cursor__danger" d={AGENT_CURSOR_ARROW_PATH} filter={`url(#${haloId})`} />
              )}
              {(fx === 'propose' || fx === 'wait') && (
                <path className="agent-cursor__dashed" d={AGENT_CURSOR_ARROW_PATH} transform={DASHED_GROW} vectorEffect="non-scaling-stroke" />
              )}
              {fx === 'look' && playing && (
                <circle className="agent-cursor__sweep agent-cursor__fx" cx={ARROW_MIDDLE.x} cy={ARROW_MIDDLE.y}
                  r={AGENT_CURSOR_LOOK.radiusPx} pathLength={360} strokeDasharray={arcDash(AGENT_CURSOR_LOOK.arcDeg)}
                  filter={`url(#${haloId})`} />
              )}
              {fx === 'run' && (
                <circle className={`agent-cursor__orbit${playing ? ' agent-cursor__fx' : ''}`} cx={ARROW_MIDDLE.x} cy={ARROW_MIDDLE.y}
                  r={AGENT_CURSOR_RUN.radiusPx} pathLength={360}
                  strokeDasharray={still ? undefined : arcDash(AGENT_CURSOR_RUN.arcDeg)} />
              )}
              <path className="agent-cursor__arrow" d={AGENT_CURSOR_ARROW_PATH} />
            </g>
          </g>
          {(fx === 'click' || fx === 'drag') && playing && (
            <circle key={`ring-${gestureKey}`} className="agent-cursor__ring agent-cursor__fx" cx={1.5} cy={1.5} r={AGENT_CURSOR_CLICK.ringFromPx} />
          )}
        </svg>
        {parked && !collapsed && !leaving && (
          <svg ref={parkRef} className="agent-cursor__park-chevron" width={PARK_CHEVRON_PX} height={PARK_CHEVRON_PX}
            viewBox="0 0 6 6" aria-hidden="true">
            <path d="M1.5 0.75 L4.25 3 L1.5 5.25" />
          </svg>
        )}
        {tipCaret && <span className="agent-cursor__tip-caret" data-blink={expressed.blinking ? 'true' : undefined} aria-hidden="true" />}
        {(fx === 'propose' || fx === 'wait') && (
          <span className={`agent-cursor__mark agent-cursor__mark--${fx}`} aria-hidden="true">
            {fx === 'propose' && <Check size={8} strokeWidth={3} aria-hidden="true" />}
            {fx === 'wait' && <StickyNote size={8} strokeWidth={2.5} aria-hidden="true" />}
          </span>
        )}
        <div className="agent-cursor__label">
          {counting ? (
            <>
              <span className="agent-cursor__name">{countText}</span>
              {/* Its names on hover, up to three, then how many more (r17 item 1). */}
              <span className="agent-cursor__list" aria-hidden="true">
                {countNames.slice(0, COUNT_LIST_NAMES).map((member, i) => (
                  <span key={i} className="agent-cursor__list-name"><bdi>{member}</bdi></span>
                ))}
                {countNames.length > COUNT_LIST_NAMES && (
                  <span className="agent-cursor__list-name">{countLabel(countNames.length - COUNT_LIST_NAMES)}</span>
                )}
              </span>
            </>
          ) : (
            /* The agent's name isolated, so a right-to-left name keeps " · 2" after it. */
            <span className="agent-cursor__name"><bdi>{cursor.name}</bdi>{name.slice(cursor.name.length)}</span>
          )}
          {sayPillShown && (
            <span className={`agent-cursor__say${sayLeaving ? ' agent-cursor__say--leaving' : ''}`}>
              {say}
              {/* type with its field off screen: the caret ends the say pill (§2). */}
              {sayCaret && <span className="agent-cursor__say-caret" data-blink={expressed.blinking ? 'true' : undefined} aria-hidden="true" />}
            </span>
          )}
        </div>
      </div>
    </>
  );
}


const PRUNE_INTERVAL_MS = 5_000;

const otherLayer = (layer: CursorLayer): CursorLayer => (layer === 'canvas' ? 'screen' : 'canvas');

/** What a layer's own marks (the screen layer's item outlines) read of the
 *  column field: which cursors have landed, and when one first does. */
export interface CursorLandings {
  readonly targets: ReadonlyMap<string, { since: number }>;
  readonly landedListeners: Set<(key: string) => void>;
}

/**
 * The cursors of one surface, drawn into one `.agent-cursor-layer` (Phase 3,
 * "Anywhere"): the exit fades, the pill fonts, the prune, the pointer, the
 * column field and every cursor's view, over whichever `CursorSpace` the
 * caller reads. The canvas layer (components/canvas/AgentCursorLayer.tsx)
 * gives it React Flow's space and puts the layer in the viewport (`inLayer`);
 * the screen layer (AgentScreenLayer.tsx) the DOM's, in a fixed box, with its
 * item outlines drawn `beside` the cursors. Draws nothing while there is
 * nothing to draw.
 */
export function AgentCursorSurface({ agents, everyone, space, zoom, layerClass = 'agent-cursor-layer', inLayer, beside }: {
  /** The cursors this surface draws (already filtered by layerOf). */
  agents: Record<string, AgentCursor>;
  /** Every cursor in the presence store. One in it that this surface no
   *  longer draws was handed to the other layer, not removed: it leaves with
   *  no exit fade (the other layer carries on from where it was). */
  everyone: Record<string, AgentCursor>;
  space: CursorSpace;
  zoom: number;
  layerClass?: string;
  /** Where the cursor layer goes (the canvas's viewport portal). */
  inLayer?: (layer: ReactElement) => ReactNode;
  /** Marks drawn beside the cursors, under them. */
  beside?: (field: CursorLandings) => ReactNode;
}) {
  const prune = useAgentPresenceStore((s) => s.prune);
  // One zoom for the draw order, the space's, read when it is worked out
  // (CursorField.syncOrder).
  const [field] = useState(() => new CursorField(() => space.zoom() ?? 1));
  useEffect(() => () => field.dispose(), [field]);
  // Fonts that finish loading can widen a pill measured with the fallback:
  // every cursor measures again (review 7, MEDIUM-4).
  const [fontVersion, setFontVersion] = useState(0);
  useEffect(() => {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || typeof fonts.addEventListener !== 'function') return undefined;
    const onLoaded = () => setFontVersion((v) => v + 1);
    fonts.addEventListener('loadingdone', onLoaded);
    return () => fonts.removeEventListener('loadingdone', onLoaded);
  }, []);

  // The presence exit (GM - Design, PR #211 review 4): a cursor the store
  // drops (a prune, a number taken over, a demoted tab, a refused hello, a
  // forgotten token) stays drawn for one fade, from its last event. Under
  // reduced motion it goes at once. The same key coming back ends its exit.
  const [shown, setShown] = useState(() => ({
    agents, leaving: {} as Record<string, AgentCursor>, held: {} as Record<string, AgentCursor>,
  }));
  let leaving = shown.leaving;
  let held = shown.held;
  if (shown.agents !== agents) {
    const next: Record<string, AgentCursor> = {};
    const nextHeld: Record<string, AgentCursor> = {};
    const fade = !prefersReducedMotion();
    // Handed to the other layer (still in the store): no exit fade, but only
    // once that layer has drawn it. Until then this one holds the last spot
    // (GM - Design 6): a layer that can't resolve it yet (the anchor isn't
    // there, its chunk hasn't loaded) would otherwise leave nothing on screen.
    const handedOver = (key: string) => key in everyone;
    const claimed = (key: string) => cursorHandoff.claimedBy(key) === otherLayer(space.layer);
    for (const [key, cursor] of Object.entries(shown.leaving)) if (!(key in agents) && !handedOver(key)) next[key] = cursor;
    for (const [key, cursor] of Object.entries({ ...shown.agents, ...shown.held })) {
      if (key in agents) continue;
      if (handedOver(key)) {
        if (!claimed(key)) nextHeld[key] = cursor;
      } else if (fade) next[key] = cursor;
    }
    leaving = next;
    held = nextHeld;
    setShown({ agents, leaving: next, held: nextHeld });
  }
  // The other layer drew a cursor this one holds: it is theirs now.
  useEffect(() => cursorHandoff.onClaim(() => setShown((state) => {
    const rest = Object.fromEntries(Object.entries(state.held)
      .filter(([key]) => cursorHandoff.claimedBy(key) !== otherLayer(space.layer)));
    return Object.keys(rest).length === Object.keys(state.held).length ? state : { ...state, held: rest };
  })), [space.layer]);
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
  useEffect(() => {
    let view = space.viewKey();
    const unsubscribe = space.subscribe(() => {
      const now = space.viewKey();
      if (now !== view) {
        view = now;
        field.invalidateLayout();
      }
    });
    const dom = space.pane();
    const observer = dom && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => field.invalidateLayout()) : null;
    if (dom) observer?.observe(dom);
    window.addEventListener('resize', field.invalidateLayout);
    return () => {
      unsubscribe();
      observer?.disconnect();
      window.removeEventListener('resize', field.invalidateLayout);
    };
  }, [space, field]);

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
  const holding = Object.values(held);
  if (cursors.length === 0 && exiting.length === 0 && holding.length === 0) return null;
  const byKey = new Map(cursors.map((cursor) => [cursor.key, cursor]));
  const names = new Set(cursors.map((cursor) => cursorLabel(cursor.name, cursor.session)));
  // One list, so a cursor coming back mid-exit keeps its view. Leaving
  // cursors paint under every live one; the most recently active paints on top.
  const views = [
    ...paintOrder(exiting).map((key) => ({ cursor: leaving[key], leaving: true, held: false })),
    ...paintOrder(holding).map((key) => ({ cursor: held[key], leaving: false, held: true })),
    ...paintOrder(cursors).map((key) => ({ cursor: byKey.get(key)!, leaving: false, held: false })),
  ];
  const layer = (
    <div className={layerClass} style={cursorSpringVars()}>
      {views.map(({ cursor, leaving: out, held: holds }) => (
        <AgentCursorView
          key={cursor.key}
          space={space}
          cursor={cursor}
          zoom={zoom}
          peers={cursors.length}
          field={field}
          fontVersion={fontVersion}
          leaving={out}
          held={holds}
          nameTaken={out && names.has(cursorLabel(cursor.name, cursor.session))}
          onExited={onExited}
        />
      ))}
    </div>
  );
  return (
    <>
      {beside?.(field)}
      {inLayer ? inLayer(layer) : layer}
    </>
  );
}
