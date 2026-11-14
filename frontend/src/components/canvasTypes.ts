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

/** The card each canvas node type draws (the less common kinds are separate
 * chunks, lib/deferredChunks.ts; the canvas does not hand React Flow a node
 * until its card's chunk has settled, lib/cardHold.ts, so a card never draws
 * empty), each inside its own boundary
 * (PR #198 review 3, L4: one card whose data is damaged shows a line on
 * its card and never takes the canvas down). One map, so tests render the
 * cards the canvas renders (tests/canvasRenderScope.test.tsx). */
export const CANVAS_CARDS: NodeTypes = {
  'model-node': ModelNode,
  'dynamic-node': deferredAtOnce(DeferredDynamicNode, 'DynamicNode'),
  'reroute-node': RerouteNode,
  editNode: deferredAtOnce(DeferredEditNode, 'EditNode'),
  remotionNode: deferredAtOnce(DeferredRemotionNode, 'RemotionNode'),
  cinemaSceneNode: deferredAtOnce(DeferredCinemaSceneNode, 'CinemaSceneNode'),
  characterNode: deferredAtOnce(DeferredCharacterNode, 'CharacterNode'),
  cameraRigNode: deferredAtOnce(DeferredCameraRigNode, 'CameraRigNode'),
  referenceSetNode: deferredAtOnce(DeferredReferenceSetNode, 'ReferenceSetNode'),
  moodboardNode: deferredAtOnce(DeferredMoodboardNode, 'MoodboardNode'),
  videoQcNode: VideoQcNode,
  paperSourceNode: deferredAtOnce(DeferredPaperSourceNode, 'PaperSourceNode'),
  batchNode: deferredAtOnce(DeferredBatchNode, 'BatchNode'),
};

export const CANVAS_NODE_TYPES: NodeTypes = Object.fromEntries(
  Object.entries(CANVAS_CARDS).map(([type, card]) => [type, withNodeCardBoundary(card as ComponentType<NodeProps>)]),
) as NodeTypes;

export const CANVAS_EDGE_TYPES: EdgeTypes = {
  'typed-edge': TypedEdge,
};
