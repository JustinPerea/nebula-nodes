import { describe, expect, it } from 'vitest';
import {
  AGENT_CURSOR_ARRIVE_PX,
  AGENT_CURSOR_CROSS_PX,
  AGENT_CURSOR_DRAG_END_SECONDS,
  AGENT_CURSOR_ENTRANCE_PX,
  AGENT_CURSOR_FADE_SPRING,
  AGENT_CURSOR_IDLE_OPACITY,
  AGENT_CURSOR_MAX_FOLLOW_THROUGH_PX,
  AGENT_CURSOR_LAND_HANDOFF,
  AGENT_CURSOR_LEAN_REST,
  AGENT_CURSOR_LEAN_SPRING,
  AGENT_CURSOR_STALE_GAP_SECONDS,
  AGENT_CURSOR_STEP_SECONDS,
  bowAgainst,
  createMotion,
  arcGapPx,
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
    if (result.arrived && arriveMs === null) arriveMs = t * 1000;
    if (result.handedOff) dir = { ...m.vel };
    if (dir) {
      const len = Math.hypot(dir.x, dir.y) || 1;
      overshootPx = Math.max(overshootPx, (((m.pos.x - to.x) * dir.x + (m.pos.y - to.y) * dir.y) / len) * zoom);
    }
    if ((wasLanding || result.handedOff) && m.landing === null && settleMs === null && !m.plan) settleMs = t * 1000;
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

describe('the lean rest snap (GM - Design, PR #211 r1)', () => {
  it('pins the threshold: under 0.1° and turning under 3°/s', () => {
    expect(AGENT_CURSOR_LEAN_REST).toEqual({ deg: 0.1, degPerSecond: 3 });
  });

  it.each([
    { label: '1500 px', to: { x: 1500, y: 0 } },
    { label: '1500 px diagonal', to: { x: 1500 / Math.SQRT2, y: 1500 / Math.SQRT2 } },
  ])('sleeps the loop by about 900 ms on a $label move, the frame the tip comes to rest', ({ to }) => {
    const flight = fly(to);
    expect(flight.settleMs).not.toBeNull();
    expect(flight.restMs).not.toBeNull();
    // Round 1 kept the loop running to 933-1033 ms for the last 0.05° of lean.
    expect(flight.restMs!).toBeLessThanOrEqual(900 + 1000 / 60 / 2);
    expect(flight.restMs! - flight.settleMs!).toBeLessThanOrEqual(1000 / 60 + 0.5);
    expect(flight.finalLean).toBe(0);
    expect(flight.motion.lean.v).toBe(0);
  });

  it.each([400, 900])('sleeps the frame the tip rests on a %s px move', (d) => {
    const flight = fly({ x: d, y: 0 });
    expect(flight.restMs! - flight.settleMs!).toBeLessThanOrEqual(1000 / 60 + 0.5);
  });

  it('keeps running while the lean is still visible, then snaps it to exactly 0', () => {
    // 100 px: the tip rests at about 467 ms with the lean still near 0.8°.
    const flight = fly({ x: 100, y: 0 });
    expect(flight.restMs! - flight.settleMs!).toBeGreaterThan(80);
    expect(flight.finalLean).toBe(0);
  });

  it('never snaps a lean that is still turning fast, nor one at 0.1° or more', () => {
    const still = (lean: { x: number; v: number }) => {
      const m = createMotion({ x: 0, y: 0 }, 1);
      m.lean = { ...lean };
      return stepMotion(m, { x: 0, y: 0 }, 0, { zoom: 1, reduced: false, opacityTarget: 1 }).atRest;
    };
    expect(still({ x: 0.09, v: 2.9 })).toBe(true);
    expect(still({ x: 0.09, v: 3.1 })).toBe(false);
    expect(still({ x: 0.11, v: 0 })).toBe(false);
    expect(still({ x: -0.09, v: -2.9 })).toBe(true);
  });

  it('skips under 0.1° of swing: a lean at 3°/s from upright peaks below 0.1°', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    m.lean = { x: 0, v: AGENT_CURSOR_LEAN_REST.degPerSecond };
    let peak = 0;
    for (let i = 0; i < 120; i += 1) {
      // Hold off the snap to watch the free swing: step the lean spring only.
      const a = -AGENT_CURSOR_LEAN_SPRING.stiffness * m.lean.x - AGENT_CURSOR_LEAN_SPRING.damping * m.lean.v;
      m.lean.v += a * H;
      m.lean.x += m.lean.v * H;
      peak = Math.max(peak, Math.abs(m.lean.x));
    }
    expect(peak).toBeLessThan(AGENT_CURSOR_LEAN_REST.deg);
  });
});

