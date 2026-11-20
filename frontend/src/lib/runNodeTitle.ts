import type { Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData } from '../types';
import { nodeTitle } from './directRoute';
import type { RunGraphSnapshot } from './runHistory';

/**
 * A node's canvas name for a person reading a saved run, never its id (design): the name
 * it ran under (the run's own snapshot), else the live canvas node, else its definition's
 * default title (nodeTitle, the rule the cards and the agent log use). "Node" when neither
 * the snapshot nor the canvas knows the node, since its definition is then unknown.
 */
export function runNodeTitle(snapshot: RunGraphSnapshot, liveNodes: readonly Node<NodeData>[], nodeId: string): string {
  const saved = snapshot.nodes.find((node) => node.id === nodeId);
  const live = saved ? undefined : liveNodes.find((node) => node.id === nodeId);
  const definitionId = saved?.definitionId ?? live?.data?.definitionId;
  const rawLabel = saved ? saved.label : live?.data?.label;
  const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel : null;
  const definition = definitionId ? NODE_DEFINITIONS[definitionId] : undefined;
  return (definition ? nodeTitle(definition, label) : label) || definition?.displayName || 'Node';
}
