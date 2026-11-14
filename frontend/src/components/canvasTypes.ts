import type { ComponentType } from 'react';
import type { EdgeTypes, NodeProps, NodeTypes } from '@xyflow/react';
import { ModelNode } from './nodes/ModelNode';
import { RerouteNode } from './nodes/RerouteNode';
import { VideoQcNode } from './nodes/VideoQcNode';
import { deferredAtOnce } from './deferredAtOnce';
import {
  DeferredDynamicNode,
  DeferredEditNode,
  DeferredRemotionNode,
  DeferredCinemaSceneNode,
  DeferredCharacterNode,
  DeferredCameraRigNode,
  DeferredReferenceSetNode,
  DeferredMoodboardNode,
  DeferredPaperSourceNode,
  DeferredBatchNode,
} from '../lib/deferredChunks';
import { TypedEdge } from './edges/TypedEdge';
import { withNodeCardBoundary } from './nodes/withNodeCardBoundary';
import { CardFallback } from './nodes/CardFallback';
import { withCardSwap } from './nodes/withCardSwap';
import { CARD_FALLBACK_TYPE } from '../lib/cardFallback';

/** A deferred card that crossfades in over its fallback frame, keeping its chunk for the tests. */
function swapIn<P extends NodeProps>(card: ReturnType<typeof deferredAtOnce<P>>) {
  return Object.assign(withCardSwap(card), { chunk: card.chunk });
}

/** The card each canvas node type draws (the less common kinds are separate
 * chunks, lib/deferredChunks.ts; the canvas does not hand React Flow a node
 * until its card's chunk has settled, lib/cardHold.ts: a whole graph waits,
 * a node added later is a fallback card, lib/cardFallback.ts, until its card
 * arrives, so a card never draws empty), each inside its own boundary
 * (PR #198 review 3, L4: one card whose data is damaged shows a line on
 * its card and never takes the canvas down). One map, so tests render the
 * cards the canvas renders (tests/canvasRenderScope.test.tsx). */
export const CANVAS_CARDS: NodeTypes = {
  'model-node': withCardSwap(ModelNode as ComponentType<NodeProps>),
  'dynamic-node': swapIn(deferredAtOnce(DeferredDynamicNode, 'DynamicNode')),
  'reroute-node': RerouteNode,
  editNode: swapIn(deferredAtOnce(DeferredEditNode, 'EditNode')),
  remotionNode: swapIn(deferredAtOnce(DeferredRemotionNode, 'RemotionNode')),
  cinemaSceneNode: swapIn(deferredAtOnce(DeferredCinemaSceneNode, 'CinemaSceneNode')),
  characterNode: swapIn(deferredAtOnce(DeferredCharacterNode, 'CharacterNode')),
  cameraRigNode: swapIn(deferredAtOnce(DeferredCameraRigNode, 'CameraRigNode')),
  referenceSetNode: swapIn(deferredAtOnce(DeferredReferenceSetNode, 'ReferenceSetNode')),
  moodboardNode: swapIn(deferredAtOnce(DeferredMoodboardNode, 'MoodboardNode')),
  videoQcNode: VideoQcNode,
  paperSourceNode: swapIn(deferredAtOnce(DeferredPaperSourceNode, 'PaperSourceNode')),
  batchNode: swapIn(deferredAtOnce(DeferredBatchNode, 'BatchNode')),
};

/** CANVAS_CARDS and the fallback card (lib/cardFallback.ts), which stands in for a card and is not one, each in its boundary. */
export const CANVAS_NODE_TYPES: NodeTypes = Object.fromEntries(
  Object.entries({ ...CANVAS_CARDS, [CARD_FALLBACK_TYPE]: CardFallback }).map(([type, card]) => [type, withNodeCardBoundary(card as ComponentType<NodeProps>)]),
) as NodeTypes;

export const CANVAS_EDGE_TYPES: EdgeTypes = {
  'typed-edge': TypedEdge,
};