describe('arrival is the tip at the target (GM - Design, PR #211 r2)', () => {
  it.each([100, 400, 900, 1500])('%s px: arrives once, within 2 px of the target, after the hand-off', (d) => {
    const to = { x: d, y: 0 };
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, to, { zoom: 1, pointer: null });
    let handOff = -1;
    let arrivals = 0;
    for (let i = 0; i < 400; i += 1) {
      const r = stepMotion(m, to, 1 / 60, { zoom: 1, reduced: false, opacityTarget: 1 });
      if (r.handedOff) handOff = i;
      if (r.arrived) {
        arrivals += 1;
        expect(handOff).toBeGreaterThanOrEqual(0);
        expect(i).toBeGreaterThan(handOff);
        expect(dist(m.pos, to)).toBeLessThanOrEqual(AGENT_CURSOR_ARRIVE_PX);
      } else if (arrivals === 0) {
        // Not arrived yet: still further than 2 px (checked at the frame's end).
        if (i > handOff && handOff >= 0) expect(dist(m.pos, to)).toBeGreaterThan(0);
      }
      if (r.atRest) break;
    }
    expect(AGENT_CURSOR_ARRIVE_PX).toBe(2);
    expect(arrivals).toBe(1);
  });

  it('a target that moves after landing is followed with no second arrival', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 300, y: 0 }, { zoom: 1, pointer: null });
    let arrivals = 0;
    for (let i = 0; i < 400; i += 1) if (stepMotion(m, { x: 300, y: 0 }, 1 / 60, { zoom: 1, reduced: false, opacityTarget: 1 }).arrived) arrivals += 1;
    for (let i = 0; i < 400; i += 1) if (stepMotion(m, { x: 310, y: 0 }, 1 / 60, { zoom: 1, reduced: false, opacityTarget: 1 }).arrived) arrivals += 1;
    expect(arrivals).toBe(1);
  });

  it('a frame gap past 0.25 s lands the tip unseen, with no arrival (GM - Design, PR #211 r5: no ring)', () => {
    expect(AGENT_CURSOR_STALE_GAP_SECONDS).toBe(0.25);
    for (const gap of [0.26, 1.5, 5]) {
      const m = createMotion({ x: 0, y: 0 }, 1);
      planMove(m, { x: 900, y: 0 }, { zoom: 1, pointer: null });
      stepMotion(m, { x: 900, y: 0 }, 1 / 60, { zoom: 1, reduced: false, opacityTarget: 1 });
      const r = stepMotion(m, { x: 900, y: 0 }, gap, { zoom: 1, reduced: false, opacityTarget: 1 });
      expect(r).toEqual({ arrived: false, handedOff: false, atRest: true, caughtUp: true });
      expect(m.pos).toEqual({ x: 900, y: 0 });
      expect(m.awaiting).toBe(false);
    }
    // Just under it: a slow frame, stepped as motion.
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 900, y: 0 }, { zoom: 1, pointer: null });
    const r = stepMotion(m, { x: 900, y: 0 }, 0.24, { zoom: 1, reduced: false, opacityTarget: 1 });
    expect(r.caughtUp).toBeUndefined();
    expect(m.pos.x).toBeLessThan(900);
  });

  it('a move to the spot it already rests on arrives on the next step, not after the progress spring', () => {
    const m = createMotion({ x: 50, y: 50 }, 1);
    planMove(m, { x: 50, y: 50 }, { zoom: 1, pointer: null });
    expect(m.plan).toBeNull();
    expect(stepMotion(m, { x: 50, y: 50 }, 1 / 60, { zoom: 1, reduced: false, opacityTarget: 1 }).arrived).toBe(true);
    // 1.5 screen px away at zoom 1 is still "there"; 3 px is a move.
    const near = createMotion({ x: 0, y: 0 }, 1);
    planMove(near, { x: 1.5, y: 0 }, { zoom: 1, pointer: null });
    expect(stepMotion(near, { x: 1.5, y: 0 }, 1 / 60, { zoom: 1, reduced: false, opacityTarget: 1 }).arrived).toBe(true);
    const far = createMotion({ x: 0, y: 0 }, 1);
    planMove(far, { x: 3, y: 0 }, { zoom: 1, pointer: null });
    expect(far.plan).not.toBeNull();
  });

  it('"already there" is 2 screen px at any zoom', () => {
    // At zoom 3, 1 flow px is 3 screen px: a move. At zoom 0.25, 6 flow px is 1.5: there.
    const near3 = createMotion({ x: 0, y: 0 }, 1);
    planMove(near3, { x: 1, y: 0 }, { zoom: 3, pointer: null });
    expect(near3.plan).not.toBeNull();
    const far025 = createMotion({ x: 0, y: 0 }, 1);
    planMove(far025, { x: 6, y: 0 }, { zoom: 0.25, pointer: null });
    expect(far025.plan).toBeNull();
  });

  it.each([0.25, 3])('arrives within 2 screen px, never 2 flow px, at zoom %s', (zoom) => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    const to = { x: 600 / zoom, y: 0 };
    planMove(m, to, { zoom, pointer: null });
    let arrivedAt: number | null = null;
    let lastGap = Infinity;
    for (let i = 0; i < 200 && arrivedAt === null; i += 1) {
      const before = Math.hypot(m.pos.x - to.x, m.pos.y - to.y) * zoom;
      if (stepMotion(m, to, 1 / 60, { zoom, reduced: false, opacityTarget: 1 }).arrived) {
        arrivedAt = Math.hypot(m.pos.x - to.x, m.pos.y - to.y) * zoom;
        lastGap = before;
      }
    }
    expect(arrivedAt).not.toBeNull();
    expect(arrivedAt!).toBeLessThanOrEqual(AGENT_CURSOR_ARRIVE_PX);
    // The step before was still farther than 2 screen px: arrival is the first frame within.
    expect(lastGap).toBeGreaterThan(AGENT_CURSOR_ARRIVE_PX);
  });
});

