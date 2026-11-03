/**
 * What an agent cursor expresses, and for how long (GM - Design's cursor
 * spec, §2): the state machine behind the halo, the press and ring, the
 * shake, the caret and the mark slot. Pure, with no React and no DOM, so
 * each rule is tested on its own (tests/agentCursorExpression.test.ts).
 *
 * - Held states (look, think, type, propose, wait) show from the cursor's
 *   arrival until the agent's next event. look, think and type also end when
 *   the cursor goes idle; propose and wait wait for the person.
 * - Gestures (click, drag's arrival, run, error) play once from arrival.
 *   look's sweep is a gesture inside its held state.
 * - A new action with a look of its own replaces the current one at once.
 *   A bare move (or an action this tab doesn't know) doesn't cut a held
 *   state shorter than AGENT_CURSOR_MIN_HOLD_MS, so a short tool call still
 *   registers.
 * - The same held action again (think, then think) carries on: no restart
 *   of the breath, and for type the new event is a keystroke.
 * - type's caret stays AGENT_CURSOR_TYPE.lingerMs after its state ends.
 * - A landing nobody watched (a hidden tab, a replay) plays no gesture: a
 *   held state shows as it is, a gesture shows nothing.
 */
import type { AgentCursorAction } from './agentPresenceActions';
import {
  AGENT_CURSOR_ERROR,
  AGENT_CURSOR_LOOK,
  AGENT_CURSOR_MIN_HOLD_MS,
  AGENT_CURSOR_PRESS_SPRING,
  AGENT_CURSOR_RING_SPRING,
  AGENT_CURSOR_RUN,
  AGENT_CURSOR_SHAKE_SPRING,
  AGENT_CURSOR_THINK_SPRING,
  AGENT_CURSOR_TYPE,
  type TuningSpring,
} from './agentCursorTuning';

export type HeldAction = 'look' | 'think' | 'type' | 'propose' | 'wait';
export type GestureAction = 'click' | 'drag' | 'run' | 'error';
export type ExpressiveAction = HeldAction | GestureAction;

const HELD: ReadonlySet<AgentCursorAction> = new Set<AgentCursorAction>(['look', 'think', 'type', 'propose', 'wait']);
const GESTURE: ReadonlySet<AgentCursorAction> = new Set<AgentCursorAction>(['click', 'drag', 'run', 'error']);
/** Held states that end when the cursor goes idle: the agent stopped. */
const ENDS_ON_IDLE: ReadonlySet<AgentCursorAction> = new Set<AgentCursorAction>(['look', 'think', 'type']);

export const isHeld = (action: AgentCursorAction): action is HeldAction => HELD.has(action);
export const isGesture = (action: AgentCursorAction): action is GestureAction => GESTURE.has(action);
/** Whether an action draws anything of its own (move and unknown actions don't). */
export const isExpressive = (action: AgentCursorAction): action is ExpressiveAction => HELD.has(action) || GESTURE.has(action);

export interface Expression {
  action: ExpressiveAction;
  /** The event that started it. */
  seq: number;
  /** When it began: the cursor's arrival (ms, performance clock). */
  startedAt: number;
  /** When it ends (or ended), or null while it holds. */
  endsAt: number | null;
  /** Whether its gesture plays (false for a landing nobody watched). */
  gesture: boolean;
  /** type: the last keystroke (the event itself, or the field's text changing). */
  keystrokeAt: number;
}

/** The frame an expression shows at a moment. */
export interface ExpressionFrame {
  /** What shows, or null for nothing (the plain halo). */
  action: ExpressiveAction | null;
  /** A gesture is playing now (look's sweep, click, drag's arrival, run, error). */
  gesture: boolean;
  /** type: text is arriving, so the caret blinks; else it is solid. */
  blinking: boolean;
  /** type: the state ended and the caret is in its last AGENT_CURSOR_TYPE.lingerMs. */
  lingering: boolean;
}

const NOTHING: ExpressionFrame = { action: null, gesture: false, blinking: false, lingering: false };

