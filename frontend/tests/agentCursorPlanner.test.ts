import { describe, expect, it } from 'vitest';
import {
  AGENT_CURSOR_ENTRANCE_PX,
  AGENT_CURSOR_IDLE_OPACITY,
  AGENT_CURSOR_LAND_HANDOFF,
  AGENT_CURSOR_STEP_SECONDS,
  createMotion,
  cursorBow,
  cursorDurationMs,
  entranceStart,
  isMoving,
  planMove,
  progressAt,
  stepMotion,
  type CursorMotion,
} from '../src/lib/agentCursorPlanner';
import type { Point } from '../src/lib/agentCursorMotion';

/**
 * GM - Design's agent cursor spec, §3, against the numbers GM measured in the
 * prototype (reviews.justinperea.com/nebula/agent-cursor/). GM's settle and
 * follow-through were measured on a 120 Hz display; the planner steps at a
 * fixed 120 Hz, so it lands the same at any frame rate.
 */

const H = AGENT_CURSOR_STEP_SECONDS;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

interface Flight {
  arriveMs: number | null;
  settleMs: number | null;
  restMs: number | null;
  overshootPx: number;
  peakLeanDeg: number;
  /** Furthest above the chord (y < 0), px. */
  apexPx: number;
  finalLean: number;
  motion: CursorMotion;
}

/** A move from rest at (0, 0) to `to`, stepped every `dt` seconds. */
function fly(to: Point, opts: { dt?: number; zoom?: number; pointer?: Point | null } = {}): Flight {
  const dt = opts.dt ?? 1 / 60;
  const zoom = opts.zoom ?? 1;
  const m = createMotion({ x: 0, y: 0 }, 1);
  planMove(m, to, { zoom, pointer: opts.pointer ?? null });
  let t = 0;
  let arriveMs: number | null = null;
  let settleMs: number | null = null;
  let restMs: number | null = null;
  let dir: Point | null = null;
  let overshootPx = 0;
  let peakLeanDeg = 0;
  let apexPx = 0;
  for (let frame = 0; frame < 2000 && restMs === null; frame += 1) {
    const wasLanding = m.landing !== null;
    const result = stepMotion(m, to, dt, { zoom, reduced: false, opacityTarget: 1 });
    t += dt;
    if (result.arrived) {
      arriveMs = t * 1000;
      dir = { ...m.vel };
    }
    if (dir) {
      const len = Math.hypot(dir.x, dir.y) || 1;
      overshootPx = Math.max(overshootPx, (((m.pos.x - to.x) * dir.x + (m.pos.y - to.y) * dir.y) / len) * zoom);
    }
    if ((wasLanding || result.arrived) && m.landing === null && settleMs === null && !m.plan) settleMs = t * 1000;
    peakLeanDeg = Math.max(peakLeanDeg, Math.abs(m.lean.x));
    apexPx = Math.max(apexPx, -m.pos.y * zoom);
    if (result.atRest) restMs = t * 1000;
  }
  return { arriveMs, settleMs, restMs, overshootPx, peakLeanDeg, apexPx, finalLean: m.lean.x, motion: m };
}

describe('duration grows with distance', () => {
  it('is clamp(380 + 170·ln(1 + D/200), 380, 900) ms', () => {
    expect(cursorDurationMs(100)).toBeCloseTo(449, 0);
    expect(cursorDurationMs(500)).toBeCloseTo(593, 0);
    expect(cursorDurationMs(1500)).toBeCloseTo(744, 0);
    expect(cursorDurationMs(0)).toBe(380);
    expect(cursorDurationMs(-5)).toBe(380);
    expect(cursorDurationMs(100_000)).toBe(900);
  });

  it('puts 99% of the progress spring at T', () => {
    const omega = 6.64 / 0.6;
    expect(progressAt({ omega, v0: 0 }, 0.6)).toBeCloseTo(0.99, 2);
    expect(progressAt({ omega, v0: 0 }, 0)).toBe(0);
  });
});

