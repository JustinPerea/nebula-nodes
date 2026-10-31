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
/** Opacity in and out: the entrance and the idle dim (and the ripple's curve in CSS). */
export const AGENT_CURSOR_FADE_SPRING: SpringConfig = { stiffness: 170, damping: 26, mass: 1 };
/** A first sighting starts this far back along the line to its first target. */
export const AGENT_CURSOR_ENTRANCE_PX = 64;
export const AGENT_CURSOR_IDLE_OPACITY = 0.45;
/** Under this speed (px/s) a landing cursor counts as stopped, for its name. */
export const AGENT_CURSOR_MOVING_SPEED = 30;
/** A live target that moves further than this from where the move aimed re-plans it. */
export const AGENT_CURSOR_REPLAN_PX = 24;
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
}

export interface StepResult {
  /** The arc handed off to the land spring during this frame: the tool's action fires now. */
  arrived: boolean;
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
export function cursorBow(from: Point, to: Point, pointer: Point | null, zoom: number): Point {
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
  return { x: mid.x + n.x * bow * side * 2, y: mid.y + n.y * bow * side * 2 };
}

export function pathAt(plan: CursorPlan, p: number): Point {
  const u = 1 - p;
  return {
    x: u * u * plan.from.x + 2 * u * p * plan.control.x + p * p * plan.to.x,
    y: u * u * plan.from.y + 2 * u * p * plan.control.y + p * p * plan.to.y,
  };
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
export function planMove(m: CursorMotion, to: Point, opts: { zoom: number; pointer: Point | null }): void {
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
  }
  m.plan = { from, control, to: { ...to }, aimed: { ...to }, durationMs, omega, v0, elapsed: 0 };
  m.landing = null;
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

function substep(m: CursorMotion, live: Point, h: number, zoom: number, opacityTarget: number): boolean {
  let arrived = false;
  const plan = m.plan;
  if (plan) {
    plan.elapsed += h;
    plan.to = { ...live };
    const p = progressAt(plan, plan.elapsed);
    if (p < AGENT_CURSOR_LAND_HANDOFF) {
      const q = pathAt(plan, p);
      m.vel = { x: (q.x - m.pos.x) / h, y: (q.y - m.pos.y) / h };
      m.pos = q;
    } else {
      // Hand-off: the land spring starts from this position and velocity.
      m.plan = null;
      m.landing = { ...plan.aimed };
      arrived = true;
    }
  }
  if (m.landing) {
    const k = AGENT_CURSOR_LAND_SPRING.stiffness;
    const c = AGENT_CURSOR_LAND_SPRING.damping;
    const mass = AGENT_CURSOR_LAND_SPRING.mass;
    m.vel = {
      x: m.vel.x + ((-k * (m.pos.x - live.x) - c * m.vel.x) / mass) * h,
      y: m.vel.y + ((-k * (m.pos.y - live.y) - c * m.vel.y) / mass) * h,
    };
    m.pos = { x: m.pos.x + m.vel.x * h, y: m.pos.y + m.vel.y * h };
    if (Math.hypot(m.vel.x, m.vel.y) * zoom < REST_SPEED_PX && dist(m.pos, live) * zoom < REST_DISTANCE_PX) {
      m.pos = { ...live };
      m.vel = { x: 0, y: 0 };
      m.landing = null;
    }
  }
  const speedPx = Math.hypot(m.vel.x, m.vel.y) * zoom;
  stepSpring1(m.lean, leanTarget(m.vel.x * zoom, speedPx), AGENT_CURSOR_LEAN_SPRING, h);
  stepSpring1(m.opacity, opacityTarget, AGENT_CURSOR_FADE_SPRING, h);
  return arrived;
}

function settled(m: CursorMotion, opacityTarget: number): boolean {
  if (m.plan || m.landing) return false;
  if (Math.abs(m.lean.x) > 0.05 || Math.abs(m.lean.v) > 0.5) return false;
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
    m.pos = { ...live };
    m.vel = { x: 0, y: 0 };
    m.plan = null;
    m.landing = null;
    m.lean = { x: 0, v: 0 };
    m.opacity = { x: opacityTarget, v: 0 };
    m.carry = 0;
    return { arrived, atRest: true };
  };
  if (reduced) return finish(false);
  if (dtSeconds > MAX_CATCH_UP_SECONDS) return finish(m.plan !== null);

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
  m.carry += Math.max(0, dtSeconds);
  const h = AGENT_CURSOR_STEP_SECONDS;
  while (m.carry >= h - 1e-9) {
    m.carry -= h;
    if (substep(m, live, h, zoom, opacityTarget)) arrived = true;
  }
  m.carry = Math.max(0, m.carry);
  const atRest = settled(m, opacityTarget);
  if (atRest) {
    m.lean = { x: 0, v: 0 };
    m.opacity = { x: opacityTarget, v: 0 };
  }
  return { arrived, atRest };
}
