import { createContext, useCallback, useContext, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useStoreApi } from '@xyflow/react';

/**
 * The layout spring (#226, GM r68): the floating Inspector's height, top and
 * left run on it (panels.css `--inspector-layout-spring`, which a test keeps
 * equal to these), and so does a node card's width when its own content
 * widens it (GM r107).
 */
export const LAYOUT_SPRING_MS = 360;
export const LAYOUT_SPRING_EASING = 'linear(0, 0.079, 0.247, 0.434, 0.606, 0.744, 0.847, 0.919, 0.965, 0.992, 1.006, 1.013, 1.014, 1.012, 1.01, 1.007, 1)';

/**
 * Set on a card while its width springs. The Inspector beside it reads it and
 * follows the card's edge frame by frame (NodeInspectorPopover.tsx), so the
 * gap between them holds every frame.
 */
export const CARD_WIDTH_SPRING_ATTR = 'data-width-spring';

/**
 * Set on a card for as long as it springs its width when its content changes
 * it (this hook is on it). A card without it (a Character or Moodboard card)
 * widens in one frame, so the Inspector never holds back from its new edge
 * for a spring that will not come (NodeInspectorPopover.tsx).
 */
export const CARD_WIDTH_SPRINGS_ATTR = 'data-width-springs';

/** The layout spring's curve, read from its easing so there is one source. */
const LAYOUT_POINTS = (LAYOUT_SPRING_EASING.match(/linear\((.*)\)/)?.[1] ?? '0, 1').split(',').map(Number);

/** What a running width spring is: its width (layout px) at a time, and how long it lasts. */
type Motion = { at: (ms: number) => number; duration: number; keyframes: Keyframe[] | null };

/** The first spring of a change: the layout spring, from rest at the old width. */
function layoutMotion(from: number, to: number): Motion {
  const at = (ms: number) => {
    const share = Math.min(1, Math.max(0, ms / LAYOUT_SPRING_MS)) * (LAYOUT_POINTS.length - 1);
    const i = Math.min(LAYOUT_POINTS.length - 2, Math.floor(share));
    const curve = LAYOUT_POINTS[i] + (LAYOUT_POINTS[i + 1] - LAYOUT_POINTS[i]) * (share - i);
    return from + (to - from) * curve;
  };
  return {
    at, duration: LAYOUT_SPRING_MS,
    keyframes: [{ boxSizing: 'border-box', width: `${from}px` }, { boxSizing: 'border-box', width: `${to}px` }],
  };
}

/**
 * The layout spring as a damped oscillator (the curve above: about 1.4 %
 * overshoot, peaking at about three quarters of its 360 ms), so a change that
 * lands while a spring runs can carry on from where the card is, at the speed
 * it has, toward the new width (GM r114: typing a rename retargets on each
 * keystroke, it never restarts from rest).
 */
const SPRING_DAMPING = 0.806;
const SPRING_OMEGA = 19.65;
const KEYFRAME_MS = 1000 / 60;

/** The retargeted spring: from `from` at `velocity` (px/s) toward `to`. */
function retargetMotion(from: number, velocity: number, to: number): Motion {
  const zeta = SPRING_DAMPING;
  const damped = SPRING_OMEGA * Math.sqrt(1 - zeta * zeta);
  const y0 = from - to;
  const b = (velocity + zeta * SPRING_OMEGA * y0) / damped;
  const offset = (seconds: number) => Math.exp(-zeta * SPRING_OMEGA * seconds)
    * (y0 * Math.cos(damped * seconds) + b * Math.sin(damped * seconds));
  // Until it is within a quarter pixel and nearly still.
  let duration = KEYFRAME_MS * 4;
  while (duration < 1500 && Math.abs(offset(duration / 1000)) + Math.abs(offset(duration / 1000 + 0.01) - offset(duration / 1000)) * 10 > 0.25) {
    duration += KEYFRAME_MS;
  }
  const at = (ms: number) => (ms >= duration ? to : to + offset(Math.max(0, ms) / 1000));
  const steps = Math.ceil(duration / KEYFRAME_MS);
  const keyframes: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    keyframes.push({ boxSizing: 'border-box', width: `${at((i / steps) * duration)}px`, offset: i / steps });
  }
  return { at, duration, keyframes };
}

/**
 * GM r107, r114: a card whose width changes from its own content (an Image
 * Input's preview landing, a rename) springs to its new width on the layout
 * spring, never in one frame. Its preview is `width: 100%; height: auto`, so
 * it scales with the card and keeps its ratio; the ports sit on the card's
 * edges and ride them, and React Flow measures the node each frame it
 * changes size, so the wires follow. `onStart` runs as the spring starts, in
 * the same callback (useNodeRemeasure: React Flow measures the node again
 * there, at its old width, so its wire never shows the new width for that
 * frame).
 *
 * Every content width change springs, whatever caused it. A change that
 * lands while the spring runs (typing a rename) retargets it: the card's
 * natural width is read each frame the spring runs (with the animation
 * lifted for the read, in the same task, so nothing paints), and a new
 * target carries on from the card's width and speed at that frame (the
 * retarget starts at that frame, never a frame later), so the speed is
 * continuous and nothing restarts from rest.
 *
 * The width is the card's own layout width (ResizeObserver's border box), so
 * a move, pan or zoom never reads as a change: they stay rigid. Under reduced
 * motion the card jumps.
 */