/** How long each gesture plays from arrival (ms). */
export function gestureMs(action: GestureAction | 'look'): number {
  switch (action) {
    case 'look': return AGENT_CURSOR_LOOK.sweepMs;
    case 'run': return AGENT_CURSOR_RUN.orbitMs;
    case 'error': return Math.max(AGENT_CURSOR_ERROR.flashMs, impulseCurve(AGENT_CURSOR_SHAKE_SPRING).durationMs);
    // click, and drag's arrival, which "ripples as click".
    default: return Math.max(springSettleMs(AGENT_CURSOR_RING_SPRING), impulseCurve(AGENT_CURSOR_PRESS_SPRING).durationMs);
  }
}

/**
 * A new event, before its cursor arrives: what happens to the current
 * expression. A look of its own replaces it at once; a bare move holds a
 * held state to its minimum; anything else is left alone.
 */
export function onEvent(current: Expression | null, action: AgentCursorAction, now: number): Expression | null {
  if (!current) return null;
  if (current.endsAt !== null && current.endsAt <= now) return current;
  if (isExpressive(action)) {
    // The same held action carries on until its own arrival (onArrival).
    if (action === current.action && isHeld(action)) return current;
    return { ...current, endsAt: now };
  }
  if (isHeld(current.action)) {
    const held = Math.max(now, current.startedAt + AGENT_CURSOR_MIN_HOLD_MS);
    return { ...current, endsAt: current.endsAt === null ? held : Math.min(current.endsAt, held) };
  }
  return current; // a gesture plays out
}

/**
 * The cursor arrived for event `seq` (or landed with no flight to show,
 * `watched` false): its action's expression begins.
 */
export function onArrival(
  current: Expression | null,
  action: AgentCursorAction,
  seq: number,
  now: number,
  watched = true,
): Expression | null {
  if (!isExpressive(action)) return current;
  if (current && current.action === action && isHeld(action) && current.seq !== seq
    && (current.endsAt === null || current.endsAt > now)) {
    // The same held state again: it carries on; a type event is a keystroke.
    return { ...current, seq, endsAt: null, keystrokeAt: now };
  }
  if (!watched && isGesture(action)) return null;
  return { action, seq, startedAt: now, endsAt: null, gesture: watched, keystrokeAt: now };
}

/** The field's text changed while typing: a keystroke. */
export function onKeystroke(current: Expression | null, now: number): Expression | null {
  if (!current || current.action !== 'type') return current;
  if (current.endsAt !== null && current.endsAt <= now) return current;
  return { ...current, keystrokeAt: now };
}

/** When a held state stops holding: its end, or the idle moment for those that end on idle. */
function heldEnd(e: Expression, idleAt: number | null): number | null {
  const idle = idleAt !== null && ENDS_ON_IDLE.has(e.action) ? Math.max(idleAt, e.startedAt + AGENT_CURSOR_MIN_HOLD_MS) : null;
  if (e.endsAt === null) return idle;
  return idle === null ? e.endsAt : Math.min(e.endsAt, idle);
}

/** What shows at `now`. `idleAt` is when the cursor went (or goes) idle. */
export function frameAt(e: Expression | null, now: number, idleAt: number | null = null): ExpressionFrame {
  if (!e || now < e.startedAt) return NOTHING;
  if (isGesture(e.action)) {
    const done = e.startedAt + gestureMs(e.action);
    if (!e.gesture || now >= done || (e.endsAt !== null && now >= e.endsAt)) return NOTHING;
    return { action: e.action, gesture: true, blinking: false, lingering: false };
  }
  const end = heldEnd(e, idleAt);
  if (end !== null && now >= end) {
    if (e.action === 'type' && now < end + AGENT_CURSOR_TYPE.lingerMs) {
      return { action: 'type', gesture: false, blinking: false, lingering: true };
    }
    return NOTHING;
  }
  const sweeping = e.action === 'look' && e.gesture && now < e.startedAt + AGENT_CURSOR_LOOK.sweepMs;
  const blinking = e.action === 'type' && now - e.keystrokeAt < AGENT_CURSOR_TYPE.blinkMs;
  return { action: e.action, gesture: sweeping, blinking, lingering: false };
}