describe('long chords keep follow-through to 2 px (GM - Design, PR #211 r2)', () => {
  it.each([2000, 3000, 6000])('%s px runs at most 2 px past its target', (d) => {
    const flight = fly({ x: d, y: 0 });
    expect(AGENT_CURSOR_MAX_FOLLOW_THROUGH_PX).toBe(2);
    expect(flight.overshootPx).toBeLessThanOrEqual(2 + 1e-9);
    expect(flight.motion.pos).toEqual({ x: d, y: 0 });
  });
  it('accepted as measured (GM - Design, PR #211 r3): a 5K diagonal (2,940 px) rests by 1,050 ms, and no later change may make it slower', () => {
    // GM: 2560 × 1440 CSS px is about 2,940 px corner to corner, the
    // realistic worst case on one screen; about a second is within the calm
    // timing rule. No new spring constants.
    for (const to of [{ x: 2940, y: 0 }, { x: 2560, y: 1440 }]) {
      const flight = fly(to);
      expect(flight.restMs!).toBeLessThanOrEqual(1050 + 1e-6);
      expect(flight.overshootPx).toBeLessThanOrEqual(2 + 1e-9);
    }
    // The measured table in the notes: 2,000, 3,000 and 6,000 px.
    expect(fly({ x: 2000, y: 0 }).restMs!).toBeLessThanOrEqual(967 + 1e-6);
    expect(fly({ x: 3000, y: 0 }).restMs!).toBeLessThanOrEqual(1067 + 1e-6);
    expect(fly({ x: 6000, y: 0 }).restMs!).toBeLessThanOrEqual(1200 + 1e-6);
  });
  it('the diagonal 1500 px move stays within 2 px', () => {
    expect(fly({ x: 1500 / Math.SQRT2, y: 1500 / Math.SQRT2 }).overshootPx).toBeLessThanOrEqual(2);
  });
});

describe('screen px at any zoom (review 2, L4)', () => {
  it.each([0.25, 3])('a 3,000 screen-px chord at zoom %s still runs at most 2 screen px past', (zoom) => {
    const flight = fly({ x: 3000 / zoom, y: 0 }, { zoom });
    expect(flight.overshootPx).toBeLessThanOrEqual(2 + 1e-9);
    expect(flight.restMs!).toBeLessThanOrEqual(1067 + 1e-6);
  });
  it('arcGapPx is in screen px', () => {
    const a = { from: { x: 0, y: 0 }, control: { x: 50, y: 0 }, to: { x: 100, y: 0 } };
    const b = { from: { x: 0, y: 10 }, control: { x: 50, y: 10 }, to: { x: 100, y: 10 } };
    expect(arcGapPx(a, b, 1)).toBeCloseTo(10, 6);
    expect(arcGapPx(a, b, 3)).toBeCloseTo(30, 6);
    expect(arcGapPx(a, b, 0.25)).toBeCloseTo(2.5, 6);
  });
  it('a short move arrives only once its arc has handed off, not part way along it', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 3, y: 0 }, { zoom: 1, pointer: null });
    for (let i = 0; i < 120; i += 1) {
      const r = stepMotion(m, { x: 3, y: 0 }, 1 / 120, { zoom: 1, reduced: false, opacityTarget: 1 });
      if (r.arrived) {
        expect(m.plan).toBeNull();
        return;
      }
    }
    throw new Error('never arrived');
  });
});

