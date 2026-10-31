import type { Point, SpringConfig } from './agentCursorMotion';

/**
 * How an agent cursor travels (GM - Design, agent cursor §3): one arc per
 * move, timed by distance, with a spring on progress along it, then a landing
 * spring for the last stretch, and a lean toward where it's going.
 *
 * Pure, with no React and no React Flow, so the screen layer can reuse it.
 * Motion runs in flow coordinates; every threshold here is in screen px and
 * converts through the zoom. The values were tuned and measured by GM in the
 * prototype (reviews.justinperea.com/nebula/agent-cursor/).
 *
 * The motion steps at a fixed 120 Hz inside each frame, the rate GM measured
 * on, so the settle and follow-through are the same at any display rate.
 * `AGENT_CURSOR_SPRING` is not used here: pins, ghosts and the camera share it.
 */

/** Takes over from the arc at the hand-off and lands the tip (ζ ≈ 0.8). */
export const AGENT_CURSOR_LAND_SPRING: SpringConfig = { stiffness: 260, damping: 26, mass: 1 };
/** Progress along the arc at which the land spring takes over. */
export const AGENT_CURSOR_LAND_HANDOFF = 0.8;
/** ω = 6.64 / T puts 99% of the progress spring at T. */
export const AGENT_CURSOR_PROGRESS_K = 6.64;
/** T = clamp(380 + 170·ln(1 + D/200), 380, 900) ms. */
export const AGENT_CURSOR_DURATION = { baseMs: 380, gainMs: 170, scalePx: 200, minMs: 380, maxMs: 900 } as const;
/** The arc bows 10% of the chord, at most 120 px, and is straight under 24 px. */
export const AGENT_CURSOR_BOW = { fraction: 0.1, maxPx: 120, straightUnderPx: 24, pointerRadiusPx: 200 } as const;
/** Lean: 14° × tanh(vx / 700) × min(1, speed / 250). */
export const AGENT_CURSOR_LEAN = { maxDeg: 14, vxScale: 700, fullSpeed: 250 } as const;
export const AGENT_CURSOR_LEAN_SPRING: SpringConfig = { stiffness: 180, damping: 22, mass: 1 };
/**
 * Once the tip is at rest, a lean under `deg` turning slower than
 * `degPerSecond` snaps to 0 and the loop sleeps (GM - Design, PR #211 r1).
 * Why 3°/s: from upright, the lean spring (ω ≈ 13.4 rad/s, ζ ≈ 0.82) swings
 * at most 0.031 s × v further, so 3°/s leaves under 0.1° unshown. With the
 * 0.1° it may already have, the snap skips under 0.2°: a fraction of a pixel
 * at the arrow's tail. It lets a 400 px or longer move sleep the frame its
 * tip comes to rest.
 */
export const AGENT_CURSOR_LEAN_REST = { deg: 0.1, degPerSecond: 3 } as const;
/** Opacity in and out: the entrance and the idle dim (and the ripple's curve in CSS). */
export const AGENT_CURSOR_FADE_SPRING: SpringConfig = { stiffness: 170, damping: 26, mass: 1 };
/** A first sighting starts this far back along the line to its first target. */
export const AGENT_CURSOR_ENTRANCE_PX = 64;
export const AGENT_CURSOR_IDLE_OPACITY = 0.45;
/** Under this speed (px/s) a landing cursor counts as stopped, for its name. */
export const AGENT_CURSOR_MOVING_SPEED = 30;
/** A live target that moves further than this from where the move aimed re-plans it. */
export const AGENT_CURSOR_REPLAN_PX = 24;
/**
 * The tip has arrived when the land spring brings it this close to the live
 * target (screen px): the tool's action fires then, and the drag wire lets
 * go (§3, "the action happens at arrival"). The hand-off at
 * AGENT_CURSOR_LAND_HANDOFF only changes which spring moves it.
 */