describe('the path is one arc', () => {
  const apex = (from: Point, to: Point, control: Point) => {
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    // A quadratic's apex sits half way from the chord's middle to the control point.
    return dist(mid, control) / 2;
  };

  it.each([0.5, 1, 2])('bows 10%% of the chord, capped at 120 px, straight under 24 px (zoom %s)', (zoom) => {
    const from = { x: 0, y: 0 };
    const at = (px: number) => ({ x: px / zoom, y: 0 });
    expect(apex(from, at(300), cursorBow(from, at(300), null, zoom)) * zoom).toBeCloseTo(30, 6);
    expect(apex(from, at(1000), cursorBow(from, at(1000), null, zoom)) * zoom).toBeCloseTo(100, 6);
    expect(apex(from, at(3000), cursorBow(from, at(3000), null, zoom)) * zoom).toBeCloseTo(120, 6);
    expect(apex(from, at(23), cursorBow(from, at(23), null, zoom))).toBe(0);
    expect(apex(from, at(25), cursorBow(from, at(25), null, zoom)) * zoom).toBeCloseTo(2.5, 6);
  });

  it('bows toward screen-up with no pointer near, in either direction of travel', () => {
    expect(cursorBow({ x: 0, y: 0 }, { x: 400, y: 0 }, null, 1).y).toBeLessThan(0);
    expect(cursorBow({ x: 400, y: 0 }, { x: 0, y: 0 }, null, 1).y).toBeLessThan(0);
    // A pointer far from the middle doesn't count.
    expect(cursorBow({ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 200, y: -260 }, 1).y).toBeLessThan(0);
  });

  it("bows away from the person's pointer when it's within 200 px of the middle", () => {
    expect(cursorBow({ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 200, y: -120 }, 1).y).toBeGreaterThan(0);
    expect(cursorBow({ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 220, y: 150 }, 1).y).toBeLessThan(0);
    // The radius is in screen px: at zoom 2, 120 flow px is 240 screen px, too far.
    expect(cursorBow({ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 200, y: -120 }, 2).y).toBeLessThan(0);
  });

  it('flies the arc it planned: up off the chord and back, never a loop', () => {
    const flight = fly({ x: 400, y: 0 });
    expect(flight.apexPx).toBeGreaterThan(30);
    expect(flight.apexPx).toBeLessThan(40);
    expect(flight.motion.pos).toEqual({ x: 400, y: 0 });
  });
});

describe('the cursor arc pin: a 300 px move from rest (replaces the straight-line pin on purpose)', () => {
  const flight = fly({ x: 300, y: 0 });
  it('takes 536 ms on the arc, bowed 30 px toward screen-up', () => {
    expect(cursorDurationMs(300)).toBeGreaterThan(535);
    expect(cursorDurationMs(300)).toBeLessThan(537);
    expect(flight.apexPx).toBeGreaterThan(29);
    expect(flight.apexPx).toBeLessThan(31.5);
  });
  it('lands with under 1 px of follow-through and is at rest within a second', () => {
    expect(flight.overshootPx).toBeLessThan(1);
    expect(flight.restMs).not.toBeNull();
    expect(flight.restMs!).toBeLessThan(1000);
  });
  it('leans about 11° on the way and is upright at rest', () => {
    expect(flight.peakLeanDeg).toBeGreaterThan(10.2);
    expect(flight.peakLeanDeg).toBeLessThan(12.2);
    expect(Math.abs(flight.finalLean)).toBeLessThan(0.1);
  });
});

describe("GM's measured landings", () => {
  // GM: settle 465 / 721 / 823 ms, follow-through 0.2 / 0.6 / 1.3 px, lean
  // about 6° / 12° / 14°. Tolerance: ±25 ms, ±0.2 px, ±1°.
  const cases = [
    { d: 100, settle: 465, over: 0.2, lean: 6 },
    { d: 400, settle: 721, over: 0.6, lean: 12 },
    { d: 900, settle: 823, over: 1.3, lean: 14 },
  ];
  it.each(cases)('$d px settles in about $settle ms with about $over px of follow-through', ({ d, settle, over, lean }) => {
    const flight = fly({ x: d, y: 0 });
    expect(flight.settleMs).not.toBeNull();
    expect(Math.abs(flight.settleMs! - settle)).toBeLessThanOrEqual(25);
    expect(Math.abs(flight.overshootPx - over)).toBeLessThanOrEqual(0.2);
    expect(Math.abs(flight.peakLeanDeg - lean)).toBeLessThanOrEqual(1);
    expect(flight.settleMs!).toBeLessThan(1000);
  });

  it.each([1 / 30, 1 / 60, 1 / 144])('lands the same at any frame rate (dt %s s)', (dt) => {
    const at120 = fly({ x: 400, y: 0 }, { dt: H });
    const other = fly({ x: 400, y: 0 }, { dt });
    expect(Math.abs(other.settleMs! - at120.settleMs!)).toBeLessThanOrEqual(1000 * dt + 1);
    expect(other.overshootPx).toBeCloseTo(at120.overshootPx, 1);
  });

  it('measures in screen px at any zoom', () => {
    const near = fly({ x: 200, y: 0 }, { zoom: 2 });
    const far = fly({ x: 400, y: 0 }, { zoom: 1 });
    expect(Math.abs(near.settleMs! - far.settleMs!)).toBeLessThanOrEqual(1000 / 60 + 1);
    expect(near.peakLeanDeg).toBeCloseTo(far.peakLeanDeg, 1);
  });
});

