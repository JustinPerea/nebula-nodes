import type { ComponentType } from 'react';
import type { EdgeTypes, NodeProps, NodeTypes } from '@xyflow/react';
import { ModelNode } from './nodes/ModelNode';
import { DynamicNode } from './nodes/DynamicNode';
import { RerouteNode } from './nodes/RerouteNode';
import { EditNode } from './nodes/EditNode';
import { RemotionNode } from './nodes/RemotionNode';
import { CinemaSceneNode } from './nodes/CinemaSceneNode';
import { CharacterNode } from './nodes/CharacterNode';
import { CameraRigNode } from './nodes/CameraRigNode';
import { ReferenceSetNode } from './nodes/ReferenceSetNode';
import { MoodboardNode } from './nodes/MoodboardNode';
import { VideoQcNode } from './nodes/VideoQcNode';
import { PaperSourceNode } from './nodes/PaperSourceNode';
import { BatchNode } from './nodes/BatchNode';
import { TypedEdge } from './edges/TypedEdge';
import { withNodeCardBoundary } from './nodes/withNodeCardBoundary';

/** The card each canvas node type draws, each inside its own boundary
 * (PR #198 review 3, L4: one card whose data is damaged shows a line on
 * its card and never takes the canvas down). One map, so tests render the
 * cards the canvas renders (tests/canvasRenderScope.test.tsx). */
export const CANVAS_CARDS: NodeTypes = {
  'model-node': ModelNode,
  'dynamic-node': DynamicNode,
  'reroute-node': RerouteNode,
  editNode: EditNode,
  remotionNode: RemotionNode,
  cinemaSceneNode: CinemaSceneNode,
  characterNode: CharacterNode,
  cameraRigNode: CameraRigNode,
  referenceSetNode: ReferenceSetNode,
  moodboardNode: MoodboardNode,
  videoQcNode: VideoQcNode,
  paperSourceNode: PaperSourceNode,
  batchNode: BatchNode,
};

export const CANVAS_NODE_TYPES: NodeTypes = Object.fromEntries(
  Object.entries(CANVAS_CARDS).map(([type, card]) => [type, withNodeCardBoundary(card as ComponentType<NodeProps>)]),
) as NodeTypes;

export const CANVAS_EDGE_TYPES: EdgeTypes = {
  'typed-edge': TypedEdge,
};