export const AGENT_CURSOR_ARRIVE_PX = 2;
/**
 * The most the tip may run past its target after the hand-off, screen px
 * (GM - Design, PR #211 r2). Up to about 1500 px a hand-off at p = 0.80
 * already keeps within it, and those moves are unchanged. On longer chords
 * the 20% left is far enough that the land spring (ζ ≈ 0.8) overshoots more
 * than 2 px even from a standstill (about 8 px from 600 px), so no clamp on
 * the hand-off speed alone can hold it: the arc carries on past 0.80 until a
 * hand-off from where the tip is would run at most this far past.
 */
export const AGENT_CURSOR_MAX_FOLLOW_THROUGH_PX = 2;
/**
 * When a new flight's arc would pass within this many screen px of another
 * cursor's flight still under way, the new one bows to the other side
 * (GM - Design, PR #211 r2), with the same 10% / 120 px cap.
 */
export const AGENT_CURSOR_CROSS_PX = 24;
/** The fixed motion step. */
export const AGENT_CURSOR_STEP_SECONDS = 1 / 120;

/** A frame gap longer than this (a backgrounded tab) finishes the move at once. */
const MAX_CATCH_UP_SECONDS = 2;
/** The land spring snaps onto the target within these (screen px, px/s). */
const REST_DISTANCE_PX = 0.2;
const REST_SPEED_PX = 2;
/** The re-plan tangent never shrinks below this share of half the new chord. */
const MIN_TANGENT_SHARE = 0.25;

export interface CursorPlan {
  from: Point;
  control: Point;
  /** The end of the arc: the live target, updated every step. */
  to: Point;
  /** Where the move aimed when it was planned. */
  aimed: Point;
  durationMs: number;
  /** Progress spring rate, per second. */
  omega: number;
  /** Progress per second at the start (0 from rest). */
  v0: number;
  /** Seconds since the plan started. */
  elapsed: number;
}

interface Spring1 {
  x: number;
  v: number;
}

export interface CursorMotion {
  pos: Point;
  vel: Point;
  plan: CursorPlan | null;
  /** Where the land spring aimed when it took over; null when not landing. */
  landing: Point | null;
  /** Degrees. */
  lean: Spring1;
  opacity: Spring1;
  /** Time not yet stepped, under one step. */
  carry: number;
  /** A planned move whose tip hasn't arrived yet (StepResult.arrived is still to come). */
  awaiting: boolean;
}