export function useCardWidthSpring(ref: RefObject<HTMLElement | null>, onStart?: (card: HTMLElement) => void) {
  const onStartRef = useRef(onStart);
  useEffect(() => {
    onStartRef.current = onStart;
  }, [onStart]);
  useEffect(() => {
    const card = ref.current;
    if (!card || typeof ResizeObserver === 'undefined' || typeof card.animate !== 'function') return;
    // The width it rests at (the last one seen, or where a spring is going).
    let rest: number | null = null;
    let running: { animation: Animation; motion: Motion } | null = null;

    const play = (motion: Motion, options: KeyframeAnimationOptions) => {
      const previous = running;
      const animation = card.animate(motion.keyframes!, options);
      running = { animation, motion };
      // Its first frame is this one (not a held frame before it starts):
      // a retarget carries on from the width the card is painted at now.
      if (previous && document.timeline && 'startTime' in animation) animation.startTime = document.timeline.currentTime;
      card.setAttribute(CARD_WIDTH_SPRING_ATTR, '');
      const end = () => {
        if (running?.animation !== animation) return;
        running = null;
        card.removeAttribute(CARD_WIDTH_SPRING_ATTR);
      };
      animation.addEventListener('finish', end);
      animation.addEventListener('cancel', end);
      previous?.animation.cancel();
    };

    /**
     * The card's content changed mid-spring: its natural width, read with
     * the animation lifted (the ratio of the two boxes on screen gives it in
     * layout px at any zoom), and the spring retargeted to it.
     */
    const retarget = () => {
      const current = running;
      const effect = current?.animation.effect as KeyframeEffect | null | undefined;
      if (!current || !effect || typeof effect.setKeyframes !== 'function') return;
      const elapsed = Number(current.animation.currentTime ?? 0);
      const here = current.motion.at(elapsed);
      const frames = effect.getKeyframes();
      const animated = card.getBoundingClientRect().width;
      effect.setKeyframes([]);
      const natural = card.getBoundingClientRect().width;
      effect.setKeyframes(frames);
      if (!(animated > 0) || !(natural > 0) || !(here > 0)) return;
      const width = here * (natural / animated);
      if (!Number.isFinite(width) || Math.abs(width - (rest ?? width)) < 0.5) return;
      const at = Math.min(Math.max(elapsed, 1), current.motion.duration - 1);
      const velocity = (current.motion.at(at + 1) - current.motion.at(at - 1)) / 2 * 1000;
      rest = width;
      const motion = retargetMotion(here, velocity, width);
      play(motion, { duration: motion.duration, easing: 'linear' });
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      // Its own frames while it springs; a content change in the middle of it
      // retargets it.
      if (running) {
        retarget();
        return;
      }
      const width = entry.borderBoxSize?.[0]?.inlineSize ?? card.offsetWidth;
      const from = rest;
      // Always the width it is at (under reduced motion too), so turning
      // motion back on springs from where it was, not from a stale width.
      rest = width;
      if (from === null || Math.abs(width - from) < 0.5) return;
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      // In the observer's callback (after layout, before paint), so the card
      // is never painted at its new width before the spring takes it.
      play(layoutMotion(from, width), { duration: LAYOUT_SPRING_MS, easing: LAYOUT_SPRING_EASING });
      onStartRef.current?.(card);
    });
    observer.observe(card);
    card.setAttribute(CARD_WIDTH_SPRINGS_ATTR, '');
    return () => {
      observer.disconnect();
      card.removeAttribute(CARD_WIDTH_SPRINGS_ATTR);
      const animation = running?.animation;
      running = null;
      animation?.cancel();
      card.removeAttribute(CARD_WIDTH_SPRING_ATTR);
    };
  }, [ref]);
}

/**
 * React Flow measures a node (and its ports, which its wires end at) from its
 * own ResizeObserver, which reports before the card's: it has already seen
 * the card at its new width when the card's spring starts, and it would not
 * hear of the spring's first frame until the next one (an observer reports a
 * shallower element only once a frame). So the wire would end at the new
 * width for a frame while the port is at the old one (GM r107, seen live:
 * 47 px). This measures the node again, at once, at the width the spring
 * starts from.
 */
export function useNodeRemeasure(nodeId: string) {
  // From the canvas (Canvas.tsx gives it, inside React Flow's provider). A
  // card drawn outside a canvas (a test that renders a node on its own) has
  // none, and measures nothing.
  const remeasure = useContext(NodeRemeasureContext);
  return useCallback((card: HTMLElement) => {
    const nodeElement = card.closest<HTMLDivElement>('.react-flow__node');
    if (!nodeElement || !remeasure) return;
    remeasure(nodeId, nodeElement);
  }, [nodeId, remeasure]);
}

/** Measures one node again, at once (React Flow's updateNodeInternals, forced). */
export type NodeRemeasure = (nodeId: string, nodeElement: HTMLDivElement) => void;

/** The canvas's NodeRemeasure, for the nodes on it (useNodeRemeasure). */
export const NodeRemeasureContext = createContext<NodeRemeasure | null>(null);

/** The canvas's NodeRemeasure. Call it inside React Flow's provider. */
export function useFlowNodeRemeasure(): NodeRemeasure {
  const store = useStoreApi();
  return useCallback((nodeId: string, nodeElement: HTMLDivElement) => {
    store.getState().updateNodeInternals(new Map([[nodeId, { id: nodeId, nodeElement, force: true }]]));
  }, [store]);
}