describe('a target that keeps moving (GM - Design, PR #211 r5)', () => {
  const opts = { zoom: 1, reduced: false, opacityTarget: 1 };
  it('fires at first arrival on the target where it is now, then rides along on it at 0 px until the next event', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    let target = { x: 600, y: 0 };
    planMove(m, target, { zoom: 1, pointer: null });
    let firedAt: number | null = null;
    let firedOffset = 0;
    // The person drags the node down at 150 px/s from 100 ms in, and keeps going.
    for (let i = 1; i <= 240; i += 1) {
      if (i > 6) target = { x: 600, y: target.y + 150 / 60 };
      const r = stepMotion(m, target, 1 / 60, opts);
      if (r.arrived) {
        expect(firedAt).toBeNull(); // fires once
        firedAt = i / 60;
        firedOffset = Math.hypot(m.pos.x - target.x, m.pos.y - target.y);
      }
      if (firedAt !== null && i / 60 > firedAt + 0.5) {
        // Settled onto the target and riding it kinematically, at 0 px (round 4,
        // N1: an arrival never leaves a 1-2 px offset), not left behind.
        expect(m.attached).toEqual({ x: 0, y: 0 });
        expect(m.pos).toEqual(target);
      }
    }
    // It fired while the drag was still going (it never stops in this test).
    expect(firedAt).not.toBeNull();
    expect(firedAt!).toBeLessThan(1.5);
    expect(firedOffset).toBeLessThanOrEqual(AGENT_CURSOR_ARRIVE_PX);
    // A new event ends the ride: it flies to the new target and arrives there.
    planMove(m, { x: 0, y: 0 }, { zoom: 1, pointer: null });
    expect(m.attached).toBeNull();
  });

  it('a still target still lands exactly on it', () => {
    const flight = fly({ x: 400, y: 0 });
    expect(flight.motion.pos).toEqual({ x: 400, y: 0 });
    expect(flight.motion.attached).toBeNull();
  });

  it.each([5, 15, 23])('a resting cursor whose node is dragged %s px a frame rides along and never flies an arc', (perFrame) => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 0, y: 0 }, { zoom: 1, pointer: null });
    for (let i = 0; i < 10; i += 1) stepMotion(m, { x: 0, y: 0 }, 1 / 60, opts);
    let flew = false;
    for (let i = 1; i <= 60; i += 1) {
      stepMotion(m, { x: perFrame * i, y: 0 }, 1 / 60, opts);
      if (m.plan) flew = true;
    }
    expect(flew).toBe(false);
  });

  it('a jump of the target (a sync, not a drag) flies there again', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 300, y: 0 }, { zoom: 1, pointer: null });
    for (let i = 0; i < 90; i += 1) stepMotion(m, { x: 300, y: 0 }, 1 / 60, opts);
    stepMotion(m, { x: 300, y: 300 }, 1 / 60, opts);
    expect(m.plan).not.toBeNull();
  });
});

