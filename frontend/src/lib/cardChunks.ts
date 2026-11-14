import type { Node } from '@xyflow/react';
import type { NodeData } from '../types';
import type { ChunkSettling } from './lazyWithPreload';
import {
  DeferredBatchNode,
  DeferredCameraRigNode,
  DeferredCharacterNode,
  DeferredCinemaSceneNode,
  DeferredDynamicNode,
  DeferredEditNode,
  DeferredJevResultView,
  DeferredMoodboardNode,
  DeferredPaperSourceNode,
  DeferredReferenceSetNode,
  DeferredRemotionNode,
  DeferredRepresentationViewer,
  DeferredStructuredOutputs,
} from './deferredChunks';
import { resultViewNeeds } from './resultViews';

/**
 * What a node needs loaded before its card can draw: the card's own chunk, by
 * node type, and the chunk of each result view the card would mount for the
 * node's data (lib/resultViews.ts holds the predicates the cards use). The
 * canvas keeps a node back until all of these have settled (lib/cardHold.ts),
 * so a card never draws empty beside its neighbours and pops in later.
 * Startup code: it imports the lazy handles, never the cards.
 */

// Chunk objects hold their own props type; the hold only reads settling and asks to load.
export type CardChunk = ChunkSettling & { readonly preload: () => Promise<unknown> };
type Chunk = CardChunk;

/** The deferred card of each node type (components/canvasTypes.ts CANVAS_CARDS). */
export const CARD_CHUNK_BY_TYPE: Readonly<Record<string, Chunk>> = {
  'dynamic-node': DeferredDynamicNode,
  editNode: DeferredEditNode,
  remotionNode: DeferredRemotionNode,
  cinemaSceneNode: DeferredCinemaSceneNode,
  characterNode: DeferredCharacterNode,
  cameraRigNode: DeferredCameraRigNode,
  referenceSetNode: DeferredReferenceSetNode,
  moodboardNode: DeferredMoodboardNode,
  paperSourceNode: DeferredPaperSourceNode,
  batchNode: DeferredBatchNode,
};

/** The node types whose cards mount result views (ModelNode, DynamicNode). */
const RESULT_VIEW_TYPES: ReadonlySet<string> = new Set(['model-node', 'dynamic-node']);

/** Every chunk a card can need, to answer "is everything in" without looking at a node. */
export const ALL_CARD_CHUNKS: readonly Chunk[] = [
  ...Object.values(CARD_CHUNK_BY_TYPE),
  DeferredJevResultView,
  DeferredRepresentationViewer,
  DeferredStructuredOutputs,
];

export function allCardChunksSettled(): boolean {
  return ALL_CARD_CHUNKS.every((chunk) => chunk.isSettled());
}

/** The chunks this node's card will render. */
export function cardChunksOf(node: Pick<Node, 'type' | 'data'>): Chunk[] {
  const chunks: Chunk[] = [];
  const own = node.type ? CARD_CHUNK_BY_TYPE[node.type] : undefined;
  if (own) chunks.push(own);
  if (node.type && RESULT_VIEW_TYPES.has(node.type)) {
    const needs = resultViewNeeds(node.data as NodeData | undefined);
    // Only ModelNode mounts the Jev view.
    if (needs.jev && node.type === 'model-node') chunks.push(DeferredJevResultView);
    if (needs.viewer) chunks.push(DeferredRepresentationViewer);
    if (needs.structured) chunks.push(DeferredStructuredOutputs);
  }
  return chunks;
}
