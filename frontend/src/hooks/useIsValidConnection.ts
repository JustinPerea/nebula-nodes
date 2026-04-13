import { useCallback } from 'react';
import { useReactFlow, getOutgoers, type Node, type Edge, type Connection } from '@xyflow/react';
import { isPortCompatible } from '../lib/portCompatibility';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData, PortDataType } from '../types';

export function wouldCreateCycle(
  sourceId: string,
  targetId: string,
  nodes: Node[],
  edges: Edge[]
): boolean {
  if (sourceId === targetId) return true;

  const target = nodes.find((n) => n.id === targetId);
  if (!target) return false;

  const visited = new Set<string>();

  function hasCycle(node: Node): boolean {
    if (visited.has(node.id)) return false;
    visited.add(node.id);

    for (const outgoer of getOutgoers(node, nodes, edges)) {
      if (outgoer.id === sourceId) return true;
      if (hasCycle(outgoer)) return true;
    }
    return false;
  }

  return hasCycle(target);
}

export function useIsValidConnection() {
  const { getNodes, getEdges } = useReactFlow();

  return useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return false;

      const nodes = getNodes();
      const edges = getEdges();

      if (wouldCreateCycle(connection.source, connection.target, nodes, edges)) {
        return false;
      }

      const sourceNode = nodes.find((n) => n.id === connection.source) as Node<NodeData> | undefined;
      const targetNode = nodes.find((n) => n.id === connection.target) as Node<NodeData> | undefined;
      if (!sourceNode || !targetNode) return false;

      const sourceDef = NODE_DEFINITIONS[sourceNode.data.definitionId];
      const targetDef = NODE_DEFINITIONS[targetNode.data.definitionId];
      if (!sourceDef || !targetDef) return false;

      const sourcePort = sourceDef.outputPorts.find((p) => p.id === connection.sourceHandle);
      const targetPort = targetDef.inputPorts.find((p) => p.id === connection.targetHandle);
      if (!sourcePort || !targetPort) return false;

      return isPortCompatible(sourcePort.dataType, targetPort.dataType);
    },
    [getNodes, getEdges]
  );
}