describe('three or more flights (GM - Design, PR #211 r5): the side with the most room against every flight', () => {
  const opts = { zoom: 1, pointer: null };
  const interiorRoom = (plan: { from: Point; control: Point; to: Point }, others: { from: Point; control: Point; to: Point }[]) =>
    Math.min(...others.map((o) => arcGapPx(plan, o, 1, [0.2, 0.8])));
  it('review 2\'s three flights: C never shares B\'s flipped arc', () => {
    const a = createMotion({ x: 0, y: 0 }, 1);
    planMove(a, { x: 800, y: 0 }, opts);
    for (let i = 0; i < 3; i += 1) stepMotion(a, { x: 800, y: 0 }, 1 / 60, { ...opts, reduced: false, opacityTarget: 1 });
    const b = createMotion({ x: 800, y: 0 }, 1);
    planMove(b, { x: 0, y: 0 }, { ...opts, others: [a.plan!] });
    expect(b.plan!.control.y).toBeGreaterThan(0); // flipped down, clear of A
    const c = createMotion({ x: 0, y: 4 }, 1);
    planMove(c, { x: 800, y: 4 }, { ...opts, others: [a.plan!, b.plan!] });
    const up = cursorBow({ x: 0, y: 4 }, { x: 800, y: 4 }, null, 1);
    const down = cursorBow({ x: 0, y: 4 }, { x: 800, y: 4 }, null, 1, true);
    const roomUp = interiorRoom({ from: { x: 0, y: 4 }, control: up, to: { x: 800, y: 4 } }, [a.plan!, b.plan!]);
    const roomDown = interiorRoom({ from: { x: 0, y: 4 }, control: down, to: { x: 800, y: 4 } }, [a.plan!, b.plan!]);
    const chosen = interiorRoom(c.plan!, [a.plan!, b.plan!]);
    expect(chosen).toBe(Math.max(roomUp, roomDown) > roomUp ? roomDown : roomUp);
    expect(chosen).toBeGreaterThanOrEqual(Math.min(roomUp, roomDown));
  });

  it('a flight blocked by the second of two others takes the clear side; a crowded side with more room than the other is kept', () => {
    const from = { x: 0, y: 0 };
    const to = { x: 800, y: 0 };
    const line = (y: number) => ({ from: { x: 0, y }, control: { x: 400, y }, to: { x: 800, y }, aimed: { x: 800, y },
      durationMs: 800, omega: 8, v0: 0, elapsed: 0 });
    const up = cursorBow(from, to, null, 1);
    const down = cursorBow(from, to, null, 1, true);
    expect(up.y).toBeLessThan(0);
    // A far flight first, then one the usual (up) arc crosses: the down side is clear.
    expect(bowAgainst(from, to, null, 1, [line(600), line(-60)])).toEqual(down);
    expect(bowAgainst(from, to, null, 1, [line(-60), line(600)])).toEqual(down);
    // Up is crowded (20 px from a flight above) but down crosses one below: up has more room.
    expect(bowAgainst(from, to, null, 1, [line(-100), line(60)])).toEqual(up);
  });

  it('checks every flight, not only the first: a fourth flight clear of three keeps its side; one blocked on both sides by different flights takes the roomier one', () => {
    const fly0 = (from: Point, to: Point, others: ReturnType<typeof createMotion>['plan'][] = []) => {
      const m = createMotion(from, 1);
      planMove(m, to, { ...opts, others: others as never });
      return m.plan!;
    };
    const a = fly0({ x: 0, y: 0 }, { x: 800, y: 0 });
    const far = fly0({ x: 0, y: 600 }, { x: 800, y: 600 }, [a]);
    expect(far.control.y).toBeLessThan(600); // clear: default up
    // Blocked above by A only when it bows up; below by a flight 60 px down.
    const below = fly0({ x: 0, y: 120 }, { x: 800, y: 120 });
    const d = fly0({ x: 0, y: 30 }, { x: 800, y: 30 }, [far, below, a]);
    const up = cursorBow({ x: 0, y: 30 }, { x: 800, y: 30 }, null, 1);
    const down = cursorBow({ x: 0, y: 30 }, { x: 800, y: 30 }, null, 1, true);
    const room = (control: Point) => interiorRoom({ from: { x: 0, y: 30 }, control, to: { x: 800, y: 30 } }, [far, below, a]);
    expect(room(d.control)).toBe(Math.max(room(up), room(down)));
    // With nothing in flight the default side stands.
    expect(bowAgainst({ x: 0, y: 30 }, { x: 800, y: 30 }, null, 1, [])).toEqual(up);
  });
});