export interface StepResult {
  /** The tip came within AGENT_CURSOR_ARRIVE_PX of the target this frame: the tool's action fires now. */
  arrived: boolean;
  /** The arc handed off to the land spring this frame (motion only). */
  handedOff: boolean;
  /** Nothing moves any more: the loop can sleep. */
  atRest: boolean;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function createMotion(at: Point, opacity = 0): CursorMotion {
  return {
    pos: { ...at },
    vel: { x: 0, y: 0 },
    plan: null,
    landing: null,
    lean: { x: 0, v: 0 },
    opacity: { x: opacity, v: 0 },
    carry: 0,
    awaiting: false,
  };
}

/** How long a move of this many screen px takes. */
export function cursorDurationMs(distancePx: number): number {
  const { baseMs, gainMs, scalePx, minMs, maxMs } = AGENT_CURSOR_DURATION;
  const t = baseMs + gainMs * Math.log(1 + Math.max(0, distancePx) / scalePx);
  return Math.min(maxMs, Math.max(minMs, t));
}

/**
 * The arc's quadratic control point, so its apex sits `bow` off the chord.
 * It bows away from the person's pointer when that is near the middle of the
 * path, otherwise toward screen-up. `pointer` is in flow coordinates.
 */
export function cursorBow(from: Point, to: Point, pointer: Point | null, zoom: number, flip = false): Point {
  const d = dist(from, to);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dPx = d * zoom;
  if (dPx < AGENT_CURSOR_BOW.straightUnderPx) return mid;
  const bow = Math.min(AGENT_CURSOR_BOW.maxPx, AGENT_CURSOR_BOW.fraction * dPx) / zoom;
  const n = { x: -(to.y - from.y) / d, y: (to.x - from.x) / d };
  let side = n.y < 0 ? 1 : -1;
  if (pointer && dist(pointer, mid) * zoom < AGENT_CURSOR_BOW.pointerRadiusPx) {
    const toward = Math.sign((pointer.x - mid.x) * n.x + (pointer.y - mid.y) * n.y);
    if (toward !== 0) side = -toward;
  }
  if (flip) side = -side;
  return { x: mid.x + n.x * bow * side * 2, y: mid.y + n.y * bow * side * 2 };
}

export function pathAt(plan: CursorPlan, p: number): Point {
  const u = 1 - p;
  return {
    x: u * u * plan.from.x + 2 * u * p * plan.control.x + p * p * plan.to.x,
    y: u * u * plan.from.y + 2 * u * p * plan.control.y + p * p * plan.to.y,
  };
}

/** The closest two arcs come to each other, in screen px (sampled). */
export function arcGapPx(
  a: Pick<CursorPlan, 'from' | 'control' | 'to'>,
  b: Pick<CursorPlan, 'from' | 'control' | 'to'>,
  zoom: number,
): number {
  const samples = 32;
  const at = (plan: Pick<CursorPlan, 'from' | 'control' | 'to'>, p: number) => {
    const u = 1 - p;
    return {
      x: u * u * plan.from.x + 2 * u * p * plan.control.x + p * p * plan.to.x,
      y: u * u * plan.from.y + 2 * u * p * plan.control.y + p * p * plan.to.y,
    };
  };
  const bs = Array.from({ length: samples + 1 }, (_, j) => at(b, j / samples));
  let gap = Infinity;
  for (let i = 0; i <= samples; i += 1) {
    const q = at(a, i / samples);
    for (const r of bs) gap = Math.min(gap, dist(q, r));
  }
  return gap * zoom;
}

/** Progress along the arc: a critically damped spring from v0. */
export function progressAt(plan: Pick<CursorPlan, 'omega' | 'v0'>, seconds: number): number {
  const { omega, v0 } = plan;
  return 1 - (1 + (omega - v0) * seconds) * Math.exp(-omega * seconds);
}

/**
 * Plan a move from wherever the cursor is now. From rest it is a fresh arc.
 * Mid-flight it leaves along the current motion at the current speed, so a
 * re-plan never jumps or kinks.
 */
export function planMove(
  m: CursorMotion,
  to: Point,
  opts: { zoom: number; pointer: Point | null; others?: readonly CursorPlan[] },
): void {
  const { zoom, pointer } = opts;
  const from = { ...m.pos };
  const d = dist(from, to);
  const durationMs = cursorDurationMs(d * zoom);
  const omega = AGENT_CURSOR_PROGRESS_K / (durationMs / 1000);
  const speed = Math.hypot(m.vel.x, m.vel.y);
  let control: Point;
  let v0 = 0;
  if (speed * zoom >= AGENT_CURSOR_MOVING_SPEED && d > 0) {
    const along = { x: m.vel.x / speed, y: m.vel.y / speed };
    const facing = ((to.x - from.x) * along.x + (to.y - from.y) * along.y) / d;
    // Fast enough that the progress spring can't keep the speed on a short
    // tangent: reach further along the old motion so it can.
    const reach = Math.min(d, Math.max((d / 2) * Math.min(1, Math.max(MIN_TANGENT_SHARE, facing)), speed / (2 * omega)));
    control = { x: from.x + along.x * reach, y: from.y + along.y * reach };
    // dB/dp at 0 is 2·reach, so this keeps the speed.
    v0 = Math.min(omega, speed / (2 * reach));
  } else {
    control = cursorBow(from, to, pointer, zoom);
    // Another cursor still in flight on a path this one would cross or
    // graze: this later-starting flight bows the other way.
    if (opts.others?.some((other) => arcGapPx({ from, control, to }, other, zoom) < AGENT_CURSOR_CROSS_PX)) {
      control = cursorBow(from, to, pointer, zoom, true);
    }
  }
  m.plan = { from, control, to: { ...to }, aimed: { ...to }, durationMs, omega, v0, elapsed: 0 };
  m.landing = null;
  m.awaiting = true;
}

/** Where a first sighting starts: 64 px back along its line, or up-left with none. */
export function entranceStart(first: Point, line: { from: Point; to: Point } | null, zoom: number): Point {
  const back = AGENT_CURSOR_ENTRANCE_PX / zoom;
  const d = line ? dist(line.from, line.to) : 0;
  if (line && d > 0) {
    return { x: first.x - ((line.to.x - line.from.x) / d) * back, y: first.y - ((line.to.y - line.from.y) / d) * back };
  }
  return { x: first.x - back * Math.SQRT1_2, y: first.y - back * Math.SQRT1_2 };
}

/** The lean's target in degrees, from the velocity in screen px/s. */
export function leanTarget(vxPx: number, speedPx: number): number {
  const { maxDeg, vxScale, fullSpeed } = AGENT_CURSOR_LEAN;
  return maxDeg * Math.tanh(vxPx / vxScale) * Math.min(1, speedPx / fullSpeed);
}

/** How far past `target` the land spring would carry the tip from here, screen px. */
export function landFollowThroughPx(pos: Point, vel: Point, target: Point, zoom: number): number {
  const speed = Math.hypot(vel.x, vel.y);
  if (speed === 0) return 0;
  const ux = vel.x / speed;
  const uy = vel.y / speed;
  const { stiffness: k, damping: c, mass } = AGENT_CURSOR_LAND_SPRING;
  const h = AGENT_CURSOR_STEP_SECONDS;
  let px = pos.x; let py = pos.y; let vx = vel.x; let vy = vel.y;
  let over = 0;
  for (let i = 0; i < 240; i += 1) {
    vx += ((-k * (px - target.x) - c * vx) / mass) * h;
    vy += ((-k * (py - target.y) - c * vy) / mass) * h;
    px += vx * h;
    py += vy * h;
    over = Math.max(over, (px - target.x) * ux + (py - target.y) * uy);
  }
  return over * zoom;
}

function stepSpring1(s: Spring1, target: number, config: SpringConfig, h: number): void {
  const a = (-config.stiffness * (s.x - target) - config.damping * s.v) / config.mass;
  s.v += a * h;
  s.x += s.v * h;
}

/** True while the arc runs, or while landing faster than the moving speed. */
export function isMoving(m: CursorMotion, zoom: number): boolean {
  if (m.plan) return true;
  return m.landing !== null && Math.hypot(m.vel.x, m.vel.y) * zoom > AGENT_CURSOR_MOVING_SPEED;
}

/** One fixed step. Mutates the motion in place: no allocation per step. */
function substep(m: CursorMotion, live: Point, h: number, zoom: number, opacityTarget: number): { handedOff: boolean; arrived: boolean } {
  let handedOff = false;
  const plan = m.plan;
  if (plan) {
    plan.elapsed += h;
    plan.to.x = live.x;
    plan.to.y = live.y;
    const p = progressAt(plan, plan.elapsed);
    const early = p < AGENT_CURSOR_LAND_HANDOFF
      || (p < 0.999 && landFollowThroughPx(m.pos, m.vel, live, zoom) > AGENT_CURSOR_MAX_FOLLOW_THROUGH_PX);
    if (early) {
      const u = 1 - p;
      const qx = u * u * plan.from.x + 2 * u * p * plan.control.x + p * p * plan.to.x;
      const qy = u * u * plan.from.y + 2 * u * p * plan.control.y + p * p * plan.to.y;
      m.vel.x = (qx - m.pos.x) / h;
      m.vel.y = (qy - m.pos.y) / h;
      m.pos.x = qx;
      m.pos.y = qy;
    } else {
      // Hand-off: the land spring starts from this position and velocity.
      m.plan = null;
      m.landing = { x: plan.aimed.x, y: plan.aimed.y };
      handedOff = true;
    }
  }
  if (m.landing) {
    const k = AGENT_CURSOR_LAND_SPRING.stiffness;
    const c = AGENT_CURSOR_LAND_SPRING.damping;
    const mass = AGENT_CURSOR_LAND_SPRING.mass;
    m.vel.x += ((-k * (m.pos.x - live.x) - c * m.vel.x) / mass) * h;
    m.vel.y += ((-k * (m.pos.y - live.y) - c * m.vel.y) / mass) * h;
    m.pos.x += m.vel.x * h;
    m.pos.y += m.vel.y * h;
    if (Math.hypot(m.vel.x, m.vel.y) * zoom < REST_SPEED_PX && dist(m.pos, live) * zoom < REST_DISTANCE_PX) {
      m.pos.x = live.x;
      m.pos.y = live.y;
      m.vel.x = 0;
      m.vel.y = 0;
      m.landing = null;
    }
  }
  let arrived = false;
  if (m.awaiting && !m.plan && dist(m.pos, live) * zoom <= AGENT_CURSOR_ARRIVE_PX) {
    m.awaiting = false;
    arrived = true;
  }
  const speedPx = Math.hypot(m.vel.x, m.vel.y) * zoom;
  stepSpring1(m.lean, leanTarget(m.vel.x * zoom, speedPx), AGENT_CURSOR_LEAN_SPRING, h);
  stepSpring1(m.opacity, opacityTarget, AGENT_CURSOR_FADE_SPRING, h);
  return { handedOff, arrived };
}

function settled(m: CursorMotion, opacityTarget: number): boolean {
  if (m.plan || m.landing) return false;
  if (Math.abs(m.lean.x) >= AGENT_CURSOR_LEAN_REST.deg || Math.abs(m.lean.v) >= AGENT_CURSOR_LEAN_REST.degPerSecond) {
    return false;
  }
  return Math.abs(m.opacity.x - opacityTarget) < 0.002 && Math.abs(m.opacity.v) < 0.01;
}

/**
 * Advance one frame toward the live target. Under reduced motion the cursor
 * snaps there, upright, at its opacity, as today.
 */
export function stepMotion(
  m: CursorMotion,
  live: Point,
  dtSeconds: number,
  opts: { zoom: number; reduced: boolean; opacityTarget: number; pointer?: Point | null },
): StepResult {
  const { zoom, reduced, opacityTarget } = opts;
  const finish = (arrived: boolean): StepResult => {
    m.awaiting = false;
    m.pos = { ...live };
    m.vel = { x: 0, y: 0 };
    m.plan = null;
    m.landing = null;
    m.lean = { x: 0, v: 0 };
    m.opacity = { x: opacityTarget, v: 0 };
    m.carry = 0;
    return { arrived, handedOff: false, atRest: true };
  };
  if (reduced) return finish(false);
  if (dtSeconds > MAX_CATCH_UP_SECONDS) return finish(m.awaiting);

  const replanPx = AGENT_CURSOR_REPLAN_PX;
  const pointer = opts.pointer ?? null;
  if (m.plan && dist(live, m.plan.aimed) * zoom > replanPx) planMove(m, live, { zoom, pointer });
  else if (m.landing && dist(live, m.landing) * zoom > replanPx) planMove(m, live, { zoom, pointer });
  else if (!m.plan && !m.landing) {
    // At rest and the target moved (a node dragged or synced): follow it.
    const away = dist(m.pos, live) * zoom;
    if (away > replanPx) planMove(m, live, { zoom, pointer });
    else if (away >= REST_DISTANCE_PX) m.landing = { ...live };
  }

  let arrived = false;
  let handedOff = false;
  m.carry += Math.max(0, dtSeconds);
  const h = AGENT_CURSOR_STEP_SECONDS;
  while (m.carry >= h - 1e-9) {
    m.carry -= h;
    const step = substep(m, live, h, zoom, opacityTarget);
    if (step.arrived) arrived = true;
    if (step.handedOff) handedOff = true;
  }
  m.carry = Math.max(0, m.carry);
  const atRest = settled(m, opacityTarget);
  if (atRest) {
    m.lean = { x: 0, v: 0 };
    m.opacity = { x: opacityTarget, v: 0 };
  }
  return { arrived, handedOff, atRest };
}