/** The next moment the frame can change by itself (a timer for the view), or null. */
export function nextChangeAt(e: Expression | null, now: number, idleAt: number | null = null): number | null {
  if (!e) return null;
  const times: number[] = [e.startedAt];
  if (isGesture(e.action)) {
    times.push(e.startedAt + gestureMs(e.action));
    if (e.endsAt !== null) times.push(e.endsAt);
  } else {
    const end = heldEnd(e, idleAt);
    if (end !== null) times.push(end, end + AGENT_CURSOR_TYPE.lingerMs);
    if (e.action === 'look') times.push(e.startedAt + AGENT_CURSOR_LOOK.sweepMs);
    if (e.action === 'type') times.push(e.keystrokeAt + AGENT_CURSOR_TYPE.blinkMs);
  }
  const next = times.filter((t) => t > now);
  return next.length ? Math.min(...next) : null;
}

// ── Spring curves for CSS (springs only: §3) ───────────────────────────────

/** A spring's settle time from rest to target (ms), by the repo's sampler's rule. */
export function springSettleMs({ stiffness, damping, mass }: TuningSpring): number {
  return Math.round(integrate({ stiffness, damping, mass }, 1, 0).durationMs);
}

export interface SpringCurve {
  durationMs: number;
  /** A CSS `linear()` easing. */
  easing: string;
}

const curves = new Map<string, SpringCurve>();

/**
 * A spring kicked from rest (an impulse): it leaves 0, peaks at 1 and comes
 * back to 0, with whatever overshoot its damping gives (below 0 for a
 * low-damping spring). As a CSS `linear()` easing that ends at 0, so an
 * animation `from` the rest value `to` the peak value plays one press and
 * spring back (click), or one sideways shake (error).
 */
export function impulseCurve(spring: TuningSpring): SpringCurve {
  const key = `i:${spring.stiffness}:${spring.damping}:${spring.mass}`;
  const hit = curves.get(key);
  if (hit) return hit;
  const sampled = integrate(spring, 0, 1);
  const peak = Math.max(...sampled.values.map(Math.abs)) || 1;
  const curve = { durationMs: Math.round(sampled.durationMs), easing: toLinear(sampled.values.map((v) => v / peak), 0) };
  curves.set(key, curve);
  return curve;
}

/** A spring from 0 to 1 at rest, as a CSS `linear()` easing ending on 1. */
export function stepCurve(spring: TuningSpring): SpringCurve {
  const key = `s:${spring.stiffness}:${spring.damping}:${spring.mass}`;
  const hit = curves.get(key);
  if (hit) return hit;
  const sampled = integrate(spring, 1, 0);
  const curve = { durationMs: Math.round(sampled.durationMs), easing: toLinear(sampled.values.map((v) => 1 - v), 1) };
  curves.set(key, curve);
  return curve;
}

/** The breath's half-loop curve (think), a stepCurve. */
export const thinkCurve = (): SpringCurve => stepCurve(AGENT_CURSOR_THINK_SPRING);

const SAMPLE_MS = 1000 / 120;
const SETTLE = 0.001;
const MAX_MS = 4000;

/** x'' = (-k x - c v) / m from (x0, v0), sampled every 1/120 s until it
 *  stays within SETTLE of 0 (and of its start's scale), at most 4 s. */
function integrate({ stiffness, damping, mass }: TuningSpring, x0: number, v0: number): { values: number[]; durationMs: number } {
  const h = 1 / 1200; // ten substeps per sample
  let x = x0;
  let v = v0;
  const scale = Math.max(Math.abs(x0), Math.abs(v0) / Math.sqrt(stiffness / mass), 1e-9);
  const values = [x];
  let lastOutside = 0;
  for (let t = SAMPLE_MS; t <= MAX_MS; t += SAMPLE_MS) {
    for (let i = 0; i < 10; i += 1) {
      const a = (-stiffness * x - damping * v) / mass;
      v += a * h;
      x += v * h;
    }
    values.push(x);
    if (Math.abs(x) > SETTLE * scale) lastOutside = values.length - 1;
    else if (values.length - 1 - lastOutside > 12) break;
  }
  const end = Math.min(values.length - 1, lastOutside + 1);
  return { values: values.slice(0, end + 1), durationMs: end * SAMPLE_MS };
}

function toLinear(values: number[], last: number): string {
  const points = values.map((v, i) => (i === values.length - 1 ? last : Math.round(v * 1000) / 1000));
  if (points.length < 2) points.push(last);
  return `linear(${points.join(', ')})`;
}