describe('crossing flights bow apart (GM - Design, PR #211 r2)', () => {
  const opts = { zoom: 1, pointer: null };
  it('a later flight that would cross another still flying bows the other way', () => {
    expect(AGENT_CURSOR_CROSS_PX).toBe(24);
    const a = createMotion({ x: 0, y: 400 }, 1);
    planMove(a, { x: 800, y: 400 }, opts);
    // B flies the other way 15 px lower: on its usual screen-up bow its
    // apex would sit 15 px under A's, closer than 24 px along the way.
    const usual = createMotion({ x: 800, y: 415 }, 1);
    planMove(usual, { x: 0, y: 415 }, opts);
    expect(arcGapPx(a.plan!, usual.plan!, 1)).toBeLessThan(AGENT_CURSOR_CROSS_PX);
    const b = createMotion({ x: 800, y: 415 }, 1);
    planMove(b, { x: 0, y: 415 }, { ...opts, others: [a.plan!] });
    // A bows up (screen-up), B the other way: down, clear of A.
    expect(a.plan!.control.y).toBeLessThan(400);
    expect(b.plan!.control.y).toBeGreaterThan(415);
    expect(arcGapPx(a.plan!, b.plan!, 1)).toBeGreaterThanOrEqual(15 - 1e-9);
    // Same 10% cap: 80 px apex off the chord.
    expect(Math.abs(b.plan!.control.y - 415) / 2).toBeCloseTo(80, 6);
  });
  it('a flight far from the others keeps its usual side', () => {
    const a = createMotion({ x: 0, y: 0 }, 1);
    planMove(a, { x: 800, y: 0 }, opts);
    const b = createMotion({ x: 0, y: 600 }, 1);
    planMove(b, { x: 800, y: 600 }, { ...opts, others: [a.plan!] });
    expect(b.plan!.control.y).toBeLessThan(600);
  });
  it('with no flight under way, nothing changes', () => {
    const b = createMotion({ x: 800, y: 400 }, 1);
    planMove(b, { x: 0, y: 400 }, { ...opts, others: [] });
    expect(b.plan!.control.y).toBeLessThan(400);
  });
});

