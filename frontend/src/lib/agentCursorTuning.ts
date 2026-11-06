/**
 * Every tunable (t) number of the agent cursor, in one place, each beside the
 * line of GM - Design's cursor spec (.planning/private/cursor-design.md) it
 * comes from, so a retune is a one-line diff here (GM r49, ask 1).
 *
 * Phase 1's motion numbers live here too (the planner re-exports them under
 * their old names). Values marked "build" are not numbered in the spec: the
 * build picked them, and they are open to GM's retune like the rest.
 *
 * No imports, so the planner, the layer, the expression state machine and
 * the dev-only states driver can all read it without pulling in each other.
 */

/** Stiffness, damping and mass, as agentCursorMotion's SpringConfig. */
export interface TuningSpring {
  stiffness: number;
  damping: number;
  mass: number;
}

// ── Phase 1: movement (§3) ────────────────────────────────────────────────

/** §3 "a quadratic arc bowed 10% of the chord (t), capped at 120 px, and straight under 24 px";
 *  "away from the person's pointer when it's within 200 px of the path's midpoint". */
export const AGENT_CURSOR_BOW = { fraction: 0.1, maxPx: 120, straightUnderPx: 24, pointerRadiusPx: 200 } as const;
/** §3 "T = clamp(380 + 170·ln(1 + D/200), 380, 900) ms (t)". */
export const AGENT_CURSOR_DURATION = { baseMs: 380, gainMs: 170, scalePx: 200, minMs: 380, maxMs: 900 } as const;
/** §3 "AGENT_CURSOR_LAND_SPRING k 260 / c 26 (ζ ≈ 0.8) (t)". */
export const AGENT_CURSOR_LAND_SPRING: TuningSpring = { stiffness: 260, damping: 26, mass: 1 };
/** §3 "The arrow leans toward its velocity, up to 10° (t)". Built as
 *  14° × tanh(vx / 700) × min(1, speed / 250) in Phase 1, which peaks at
 *  6°, 12° and 14° at 100, 400 and 900 px: GM's measured prototype peaks
 *  (docs/notes/2026-10-31-feat-agent-cursor-foundations.md). Left as built. */
export const AGENT_CURSOR_LEAN = { maxDeg: 14, vxScale: 700, fullSpeed: 250 } as const;
/** §3 "through a spring on the angle (k 180 / c 22 (t))". */
export const AGENT_CURSOR_LEAN_SPRING: TuningSpring = { stiffness: 180, damping: 22, mass: 1 };

// ── Phase 2: expression (§1, §2) ──────────────────────────────────────────

/** §1 "One copy of the arrow's shape, blurred (SVG feGaussianBlur stdDeviation 3),
 *  in the agent colour at 30% opacity, under the arrow." */
export const AGENT_CURSOR_HALO = { blur: 3, opacity: 0.3 } as const;

/** The mark slot (propose, wait), GM r56 item C: right of the arrow, its top
 *  level with the tip, at least clearPx from the arrow, the dashed halo
 *  (both strokes included) and its own pills. 21 px is the nearest whole
 *  px that keeps the grown dashed halo 2 px off (agentCursorLayer's mark
 *  clearance test measures it). Replaces §1's (14, 14) offset, whose box
 *  touched the pill's top-left corner. */
export const AGENT_CURSOR_MARK = { leftPx: 21, topPx: 1.5, boxPx: 12, clearPx: 2 } as const;

/** §2 "A held state shows for at least 0.4 s, so a short tool call still registers." */
export const AGENT_CURSOR_MIN_HOLD_MS = 400;

/** §2 look: "the halo dims to 18% and a 90° bright arc on it sweeps once around
 *  (one turn, 1.4 s (t), then rests)". Build: the arc's radius, its stroke
 *  and its opacity. */
export const AGENT_CURSOR_LOOK = { dimOpacity: 0.18, arcDeg: 90, sweepMs: 1400, radiusPx: 13, strokePx: 3, arcOpacity: 0.9 } as const;

/** §2 think: "the halo breathes ... on a spring-sampled loop of about 2.2 s
 *  (t), while held". GM r58 (after r56's 1 → 1.15, 55% → 25% still read flat
 *  at 4×): the glow swings between a trough (the resting halo's 3 px blur,
 *  scale 1, 20%) and a peak (5 px blur, scale 1.25, 60%), the scale anchored
 *  at the arrow's centre so the glow grows evenly; it may reach about 3 px
 *  above the tip (the 2 px floor covers painted shapes, not the blur). The
 *  reduced-motion still frame holds the peak. Each half of the loop runs the
 *  build's breath spring stretched to half the loop. */