describe('the landing hand-off', () => {
  it(`hands position and velocity to the land spring at p = ${AGENT_CURSOR_LAND_HANDOFF}`, () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    const to = { x: 400, y: 0 };
    planMove(m, to, { zoom: 1, pointer: null });
    const omega = m.plan!.omega;
    let before = { pos: { ...m.pos }, vel: { ...m.vel } };
    let elapsed = 0;
    for (let i = 0; i < 400; i += 1) {
      before = { pos: { ...m.pos }, vel: { ...m.vel } };
      const result = stepMotion(m, to, H, { zoom: 1, reduced: false, opacityTarget: 1 });
      elapsed += H;
      if (result.arrived) break;
    }
    expect(m.plan).toBeNull();
    expect(m.landing).not.toBeNull();
    expect(progressAt({ omega, v0: 0 }, elapsed)).toBeGreaterThanOrEqual(AGENT_CURSOR_LAND_HANDOFF);
    expect(progressAt({ omega, v0: 0 }, elapsed - H)).toBeLessThan(AGENT_CURSOR_LAND_HANDOFF);
    const speed = Math.hypot(before.vel.x, before.vel.y);
    expect(speed).toBeGreaterThan(200);
    // No jump: one step's worth of travel, at the speed it had.
    expect(dist(m.pos, before.pos)).toBeLessThan(speed * H * 1.2);
    // The velocity carries over, changed only by one step of the land spring.
    expect(Math.hypot(m.vel.x - before.vel.x, m.vel.y - before.vel.y)).toBeLessThan(0.15 * speed);
    // About 20% of the way still to go: the settle plays out under the action.
    expect(to.x - m.pos.x).toBeGreaterThan(40);
    expect(isMoving(m, 1)).toBe(true);
  });
});

describe('re-planning mid-flight', () => {
  const step = (m: CursorMotion, live: Point, dt = H) => stepMotion(m, live, dt, { zoom: 1, reduced: false, opacityTarget: 1 });

  it('leaves from the current position and velocity, with no jump, and still lands', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 600, y: 0 }, { zoom: 1, pointer: null });
    for (let i = 0; i < 24; i += 1) step(m, { x: 600, y: 0 });
    const pos = { ...m.pos };
    const vel = { ...m.vel };
    const speed = Math.hypot(vel.x, vel.y);
    expect(speed).toBeGreaterThan(100);
    // The node it was heading for moved far away: the live target jumps.
    const moved = { x: 300, y: 400 };
    step(m, moved);
    expect(dist(m.pos, pos)).toBeLessThan(speed * H * 1.5);
    // The new arc leaves along the old motion, then turns: a curve, not a kink
    // (the target now lies about 90° off the way it was heading).
    const plan = m.plan!;
    const tangent = { x: plan.control.x - plan.from.x, y: plan.control.y - plan.from.y };
    expect(Math.abs(tangent.x * vel.y - tangent.y * vel.x) / (Math.hypot(tangent.x, tangent.y) * speed)).toBeLessThan(1e-9);
    expect(plan.from).toEqual(pos);
    const turn = Math.acos((m.vel.x * vel.x + m.vel.y * vel.y) / (Math.hypot(m.vel.x, m.vel.y) * speed));
    expect(turn).toBeLessThan((30 * Math.PI) / 180);
    expect(Math.abs(Math.hypot(m.vel.x, m.vel.y) - speed) / speed).toBeLessThan(0.15);
    for (let i = 0; i < 400 && !step(m, moved).atRest; i += 1);
    expect(m.pos).toEqual(moved);
  });

  it('a new event mid-landing re-plans from where the cursor is, with no jump', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 400, y: 0 }, { zoom: 1, pointer: null });
    for (let i = 0; i < 400 && !step(m, { x: 400, y: 0 }).arrived; i += 1);
    const pos = { ...m.pos };
    const speed = Math.hypot(m.vel.x, m.vel.y);
    planMove(m, { x: 400, y: 300 }, { zoom: 1, pointer: null });
    step(m, { x: 400, y: 300 });
    expect(dist(m.pos, pos)).toBeLessThan(speed * H * 1.5 + 1);
    for (let i = 0; i < 400 && !step(m, { x: 400, y: 300 }).atRest; i += 1);
    expect(m.pos).toEqual({ x: 400, y: 300 });
  });

  it('a node that moves a little during the arc bends its end, with no re-plan', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 400, y: 0 }, { zoom: 1, pointer: null });
    const plan = m.plan;
    for (let i = 0; i < 12; i += 1) step(m, { x: 400, y: 0 });
    for (let i = 0; i < 400 && !step(m, { x: 400, y: 10 }).atRest; i += 1) {
      if (m.plan) expect(m.plan).toBe(plan);
    }
    expect(m.pos).toEqual({ x: 400, y: 10 });
  });

  it('follows a target that moves after it has landed', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    expect(step(m, { x: 0, y: 0 }).atRest).toBe(true);
    step(m, { x: 10, y: 0 });
    expect(m.landing).not.toBeNull();
    for (let i = 0; i < 400 && !step(m, { x: 10, y: 0 }).atRest; i += 1);
    expect(m.pos).toEqual({ x: 10, y: 0 });
    step(m, { x: 300, y: 0 });
    expect(m.plan).not.toBeNull();
  });

  it('stays finite across a long frame gap (backgrounded tab) and finishes the move', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 100, y: 100 }, { zoom: 1, pointer: null });
    const result = step(m, { x: 100, y: 100 }, 5);
    expect(Number.isFinite(m.pos.x)).toBe(true);
    expect(m.pos).toEqual({ x: 100, y: 100 });
    expect(result.atRest).toBe(true);
    const short = createMotion({ x: 0, y: 0 }, 1);
    planMove(short, { x: 100, y: 100 }, { zoom: 1, pointer: null });
    step(short, { x: 100, y: 100 }, 1.5);
    expect(Math.abs(short.pos.x - 100)).toBeLessThan(0.5);
  });
});

