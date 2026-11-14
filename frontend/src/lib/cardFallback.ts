import type { Node } from '@xyflow/react';

/**
 * The fallback card: what the canvas hands React Flow for a node whose card
 * chunk is not in yet (a node added to a canvas already on screen) or has
 * failed to load. It is the node's frame at the node's position, with its
 * name and its ports, so the node and its wires are there at once and the
 * real card replaces it when its chunk arrives (components/nodes/CardFallback.tsx
 * draws it, lib/cardHold.ts decides which nodes get it). Only what React Flow
 * draws changes; the graph store keeps the real node.
 */

/** The node type of a fallback card (components/canvasTypes.ts). */
export const CARD_FALLBACK_TYPE = 'cardFallback';

export interface FallbackSize { readonly width: number; readonly height: number }

/**
 * Each card type's usual size, for a node whose size is not known yet (no
 * size saved with the node, none measured). The widths are the card's own CSS
 * width (tests/cardFallback.test.tsx reads them from the stylesheets); the
 * heights are the card's height with its common content, and a card whose
 * content differs lands on its own height when it replaces the frame.
 */
export const FALLBACK_SIZE_BY_TYPE: Readonly<Record<string, FallbackSize>> = {
  'model-node': { width: 200, height: 120 },
  'dynamic-node': { width: 200, height: 120 },
  editNode: { width: 160, height: 72 },
  remotionNode: { width: 220, height: 96 },
  cinemaSceneNode: { width: 200, height: 120 },
  characterNode: { width: 200, height: 140 },
  cameraRigNode: { width: 232, height: 140 },
  referenceSetNode: { width: 248, height: 150 },
  moodboardNode: { width: 230, height: 210 },
  paperSourceNode: { width: 286, height: 160 },
  batchNode: { width: 240, height: 120 },
};

const GENERIC_SIZE: FallbackSize = { width: 200, height: 120 };

/** What the fallback card knows of the node it stands in for. */
export interface HeldCard {
  /** The node's real type: which chunk it waits for, and its usual size. */
  readonly type: string | undefined;
  /** The node's own size, when it has one saved or measured. */
  readonly size: FallbackSize | null;
}

/** The node's data with what it stands in for; React Flow gets this copy, the store never does. */
export const HELD_CARD = '__heldCard';

type HeldData = Record<string, unknown> & { [HELD_CARD]?: HeldCard };

export function heldCardOf(data: unknown): HeldCard | null {
  const held = data && typeof data === 'object' ? (data as HeldData)[HELD_CARD] : undefined;
  return held ?? null;
}

/** The size the frame is drawn at: the node's own, else its type's usual. */
export function fallbackSize(held: HeldCard | null): FallbackSize {
  return held?.size ?? FALLBACK_SIZE_BY_TYPE[held?.type ?? ''] ?? GENERIC_SIZE;
}

const copies = new WeakMap<Node, Node>();

/** The fallback card for `node`: same id, position, selection and edges; the copy is kept, so React Flow sees the same object until the node changes. */
export function fallbackNode(node: Node): Node {
  const hit = copies.get(node);
  if (hit) return hit;
  const width = node.width ?? node.measured?.width;
  const height = node.height ?? node.measured?.height;
  const held: HeldCard = {
    type: node.type,
    size: width && height ? { width, height } : null,
  };
  const copy: Node = { ...node, type: CARD_FALLBACK_TYPE, data: { ...(node.data as object), [HELD_CARD]: held } };
  copies.set(node, copy);
  return copy;
}

/**
 * Nodes whose real card has just replaced a fallback frame: the card
 * crossfades in over the frame (components/nodes/withCardSwap.tsx takes its
 * id on mount). A mark is when it was made (the clock is performance.now());
 * one older than SWAP_WINDOW_MS is not honoured, because the card that mounts
 * later (an off-screen node scrolled into view, an id that returns after an
 * undo) was never seen as a frame.
 */
const CARD_SWAPS = new Map<string, number>();

/** How long after the hold marked a swap the card may still crossfade over its frame. */
export const SWAP_WINDOW_MS = 1000;

/** Marks `id` as just swapped; marks that have gone stale are dropped. */
export function markSwap(id: string, now: number = performance.now()): void {
  for (const [other, at] of CARD_SWAPS) if (now - at > SWAP_WINDOW_MS) CARD_SWAPS.delete(other);
  CARD_SWAPS.set(id, now);
}

/** Whether `id`'s card should crossfade now; reads and deletes the mark. */
export function takeSwap(id: string, now: number = performance.now()): boolean {
  const at = CARD_SWAPS.get(id);
  if (at === undefined) return false;
  CARD_SWAPS.delete(id);
  return now - at <= SWAP_WINDOW_MS;
}