describe('pinned values', () => {
  it('entrance 64 px, idle 0.45, the fade spring k 170 / c 26', () => {
    expect(AGENT_CURSOR_ENTRANCE_PX).toBe(64);
    expect(AGENT_CURSOR_IDLE_OPACITY).toBe(0.45);
    expect(AGENT_CURSOR_FADE_SPRING).toEqual({ stiffness: 170, damping: 26, mass: 1 });
  });
  it('steps in place: no new position or velocity objects per frame', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 400, y: 0 }, { zoom: 1, pointer: null });
    const { pos, vel } = m;
    for (let i = 0; i < 30; i += 1) stepMotion(m, { x: 400, y: 0 }, 1 / 60, { zoom: 1, reduced: false, opacityTarget: 1 });
    expect(m.pos).toBe(pos);
    expect(m.vel).toBe(vel);
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
      if (result.handedOff) break;
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
    for (let i = 0; i < 400 && !step(m, { x: 400, y: 0 }).handedOff; i += 1);
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
    // Carried with it, kinematically (round 4): no spring, so on it at once.
    step(m, { x: 10, y: 0 });
    expect(m.landing).toBeNull();
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

describe('riding a dragged node stops dead with it (GM - Design, PR #211 r9 item 2; review 3, M1 and N1)', () => {
  const opts = { zoom: 1, reduced: false, opacityTarget: 1 };
  const rest = (at: Point) => {
    const m = createMotion(at, 1);
    stepMotion(m, at, 1 / 60, opts);
    return m;
  };
  /** Drag the target `perFrame` px a frame for `frames`, stop, and report the
   *  most the tip ever went past the target along the drag, and after the stop. */
  const dragAndStop = (m: CursorMotion, from: Point, perFrame: number, frames = 40) => {
    let target = { ...from };
    let pastDuring = -Infinity;
    for (let i = 1; i <= frames; i += 1) {
      target = { x: from.x + perFrame * i, y: from.y };
      stepMotion(m, target, 1 / 60, opts);
      pastDuring = Math.max(pastDuring, m.pos.x - target.x);
    }
    let pastAfter = -Infinity;
    for (let i = 0; i < 120; i += 1) {
      stepMotion(m, target, 1 / 60, opts);
      pastAfter = Math.max(pastAfter, m.pos.x - target.x);
    }
    return { pastDuring, pastAfter, target };
  };

  it.each([4, 12, 20])('a resting cursor on a node dragged %s px a frame stops 0 px past it', (perFrame) => {
    const m = rest({ x: 100, y: 50 });
    const { pastDuring, pastAfter, target } = dragAndStop(m, { x: 100, y: 50 }, perFrame);
    expect(pastDuring).toBe(0);
    expect(pastAfter).toBe(0);
    expect(m.pos).toEqual(target);
    expect(m.plan).toBeNull();
    expect(m.landing).toBeNull();
  });

  it.each([40, 80])('the person dragging the node %s px a frame: a resting tip rides it every frame and stops dead (no re-plan)', (perFrame) => {
    const m = rest({ x: 0, y: 0 });
    let target = { x: 0, y: 0 };
    for (let i = 1; i <= 30; i += 1) {
      target = { x: perFrame * i, y: 0 };
      stepMotion(m, target, 1 / 60, { ...opts, dragged: true });
      expect(m.plan).toBeNull();
      expect(m.pos).toEqual(target);
    }
    for (let i = 0; i < 60; i += 1) {
      stepMotion(m, target, 1 / 60, opts);
      expect(m.pos).toEqual(target);
    }
    // Not the person's drag (a sync), a jump that size flies there again.
    const synced = rest({ x: 0, y: 0 });
    stepMotion(synced, { x: perFrame, y: 0 }, 1 / 60, opts);
    expect(synced.plan).not.toBeNull();
  });

  it('a single 20 px nudge of a resting target: 0 px past it', () => {
    const m = rest({ x: 0, y: 0 });
    let past = -Infinity;
    stepMotion(m, { x: 20, y: 0 }, 1 / 60, opts);
    for (let i = 0; i < 120; i += 1) {
      stepMotion(m, { x: 20, y: 0 }, 1 / 60, opts);
      past = Math.max(past, m.pos.x - 20);
    }
    expect(past).toBe(0);
    expect(m.pos).toEqual({ x: 20, y: 0 });
  });

  it.each([4, 12, 20])('a cursor that lands on a node while it is dragged %s px a frame rides it at 0 px and stops dead', (perFrame) => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    const from = { x: 500, y: 0 };
    planMove(m, from, { zoom: 1, pointer: null });
    // The drag starts as the flight does and lasts long enough to land on it.
    let arrivedAt = -1;
    let target = { ...from };
    for (let i = 1; i <= 90; i += 1) {
      target = { x: from.x + perFrame * i, y: 0 };
      if (stepMotion(m, target, 1 / 60, opts).arrived) arrivedAt = i;
    }
    expect(arrivedAt).toBeGreaterThan(0);
    expect(m.attached).toEqual({ x: 0, y: 0 });
    expect(m.pos).toEqual(target);
    let past = -Infinity;
    for (let i = 0; i < 120; i += 1) {
      stepMotion(m, target, 1 / 60, opts);
      past = Math.max(past, m.pos.x - target.x);
    }
    expect(past).toBe(0);
  });

  it('a drag that stops while the tip is still settling after its arrival: it stops with the node, never past it', () => {
    // Arrive on a node moving 12 px a frame, then stop the drag 2 frames later.
    for (const extra of [1, 2, 4]) {
      const m = createMotion({ x: 0, y: 0 }, 1);
      planMove(m, { x: 400, y: 0 }, { zoom: 1, pointer: null });
      let target = { x: 400, y: 0 };
      let i = 0;
      let left = -1;
      for (; i < 200; i += 1) {
        target = { x: 400 + 12 * (i + 1), y: 0 };
        if (stepMotion(m, target, 1 / 60, opts).arrived) left = extra;
        if (left >= 0 && (left -= 1) < 0) break;
      }
      let past = -Infinity;
      for (let k = 0; k < 120; k += 1) {
        stepMotion(m, target, 1 / 60, opts);
        past = Math.max(past, m.pos.x - target.x);
      }
      expect(past).toBeLessThanOrEqual(0);
      expect(m.pos).toEqual(target);
    }
  });

  it('after a drag a resting cursor sits exactly on its spot, with no new offset (N1)', () => {
    const m = rest({ x: 110, y: 44 });
    for (let k = 0; k < 4; k += 1) {
      const back = k % 2 === 1;
      for (let i = 1; i <= 60; i += 1) stepMotion(m, { x: 110 + (back ? 300 - 5 * i : 5 * i), y: 44 }, 1 / 60, opts);
      for (let i = 0; i < 30; i += 1) stepMotion(m, { x: back ? 110 : 410, y: 44 }, 1 / 60, opts);
      expect(m.pos).toEqual({ x: back ? 110 : 410, y: 44 });
    }
  });

  it('rides at the de-stack offset its spot has on the node, and a de-stack shift lands on the spring, not a jump', () => {
    const node = { x: 200, y: 100 };
    const spot = { x: 210, y: 110 };
    const m = createMotion(spot, 1);
    stepMotion(m, spot, 1 / 60, { ...opts, carrier: node });
    // The node is dragged: the tip is carried at its spot.
    for (let i = 1; i <= 30; i += 1) {
      stepMotion(m, { x: spot.x + 12 * i, y: spot.y }, 1 / 60, { ...opts, carrier: { x: node.x + 12 * i, y: node.y } });
      expect(m.pos).toEqual({ x: spot.x + 12 * i, y: spot.y });
    }
    // The other cursor leaves: the spot moves back onto the node. That is a
    // short landing on the land spring, not a jump.
    const still = { x: node.x + 360, y: node.y };
    stepMotion(m, still, 1 / 60, { ...opts, carrier: still });
    expect(m.landing).not.toBeNull();
    expect(dist(m.pos, still)).toBeGreaterThan(5);
    // The shift is the spot's, not the node's speed: no kick, so it lands
    // like any short landing from rest (under 0.3 px past).
    const along = { x: -10 / Math.SQRT2 / 10, y: -10 / Math.SQRT2 / 10 };
    let past = 0;
    for (let i = 0; i < 200 && !stepMotion(m, still, 1 / 60, { ...opts, carrier: still }).atRest; i += 1) {
      past = Math.max(past, (m.pos.x - still.x) * along.x + (m.pos.y - still.y) * along.y);
    }
    expect(past).toBeLessThan(0.3);
    expect(m.pos).toEqual(still);
  });

  it("the agent's next action releases the ride and flies on the planner", () => {
    const m = rest({ x: 0, y: 0 });
    dragAndStop(m, { x: 0, y: 0 }, 12);
    expect(m.attached).not.toBeNull();
    planMove(m, { x: 900, y: 0 }, { zoom: 1, pointer: null });
    expect(m.attached).toBeNull();
    expect(m.plan).not.toBeNull();
  });
});