describe('entrance and idle', () => {
  it('starts 64 px back along the line to its first target, or up-left with none', () => {
    const along = entranceStart({ x: 100, y: 100 }, { from: { x: 100, y: 100 }, to: { x: 400, y: 100 } }, 1);
    expect(along).toEqual({ x: 100 - AGENT_CURSOR_ENTRANCE_PX, y: 100 });
    const upLeft = entranceStart({ x: 100, y: 100 }, null, 2);
    expect(dist(upLeft, { x: 100, y: 100 }) * 2).toBeCloseTo(AGENT_CURSOR_ENTRANCE_PX, 6);
    expect(upLeft.x).toBeLessThan(100);
    expect(upLeft.y).toBeLessThan(100);
    expect(upLeft.x).toBeCloseTo(upLeft.y, 6);
  });

  it('springs in from opacity 0 to 1 as it flies in', () => {
    const target = { x: 100, y: 100 };
    const m = createMotion(entranceStart(target, null, 1), 0);
    planMove(m, target, { zoom: 1, pointer: null });
    stepMotion(m, target, 1 / 60, { zoom: 1, reduced: false, opacityTarget: 1 });
    expect(m.opacity.x).toBeGreaterThan(0);
    expect(m.opacity.x).toBeLessThan(0.5);
    let rest = false;
    for (let i = 0; i < 200 && !rest; i += 1) rest = stepMotion(m, target, 1 / 60, { zoom: 1, reduced: false, opacityTarget: 1 }).atRest;
    expect(rest).toBe(true);
    expect(m.opacity.x).toBe(1);
    expect(m.pos).toEqual(target);
  });

  it('dims to 0.45 on the same spring, never a step', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    stepMotion(m, { x: 0, y: 0 }, 1 / 60, { zoom: 1, reduced: false, opacityTarget: AGENT_CURSOR_IDLE_OPACITY });
    expect(m.opacity.x).toBeLessThan(1);
    expect(m.opacity.x).toBeGreaterThan(0.9);
    for (let i = 0; i < 200; i += 1) stepMotion(m, { x: 0, y: 0 }, 1 / 60, { zoom: 1, reduced: false, opacityTarget: AGENT_CURSOR_IDLE_OPACITY });
    expect(m.opacity.x).toBe(AGENT_CURSOR_IDLE_OPACITY);
  });
});

describe('reduced motion', () => {
  it('snaps to the target, upright, at its opacity, on the first frame', () => {
    const m = createMotion({ x: 0, y: 0 }, 0);
    planMove(m, { x: 500, y: 0 }, { zoom: 1, pointer: null });
    const result = stepMotion(m, { x: 500, y: 0 }, 1 / 60, { zoom: 1, reduced: true, opacityTarget: 1 });
    expect(m.pos).toEqual({ x: 500, y: 0 });
    expect(m.lean.x).toBe(0);
    expect(m.opacity.x).toBe(1);
    expect(m.plan).toBeNull();
    expect(result.atRest).toBe(true);
    expect(isMoving(m, 1)).toBe(false);
    stepMotion(m, { x: 500, y: 0 }, 1 / 60, { zoom: 1, reduced: true, opacityTarget: AGENT_CURSOR_IDLE_OPACITY });
    expect(m.opacity.x).toBe(AGENT_CURSOR_IDLE_OPACITY);
  });
});
