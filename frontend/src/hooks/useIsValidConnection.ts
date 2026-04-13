import { useCallback } from 'react';
import { useReactFlow, getOutgoers, type Node, type Edge, type Connection } from '@xyflow/react';
import { isPortCompatible } from '../lib/portCompatibility';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { NodeData, DynamicNodeData, PortDataType } from '../types';

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

      const sourceData = sourceNode.data as NodeData;
      const targetData = targetNode.data as NodeData;

      let sourcePortType: PortDataType | undefined;
      let targetPortType: PortDataType | undefined;

      // Check static definitions first
      const sourceDef = NODE_DEFINITIONS[sourceData.definitionId];
      const targetDef = NODE_DEFINITIONS[targetData.definitionId];

      if (sourceDef) {
        const p = sourceDef.outputPorts.find((p) => p.id === connection.sourceHandle);
        if (p) sourcePortType = p.dataType;
      }
      if (targetDef) {
        const p = targetDef.inputPorts.find((p) => p.id === connection.targetHandle);
        if (p) targetPortType = p.dataType;
      }

      // Fallback to dynamic ports
      if (!sourcePortType && 'isDynamic' in sourceData) {
        const dyn = sourceData as DynamicNodeData;
        const p = dyn.dynamicOutputPorts?.find((p) => p.id === connection.sourceHandle);
        if (p) sourcePortType = p.dataType;
      }
      if (!targetPortType && 'isDynamic' in targetData) {
        const dyn = targetData as DynamicNodeData;
        const p = dyn.dynamicInputPorts?.find((p) => p.id === connection.targetHandle);
        if (p) targetPortType = p.dataType;
      }

      if (!sourcePortType || !targetPortType) return false;
      return isPortCompatible(sourcePortType, targetPortType);
    },
    [getNodes, getEdges]
  );
}