describe('a fling holds the action no later than the drag\'s end (GM - Design, PR #211 r9 item 5)', () => {
  const opts = { zoom: 1, reduced: false, opacityTarget: 1 };

  it('fires at the tip within the drag-end time after a 30 px-a-frame drag stops, once', () => {
    expect(AGENT_CURSOR_DRAG_END_SECONDS).toBe(0.03);
    for (const perFrame of [30, 60]) {
      const m = createMotion({ x: 0, y: 0 }, 1);
      planMove(m, { x: 400, y: 0 }, { zoom: 1, pointer: null });
      let arrivals = 0;
      let target = { x: 400, y: 0 };
      for (let i = 1; i <= 40; i += 1) {
        target = { x: 400 + perFrame * i, y: 0 };
        if (stepMotion(m, target, 1 / 60, opts).arrived) arrivals += 1;
      }
      // Held all through the fling: the tip never caught a target jumping 30 px a frame.
      expect(arrivals).toBe(0);
      expect(m.held).toBe(true);
      let firedFrame = -1;
      let firedAt: Point | null = null;
      for (let i = 1; i <= 120; i += 1) {
        if (stepMotion(m, target, 1 / 60, opts).arrived) {
          arrivals += 1;
          if (firedFrame < 0) {
            firedFrame = i;
            firedAt = { ...m.pos };
          }
        }
      }
      // The drag ended at frame 0: it fires by the second still frame (0.033 s).
      expect(firedFrame).toBe(2);
      expect(arrivals).toBe(1);
      // At the tip, wherever it was: still on its way, not at the node.
      expect(dist(firedAt!, target)).toBeGreaterThan(AGENT_CURSOR_ARRIVE_PX);
      // The tip still lands on the node, with no second arrival.
      expect(m.pos).toEqual(target);
    }
  });

  it('a one-frame jump mid-flight (a sync) is no fling: the action fires on arrival at the target', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 400, y: 0 }, { zoom: 1, pointer: null });
    for (let i = 0; i < 10; i += 1) stepMotion(m, { x: 400, y: 0 }, 1 / 60, opts);
    let firedFar = false;
    let arrivals = 0;
    for (let i = 0; i < 200; i += 1) {
      const r = stepMotion(m, { x: 400, y: 300 }, 1 / 60, opts);
      if (r.arrived) {
        arrivals += 1;
        if (dist(m.pos, { x: 400, y: 300 }) > AGENT_CURSOR_ARRIVE_PX) firedFar = true;
      }
    }
    expect(firedFar).toBe(false);
    expect(arrivals).toBe(1);
  });

  it('a slow drag (under the re-plan distance a frame) is no fling: it arrives on the moving target', () => {
    const m = createMotion({ x: 0, y: 0 }, 1);
    planMove(m, { x: 400, y: 0 }, { zoom: 1, pointer: null });
    let target = { x: 400, y: 0 };
    let arrivedOn = false;
    for (let i = 1; i <= 120; i += 1) {
      target = { x: 400 + 12 * i, y: 0 };
      if (stepMotion(m, target, 1 / 60, opts).arrived) arrivedOn = dist(m.pos, target) <= AGENT_CURSOR_ARRIVE_PX;
    }
    expect(m.held).toBe(false);
    expect(arrivedOn).toBe(true);
  });
});
