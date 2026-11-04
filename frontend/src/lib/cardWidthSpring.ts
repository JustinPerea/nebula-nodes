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
 * GM r107: a card whose width changes from its own content (an Image Input's
 * preview landing) springs to its new width on the layout spring, never in
 * one frame. Its preview is `width: 100%; height: auto`, so it scales with
 * the card and keeps its ratio; the ports sit on the card's edges and ride
 * them, and React Flow measures the node each frame it changes size, so the
 * wires follow. `onStart` runs as the spring starts, in the same callback
 * (useNodeRemeasure: React Flow measures the node again there, at its old
 * width, so its wire never shows the new width for that frame).
 *
 * The width is the card's own layout width (ResizeObserver's border box), so
 * a move, pan or zoom never reads as a change: they stay rigid. Under reduced
 * motion the card jumps, as the panel does.
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
    let running: Animation | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      // Its own frames while it springs. Its content settling mid-spring
      // shows once it rests (the observer reports the new width then).
      if (running) return;
      const width = entry.borderBoxSize?.[0]?.inlineSize ?? card.offsetWidth;
      const from = rest;
      rest = width;
      if (from === null || Math.abs(width - from) < 0.5) return;
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      // In the observer's callback (after layout, before paint), so the card
      // is never painted at its new width before the spring takes it.
      const animation = card.animate(
        [{ boxSizing: 'border-box', width: `${from}px` }, { boxSizing: 'border-box', width: `${width}px` }],
        { duration: LAYOUT_SPRING_MS, easing: LAYOUT_SPRING_EASING },
      );
      running = animation;
      card.setAttribute(CARD_WIDTH_SPRING_ATTR, '');
      onStartRef.current?.(card);
      const end = () => {
        if (running !== animation) return;
        running = null;
        card.removeAttribute(CARD_WIDTH_SPRING_ATTR);
      };
      animation.addEventListener('finish', end);
      animation.addEventListener('cancel', end);
    });
    observer.observe(card);
    return () => {
      observer.disconnect();
      const animation = running;
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
