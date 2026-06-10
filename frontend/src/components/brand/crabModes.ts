import type { CrabDot } from './crabGeometry';

/**
 * Motion modes for the animated Crab mark.
 *
 * Each mode receives elapsed seconds + refs and writes SVG attributes
 * directly to the DOM — no React re-render per frame. Kept in their own
 * module (separate from the component) so the component file stays
 * component-only for React Fast Refresh, and so the showcase can read the
 * mode metadata without importing the component.
 *
 *   refs.g       — the wrapping <g> for transform-based effects
 *   refs.dots    — precomputed base dot values (never mutated)
 *   refs.circles — <circle> DOM nodes, parallel to dots
 */

export type MarkMode =
  | 'breathe'
  | 'twinkle'
  | 'pulse'
  | 'scan'
  | 'drift'
  | 'boot'
  | 'thinking';

export type ModeRefs = {
  g: SVGGElement | null;
  dots: CrabDot[];
  circles: (SVGCircleElement | null)[];
};

export type ModeMeta = {
  label: string;
  /** State the motion communicates — shown in the showcase telemetry. */
  state: string;
  /** One-line rationale for when to use it. */
  desc: string;
  /** Writes attributes to the DOM for time `t` (seconds since start). */
  apply: (t: number, refs: ModeRefs) => void;
};

export const MARK_MODES: Record<MarkMode, ModeMeta> = {
  breathe: {
    label: 'Breathe',
    state: 'AT REST',
    desc: 'Idle. A 4% scale pulse on a 4.5s loop — the mark looks alive without moving.',
    apply: (t, refs) => {
      const scale = 1 + 0.04 * Math.sin(t * 1.4);
      if (refs.g) {
        refs.g.setAttribute(
          'transform',
          `translate(100 100) scale(${scale}) translate(-100 -100)`,
        );
      }
    },
  },
  twinkle: {
    label: 'Twinkle',
    state: 'AMBIENT',
    desc: 'Per-dot opacity flicker on positional phase. Observational, atmospheric.',
    apply: (t, refs) => {
      for (let i = 0; i < refs.dots.length; i++) {
        const d = refs.dots[i];
        const phase = d.x * 0.21 + d.y * 0.37;
        const flicker = 0.55 + 0.45 * Math.sin(t * 2.5 + phase);
        refs.circles[i]?.setAttribute('opacity', String(d.op * flicker));
      }
    },
  },
  pulse: {
    label: 'Pulse wave',
    state: 'EXECUTING',
    desc: 'Brightness wave traveling outward from the center. Use when a graph executes.',
    apply: (t, refs) => {
      const waveR = (t * 32) % 130;
      for (let i = 0; i < refs.dots.length; i++) {
        const d = refs.dots[i];
        const dist = Math.abs(d.radius - waveR);
        const boost = Math.exp((-dist * dist) / 80) * 0.85;
        const c = refs.circles[i];
        if (!c) continue;
        c.setAttribute('opacity', String(Math.min(1, d.op + boost)));
        c.setAttribute('r', String(d.r * (1 + boost * 0.4)));
      }
    },
  },
  scan: {
    label: 'Radar sweep',
    state: 'SEARCHING',
    desc: 'Angular scan with a 1.4-radian trailing afterglow. Discovery, search.',
    apply: (t, refs) => {
      const scanAngle = ((t * 1.0) % (Math.PI * 2)) - Math.PI;
      for (let i = 0; i < refs.dots.length; i++) {
        const d = refs.dots[i];
        let diff = d.angle - scanAngle;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        let boost = 0;
        if (diff <= 0 && diff > -1.4) {
          boost = (1 + diff / 1.4) * 0.9;
        }
        refs.circles[i]?.setAttribute(
          'opacity',
          String(Math.min(1, d.op + boost)),
        );
      }
    },
  },
  drift: {
    label: 'Drift',
    state: 'AMBIENT',
    desc: 'Sub-pixel positional jitter from deterministic per-dot phase. Pure atmosphere.',
    apply: (t, refs) => {
      for (let i = 0; i < refs.dots.length; i++) {
        const d = refs.dots[i];
        const phase = d.x * 0.3 + d.y * 0.5;
        const dx = Math.sin(t * 0.9 + phase) * 0.8;
        const dy = Math.cos(t * 1.1 + phase * 1.3) * 0.8;
        const c = refs.circles[i];
        if (!c) continue;
        c.setAttribute('cx', String(d.x + dx));
        c.setAttribute('cy', String(d.y + dy));
      }
    },
  },
  boot: {
    label: 'Boot',
    state: 'LOADING',
    desc: 'Outward reveal — rings light up from the core to the rim on a 2.4s loop. Startup state.',
    apply: (t, refs) => {
      const cycle = (t % 2.4) / 2.4;
      const front = cycle * 105;
      for (let i = 0; i < refs.dots.length; i++) {
        const d = refs.dots[i];
        const c = refs.circles[i];
        if (!c) continue;
        if (d.radius < front - 8) {
          c.setAttribute('opacity', String(d.op));
        } else if (d.radius < front) {
          const k = (d.radius - (front - 8)) / 8;
          c.setAttribute('opacity', String(d.op * (1 - k * 0.4)));
        } else {
          c.setAttribute('opacity', String(d.op * 0.06));
        }
      }
    },
  },
  thinking: {
    label: 'Thinking',
    state: 'THINKING',
    desc: 'Combined breathe + angularly-phased flicker. The AI-is-working state for the product.',
    apply: (t, refs) => {
      const scale = 1 + 0.02 * Math.sin(t * 1.0);
      if (refs.g) {
        refs.g.setAttribute(
          'transform',
          `translate(100 100) scale(${scale}) translate(-100 -100)`,
        );
      }
      for (let i = 0; i < refs.dots.length; i++) {
        const d = refs.dots[i];
        const phase = d.angle * 3 + d.radius * 0.18;
        const flicker = 0.65 + 0.35 * Math.sin(t * 2.0 + phase);
        refs.circles[i]?.setAttribute('opacity', String(d.op * flicker));
      }
    },
  },
};

export const MARK_MODE_KEYS = Object.keys(MARK_MODES) as MarkMode[];
