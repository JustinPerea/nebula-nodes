import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type Node,
  type Edge,
  type NodeChange,
  type EdgeChange,
  type Connection,
} from '@xyflow/react';
import { v4 as uuidv4 } from 'uuid';
import type { NodeData } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

interface GraphState {
  nodes: Node<NodeData>[];
  edges: Edge[];

  addNode: (definitionId: string, position: { x: number; y: number }) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],

  addNode: (definitionId, position) => {
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return;

    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) {
        defaults[param.key] = param.default;
      }
    }

    const newNode: Node<NodeData> = {
      id: uuidv4(),
      type: 'model-node',
      position,
      data: {
        label: definition.displayName,
        definitionId,
        params: defaults,
        state: 'idle',
        outputs: {},
      },
    };

    set((state) => ({ nodes: [...state.nodes, newNode] }));
  },

  onNodesChange: (changes) => {
    const removedIds = changes
      .filter((c): c is NodeChange & { type: 'remove' } => c.type === 'remove')
      .map((c) => c.id);

    if (removedIds.length > 0) {
      set((state) => ({
        nodes: applyNodeChanges(changes, state.nodes),
        edges: state.edges.filter(
          (e) => !removedIds.includes(e.source) && !removedIds.includes(e.target)
        ),
      }));
    } else {
      set((state) => ({
        nodes: applyNodeChanges(changes, state.nodes),
      }));
    }
  },

  onEdgesChange: (changes) => {
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges),
    }));
  },

  onConnect: (connection) => {
    if (!connection.source || !connection.target) return;

    const sourceNode = get().nodes.find((n) => n.id === connection.source);
    const targetNode = get().nodes.find((n) => n.id === connection.target);
    if (!sourceNode || !targetNode) return;

    const sourceDef = NODE_DEFINITIONS[sourceNode.data.definitionId];
    const targetDef = NODE_DEFINITIONS[targetNode.data.definitionId];
    if (!sourceDef || !targetDef) return;

    const sourcePort = sourceDef.outputPorts.find((p) => p.id === connection.sourceHandle);
    const dataType = sourcePort?.dataType ?? 'Any';

    const newEdge: Edge = {
      id: uuidv4(),
      source: connection.source,
      sourceHandle: connection.sourceHandle,
      target: connection.target,
      targetHandle: connection.targetHandle,
      type: 'typed-edge',
      data: { dataType },
    };

    set((state) => ({ edges: [...state.edges, newEdge] }));
  },

  updateNodeData: (nodeId, data) => {
    set((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === nodeId
          ? { ...node, data: { ...node.data, ...data } }
          : node
      ),
    }));
  },
}));