export const AGENT_CURSOR_THINK = {
  troughOpacity: 0.2,
  peakOpacity: 0.6,
  troughBlurPx: AGENT_CURSOR_HALO.blur,
  peakBlurPx: 5,
  peakScale: 1.25,
  loopMs: 2200,
} as const;
/** Build: the curve of each half breath (critically damped). */
export const AGENT_CURSOR_THINK_SPRING: TuningSpring = { stiffness: 40, damping: 12.6, mass: 1 };

/** §2 type: "a caret in the target field: 1.5 px × line height, in the agent
 *  colour, at the end of the text, blinking at 1.06 s while text arrives,
 *  solid while held, gone 0.4 s after the last keystroke"; "A param edit …
 *  gets a 2 px agent-colour underline under the edited row's value". */
export const AGENT_CURSOR_TYPE = { caretPx: 1.5, blinkMs: 1060, lingerMs: 400, underlinePx: 2 } as const;

/** §2 click: "the arrow presses to 0.88 on a stiff spring and springs back.
 *  A ring blooms from the tip: radius 4 → 20 px, stroke 2 → 0.5 px, opacity
 *  0.7 → 0 (t), all on one spring". */
export const AGENT_CURSOR_CLICK = {
  pressScale: 0.88,
  ringFromPx: 4,
  ringToPx: 20,
  strokeFromPx: 2,
  strokeToPx: 0.5,
  opacityFrom: 0.7,
} as const;
/** Build: "a stiff spring" for the press (critically damped, about 0.2 s). */
export const AGENT_CURSOR_PRESS_SPRING: TuningSpring = { stiffness: 900, damping: 60, mass: 1 };
/** Build: the ring's "one spring" (the fade spring the old ripple ran on). */
export const AGENT_CURSOR_RING_SPRING: TuningSpring = { stiffness: 170, damping: 26, mass: 1 };

/** §2 drag: "the wire is the real canvas bezier, from the port, trailing the
 *  cursor on a lag spring so it visibly gets pulled". Build: the lag spring
 *  (ζ ≈ 0.92, about 0.06 s behind the tip at speed, so the end trails the
 *  arrow without leaving it) and the wire's width in flow units, like an edge. */
export const AGENT_CURSOR_WIRE_SPRING: TuningSpring = { stiffness: 900, damping: 55, mass: 1 };
export const AGENT_CURSOR_WIRE = { strokePx: 2 } as const;

/** §2 run: "the halo becomes a thin arc orbiting the arrow for one turn (1.2 s (t)),
 *  then rest". Build: the arc's length, radius and stroke. */
export const AGENT_CURSOR_RUN = { orbitMs: 1200, arcDeg: 120, radiusPx: 15, strokePx: 1.5 } as const;

/** §2 propose / wait: "the halo turns dashed". Build: the dashed outline is
 *  the arrow's shape grown about its middle, with this dash. */
export const AGENT_CURSOR_DASHED = { grow: 1.45, strokePx: 1.5, dashPx: 3, gapPx: 2.5, opacity: 0.95 } as const;

/** §2 error: "one sideways shake, ±4 px on a low-damping spring (t), and the
 *  halo flashes --sr-danger once (400 ms)". Build: the flash's peak opacity. */
export const AGENT_CURSOR_ERROR = { shakePx: 4, flashMs: 400, flashOpacity: 0.65 } as const;
/** Build: the shake's low-damping spring (ζ ≈ 0.22). */
export const AGENT_CURSOR_SHAKE_SPRING: TuningSpring = { stiffness: 520, damping: 10, mass: 1 };

// ── Say timing (GM r54) ───────────────────────────────────────────────────

/** GM r54: "The agent's own says hold for max(3 s, 60 ms × characters),
 *  capped at 8 s (t)." Default lines take the same rule, unless their state
 *  holds them longer (think while held, propose and wait until resolved). */
export const AGENT_CURSOR_SAY_HOLD = { minMs: 3000, perCharMs: 60, maxMs: 8000 } as const;

/** Build (GM r54 item 2): an error's default line names what failed from the
 *  agent's last action (its `did`) only when that action was on the same node
 *  within this long; else the cause is unknown ("Couldn’t do that"). */
export const AGENT_CURSOR_ERROR_CAUSE_MS = 60_000;
