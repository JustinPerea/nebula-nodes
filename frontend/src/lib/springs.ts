/**
 * Tuned springs for CSS motion, sampled the way GM's mockups time them.
 *
 * `springEase` is the mockup's sampler (moodboard-canvas-video/index.html):
 * a damped spring's closed-form position, timed to where it settles within
 * 0.001, with the small remainder spread out so it lands on exactly 1.
 * `springLinear` turns that into a CSS `linear()` easing and a duration, so a
 * stylesheet can run the same curve with no JavaScript per frame.
 *
 * The Updates corner (PR9a) uses POP for what arrives and SOFT for what
 * leaves. The moodboard canvas (PR6) adds its tokens here; its specs are
 * written as stiffness and damping, so `springFromStiffness` converts them.
 */

export interface SpringSpec {
  /** Seconds per oscillation of the undamped spring (SwiftUI's `response`). */
  response: number;
  /** 1 is critically damped (no overshoot); below 1 overshoots a little. */
  dampingFraction: number;
}

export interface SampledSpring {
  /** Seconds until the spring settles. */
  duration: number;
  /** Progress 0..1 in, position out (1 at the end, may pass 1 on the way). */
  ease: (progress: number) => number;
}

/** The mockup's POP: "alive, not bouncy". Cards, the list, the count. */
export const SPRING_POP: SpringSpec = { response: 0.42, dampingFraction: 0.85 };

/**
 * Leaving: critically damped and a little quicker, so nothing bounces on the
 * way out (replaces the mockup's `power2.in`, per Nebula's motion rule).
 */
export const SPRING_SOFT: SpringSpec = { response: 0.3, dampingFraction: 1 };

export function springEase({ response, dampingFraction }: SpringSpec): SampledSpring {
  const w = (2 * Math.PI) / response;
  const z = dampingFraction;
  let pos: (t: number) => number;
  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z);
    pos = (t) => 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
  } else if (z > 1) {
    const wo = w * Math.sqrt(z * z - 1);
    pos = (t) => 1 - Math.exp(-z * w * t) * (Math.cosh(wo * t) + ((z * w) / wo) * Math.sinh(wo * t));
  } else {
    pos = (t) => 1 - Math.exp(-w * t) * (1 + w * t);
  }
  const EPS = 0.001;
  const rate = z <= 1 ? z * w : (z - Math.sqrt(z * z - 1)) * w;
  const SCAN = 12 / rate;
  const N = 4800;
  let T = SCAN;
  for (let i = N; i >= 0; i -= 1) {
    const t = (i / N) * SCAN;
    if (Math.abs(1 - pos(t)) > EPS) {
      T = ((i + 1) / N) * SCAN;
      break;
    }
  }
  const xT = pos(T);
  return { duration: T, ease: (p) => pos(p * T) + p * (1 - xT) };
}

/** Stiffness k and damping c (mass m) as response and damping fraction. */
export function springFromStiffness(stiffness: number, damping: number, mass = 1): SpringSpec {
  const omega = Math.sqrt(stiffness / mass);
  return { response: (2 * Math.PI) / omega, dampingFraction: damping / (2 * Math.sqrt(stiffness * mass)) };
}

export interface LinearSpring {
  durationMs: number;
  /** A CSS easing: `linear(0, …, 1)`. */
  easing: string;
}

const cache = new Map<string, LinearSpring>();

/** The spring as a CSS `linear()` easing, sampled every ~16 ms (at least 24 points). */
export function springLinear(spec: SpringSpec): LinearSpring {
  const key = `${spec.response}:${spec.dampingFraction}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const { duration, ease } = springEase(spec);
  const durationMs = Math.round(duration * 1000);
  const steps = Math.max(24, Math.ceil(durationMs / 16));
  const points: string[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const value = i === 0 ? 0 : i === steps ? 1 : ease(i / steps);
    points.push(String(Math.round(value * 1000) / 1000));
  }
  const curve = { durationMs, easing: `linear(${points.join(', ')})` };
  cache.set(key, curve);
  return curve;
}

/**
 * The tokens as custom properties, for a component's root `style`:
 * `animation: x var(--spring-pop-ms) var(--spring-pop) both`.
 */
export function springCssVars(): Record<`--${string}`, string> {
  const pop = springLinear(SPRING_POP);
  const soft = springLinear(SPRING_SOFT);
  return {
    '--spring-pop': pop.easing,
    '--spring-pop-ms': `${pop.durationMs}ms`,
    '--spring-soft': soft.easing,
    '--spring-soft-ms': `${soft.durationMs}ms`,
  };
}
