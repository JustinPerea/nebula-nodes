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
import { executeGraph as apiExecuteGraph } from '../lib/api';
import { wsClient, type ExecutionEvent } from '../lib/wsClient';

interface GraphState {
  nodes: Node<NodeData>[];
  edges: Edge[];
  isExecuting: boolean;
  addNode: (definitionId: string, position: { x: number; y: number }) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;
  executeGraph: () => Promise<void>;
  resetExecution: () => void;
  handleExecutionEvent: (event: ExecutionEvent) => void;
}

wsClient.connect();
wsClient.subscribe((event) => {
  useGraphStore.getState().handleExecutionEvent(event);
});

export const useGraphStore = create<GraphState>((set, get) => ({
  nodes: [],
  edges: [],
  isExecuting: false,

  addNode: (definitionId, position) => {
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return;
    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }
    const newNode: Node<NodeData> = {
      id: uuidv4(),
      type: 'model-node',
      position,
      data: { label: definition.displayName, definitionId, params: defaults, state: 'idle', outputs: {} },
    };
    set((state) => ({ nodes: [...state.nodes, newNode] }));
  },

  onNodesChange: (changes) => {
    const removedIds = changes.filter((c): c is NodeChange & { type: 'remove' } => c.type === 'remove').map((c) => c.id);
    if (removedIds.length > 0) {
      set((state) => ({
        nodes: applyNodeChanges(changes, state.nodes),
        edges: state.edges.filter((e) => !removedIds.includes(e.source) && !removedIds.includes(e.target)),
      }));
    } else {
      set((state) => ({ nodes: applyNodeChanges(changes, state.nodes) }));
    }
  },

  onEdgesChange: (changes) => {
    set((state) => ({ edges: applyEdgeChanges(changes, state.edges) }));
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
        node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node
      ),
    }));
  },

  resetExecution: () => {
    set((state) => ({
      isExecuting: false,
      nodes: state.nodes.map((node) => ({
        ...node,
        data: { ...node.data, state: 'idle' as const, error: undefined, progress: undefined },
      })),
    }));
  },

  executeGraph: async () => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting) return;
    resetExecution();
    set({ isExecuting: true });
    const graphNodes = nodes.map((n) => ({ id: n.id, definitionId: n.data.definitionId, params: n.data.params, outputs: {} }));
    const graphEdges = edges.map((e) => ({ id: e.id, source: e.source, sourceHandle: e.sourceHandle, target: e.target, targetHandle: e.targetHandle }));
    try {
      const result = await apiExecuteGraph(graphNodes, graphEdges);
      if (result.status === 'validation_error') set({ isExecuting: false });
    } catch (err) {
      console.error('Failed to start execution:', err);
      set({ isExecuting: false });
    }
  },

  handleExecutionEvent: (event) => {
    switch (event.type) {
      case 'queued':
        get().updateNodeData(event.nodeId, { state: 'queued' });
        break;
      case 'executing':
        get().updateNodeData(event.nodeId, { state: 'executing', progress: 0, streamingText: undefined });
        break;
      case 'progress':
        get().updateNodeData(event.nodeId, { progress: event.value });
        break;
      case 'executed': {
        const outputs: Record<string, { type: string; value: string | null }> = {};
        for (const [key, val] of Object.entries(event.outputs)) {
          const outputVal = val as { type: string; value: string | null };
          if (outputVal.type === 'Image' && outputVal.value && typeof outputVal.value === 'string') {
            const outputIdx = outputVal.value.indexOf('/output/');
            if (outputIdx !== -1) {
              const relativePath = outputVal.value.substring(outputIdx + '/output/'.length);
              outputs[key] = { type: outputVal.type, value: `/api/outputs/${relativePath}` };
            } else {
              outputs[key] = outputVal;
            }
          } else {
            outputs[key] = outputVal;
          }
        }
        get().updateNodeData(event.nodeId, { state: 'complete', outputs, progress: undefined, streamingText: undefined });
        break;
      }
      case 'streamDelta':
        get().updateNodeData(event.nodeId, { streamingText: event.accumulated });
        break;
      case 'error':
        get().updateNodeData(event.nodeId, { state: 'error', error: event.error, progress: undefined });
        break;
      case 'validationError':
        for (const err of event.errors) {
          if (err.nodeId) get().updateNodeData(err.nodeId, { state: 'error', error: err.message });
        }
        set({ isExecuting: false });
        break;
      case 'graphComplete':
        console.log(`[execution] complete in ${event.duration}s, ${event.nodesExecuted} nodes executed`);
        set({ isExecuting: false });
        break;
    }
  },
}));
