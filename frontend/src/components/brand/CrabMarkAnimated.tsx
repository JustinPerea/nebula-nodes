import { useEffect, useMemo, useRef, useState } from 'react';
import '../../styles/brand.css';
import {
  buildCrabDots,
  CRAB_TRUE,
  CRAB_VIEWBOX,
  type PaletteStop,
} from './crabGeometry';
import { MARK_MODES, type MarkMode, type ModeRefs } from './crabModes';

/**
 * Nebula Nodes brand mark — NN-45 Crab (M1), animated.
 *
 * The locked mark, brought to life. Seven motion modes, each tuned to a
 * specific product state (see `crabModes.ts` + the Dynamic Mark showcase).
 *
 * Architecture (ported from the Claude Design handoff): the dot field is
 * computed once and memoized; a single requestAnimationFrame loop per
 * instance mutates SVG attributes directly, skipping React reconciliation
 * per frame. That's what lets a dozen marks animate together at 60fps —
 * React only renders the static dots once.
 *
 * Accessibility: respects `prefers-reduced-motion`. When the user prefers
 * reduced motion the RAF loop never starts and the mark renders as the
 * resting static silhouette (DESIGN.md §2 Motion mandate).
 */

/** Track the OS reduced-motion preference, live. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduced;
}

type CrabMarkAnimatedProps = {
  mode?: MarkMode;
  size?: number;
  palette?: PaletteStop[];
  /** Freeze on the resting silhouette without tearing down the instance. */
  paused?: boolean;
  tight?: boolean;
  step?: number;
  className?: string;
  title?: string;
};

export function CrabMarkAnimated({
  mode = 'breathe',
  size = 200,
  palette = CRAB_TRUE,
  paused = false,
  tight = true,
  step = 6,
  className,
  title,
}: CrabMarkAnimatedProps) {
  const dots = useMemo(() => buildCrabDots(palette, step), [palette, step]);
  const gRef = useRef<SVGGElement | null>(null);
  const circleRefs = useRef<(SVGCircleElement | null)[]>([]);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (paused || reduced) return;
    const modeObj = MARK_MODES[mode];
    if (!modeObj) return;
    // Capture the DOM nodes once at effect start; they're stable for the
    // life of this effect (the dots array identity gates re-runs).
    const g = gRef.current;
    const circles = circleRefs.current;
    const refs: ModeRefs = { g, dots, circles };
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      modeObj.apply((now - start) / 1000, refs);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // Reset every attribute the modes may have touched so switching mode
      // (or pausing) lands cleanly back on the resting silhouette.
      g?.removeAttribute('transform');
      for (let i = 0; i < dots.length; i++) {
        const d = dots[i];
        const c = circles[i];
        if (!c) continue;
        c.setAttribute('cx', String(d.x));
        c.setAttribute('cy', String(d.y));
        c.setAttribute('r', String(d.r));
        c.setAttribute('opacity', String(d.op));
      }
    };
  }, [mode, dots, paused, reduced]);

  const viewBox = tight ? CRAB_VIEWBOX.tight : CRAB_VIEWBOX.loose;

  return (
    <svg
      viewBox={viewBox}
      width={size}
      height={size}
      className={['nn-crabmark', className].filter(Boolean).join(' ')}
      role={title ? 'img' : 'presentation'}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <g ref={gRef}>
        {dots.map((d, i) => (
          <circle
            key={i}
            ref={(el) => {
              circleRefs.current[i] = el;
            }}
            cx={d.x}
            cy={d.y}
            r={d.r}
            fill={d.fill}
            opacity={d.op}
          />
        ))}
      </g>
    </svg>
  );
}

export type { MarkMode };
