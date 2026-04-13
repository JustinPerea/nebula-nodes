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
import type { NodeData, DynamicNodeData, DynamicPortDefinition, DynamicParamDefinition, PortDataType } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import {
  executeGraph as apiExecuteGraph,
  executeNode as apiExecuteNode,
  fetchOpenRouterModels,
  fetchReplicateSchema,
  type OpenRouterModel,
} from '../lib/api';
import { wsClient, type ExecutionEvent } from '../lib/wsClient';

interface GraphState {
  nodes: Node<NodeData>[];
  edges: Edge[];
  isExecuting: boolean;
  addNode: (definitionId: string, position: { x: number; y: number }) => void;
  addDynamicNode: (definitionId: string, position: { x: number; y: number }) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  updateNodeData: (nodeId: string, data: Partial<NodeData>) => void;
  executeGraph: () => Promise<void>;
  resetExecution: () => void;
  handleExecutionEvent: (event: ExecutionEvent) => void;
  executeNode: (nodeId: string) => Promise<void>;
  duplicateNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  loadGraph: (nodes: Node<NodeData>[], edges: Edge[]) => void;
  clearGraph: () => void;
  configureOpenRouterModel: (nodeId: string, modelId: string, model: OpenRouterModel) => void;
  fetchReplicateSchemaAndConfigure: (nodeId: string, owner: string, name: string) => Promise<void>;
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
    const DYNAMIC_IDS = ['openrouter-universal', 'replicate-universal', 'fal-universal'];
    if (DYNAMIC_IDS.includes(definitionId)) {
      get().addDynamicNode(definitionId, position);
      return;
    }
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

  addDynamicNode: (definitionId, position) => {
    const definition = NODE_DEFINITIONS[definitionId];
    if (!definition) return;
    const defaults: Record<string, unknown> = {};
    for (const param of definition.params) {
      if (param.default !== undefined) defaults[param.key] = param.default;
    }

    const providerMap: Record<string, 'openrouter' | 'replicate' | 'fal'> = {
      'openrouter-universal': 'openrouter',
      'replicate-universal': 'replicate',
      'fal-universal': 'fal',
    };

    const newNode: Node<DynamicNodeData> = {
      id: uuidv4(),
      type: 'dynamic-node',
      position,
      data: {
        label: definition.displayName,
        definitionId,
        params: defaults,
        state: 'idle',
        outputs: {},
        isDynamic: true,
        providerType: providerMap[definitionId] ?? 'openrouter',
        dynamicInputPorts: definition.inputPorts.map((p) => ({
          id: p.id,
          label: p.label,
          dataType: p.dataType,
          required: p.required,
        })),
        dynamicOutputPorts: definition.outputPorts.map((p) => ({
          id: p.id,
          label: p.label,
          dataType: p.dataType,
          required: p.required,
        })),
        dynamicParams: [],
        providerMeta: {},
      },
    };
    set((state) => ({ nodes: [...state.nodes, newNode as unknown as Node<NodeData>] }));
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

    // Resolve source port data type — static or dynamic
    let dataType: PortDataType = 'Any';
    const sourceDynamic = sourceNode.data as unknown as DynamicNodeData | undefined;
    if (sourceDynamic?.isDynamic && sourceDynamic.dynamicOutputPorts) {
      const dynPort = sourceDynamic.dynamicOutputPorts.find((p) => p.id === connection.sourceHandle);
      if (dynPort) dataType = dynPort.dataType;
    } else {
      const sourceDef = NODE_DEFINITIONS[sourceNode.data.definitionId];
      if (sourceDef) {
        const sourcePort = sourceDef.outputPorts.find((p) => p.id === connection.sourceHandle);
        if (sourcePort) dataType = sourcePort.dataType;
      }
    }

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

  executeNode: async (nodeId) => {
    const { nodes, edges, isExecuting, resetExecution } = get();
    if (isExecuting) return;
    resetExecution();
    set({ isExecuting: true });
    const graphNodes = nodes.map((n) => ({
      id: n.id,
      definitionId: n.data.definitionId,
      params: n.data.params,
      outputs: {},
    }));
    const graphEdges = edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
    }));
    try {
      const result = await apiExecuteNode(graphNodes, graphEdges, nodeId);
      if (result.status === 'validation_error') set({ isExecuting: false });
    } catch (err) {
      console.error('Failed to start node execution:', err);
      set({ isExecuting: false });
    }
  },

  duplicateNode: (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const newNode: Node<NodeData> = {
      id: uuidv4(),
      type: node.type,
      position: { x: node.position.x + 20, y: node.position.y + 20 },
      data: {
        ...node.data,
        state: 'idle' as const,
        outputs: {},
        error: undefined,
        progress: undefined,
        streamingText: undefined,
      },
    };
    set((state) => ({ nodes: [...state.nodes, newNode] }));
  },

  deleteNode: (nodeId) => {
    set((state) => ({
      nodes: state.nodes.filter((n) => n.id !== nodeId),
      edges: state.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
    }));
  },

  loadGraph: (nodes, edges) => {
    set({ nodes, edges, isExecuting: false });
  },

  clearGraph: () => {
    set({ nodes: [], edges: [], isExecuting: false });
  },

  configureOpenRouterModel: (nodeId, modelId, model) => {
    const inputModalities = model.input_modalities || ['text'];
    const outputModalities = model.output_modalities || ['text'];

    const inputPorts: DynamicPortDefinition[] = [
      { id: 'messages', label: 'Messages', dataType: 'Text', required: true },
    ];
    if (inputModalities.includes('image')) {
      inputPorts.push({ id: 'images', label: 'Images', dataType: 'Image', required: false });
    }

    const outputPorts: DynamicPortDefinition[] = [];
    if (outputModalities.includes('text')) {
      outputPorts.push({ id: 'text', label: 'Text', dataType: 'Text', required: false });
    }
    if (outputModalities.includes('image')) {
      outputPorts.push({ id: 'image', label: 'Image', dataType: 'Image', required: false });
    }

    const wantsImage = outputModalities.includes('image');

    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        const data = n.data as unknown as DynamicNodeData;
        return {
          ...n,
          data: {
            ...data,
            modelId,
            params: { ...data.params, model: modelId, _output_image: wantsImage },
            dynamicInputPorts: inputPorts,
            dynamicOutputPorts: outputPorts,
          } as unknown as NodeData,
        };
      }),
      // Remove edges connected to ports that no longer exist
      edges: state.edges.filter((e) => {
        if (e.source === nodeId) {
          return outputPorts.some((p) => p.id === e.sourceHandle);
        }
        if (e.target === nodeId) {
          return inputPorts.some((p) => p.id === e.targetHandle);
        }
        return true;
      }),
    }));
  },

  fetchReplicateSchemaAndConfigure: async (nodeId, owner, name) => {
    try {
      const schema = await fetchReplicateSchema(owner, name);

      const inputProps = ((schema.input_schema as Record<string, unknown>)?.properties as Record<string, Record<string, unknown>>) ?? {};
      const requiredInputs: string[] = ((schema.input_schema as Record<string, unknown>)?.required as string[]) ?? [];
      const dynamicParams: DynamicParamDefinition[] = [];
      const inputPorts: DynamicPortDefinition[] = [];

      for (const [key, prop] of Object.entries(inputProps)) {
        const p = prop as Record<string, unknown>;
        const description = (p.description as string) ?? '';
        const isUploadable = p['x-uploadable'] === true;
        const format = (p.format as string) ?? '';

        if (isUploadable || format === 'uri') {
          inputPorts.push({
            id: key,
            label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            dataType: 'Image',
            required: requiredInputs.includes(key),
          });
          continue;
        }

        let paramType: DynamicParamDefinition['type'] = 'string';
        if (p.type === 'integer') paramType = 'integer';
        else if (p.type === 'number') paramType = 'float';
        else if (p.type === 'boolean') paramType = 'boolean';
        else if (p.enum) paramType = 'enum';

        const param: DynamicParamDefinition = {
          key,
          label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          type: paramType,
          required: requiredInputs.includes(key),
          default: p.default,
          placeholder: description.slice(0, 80),
        };

        if (p.enum) {
          param.options = (p.enum as Array<string | number>).map((v) => ({ label: String(v), value: v }));
        }
        if (p.minimum !== undefined) param.min = p.minimum as number;
        if (p.maximum !== undefined) param.max = p.maximum as number;

        dynamicParams.push(param);
      }

      const outputPorts: DynamicPortDefinition[] = [];
      const outputSchema = schema.output_schema as Record<string, unknown>;

      if (outputSchema?.type === 'string' && outputSchema?.format === 'uri') {
        outputPorts.push({ id: 'image', label: 'Output', dataType: 'Image', required: false });
      } else if (outputSchema?.type === 'array') {
        outputPorts.push({ id: 'image', label: 'Output', dataType: 'Image', required: false });
      } else {
        outputPorts.push({ id: 'text', label: 'Output', dataType: 'Text', required: false });
      }

      const paramDefaults: Record<string, unknown> = {};
      for (const dp of dynamicParams) {
        if (dp.default !== undefined) paramDefaults[dp.key] = dp.default;
      }

      set((state) => ({
        nodes: state.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const data = n.data as unknown as DynamicNodeData;
          return {
            ...n,
            data: {
              ...data,
              params: { ...data.params, ...paramDefaults, _version_id: schema.version_id, _schema_fetched: true },
              dynamicInputPorts: inputPorts,
              dynamicOutputPorts: outputPorts,
              dynamicParams,
              providerMeta: { ...data.providerMeta, version_id: schema.version_id, description: schema.description },
            } as unknown as NodeData,
          };
        }),
      }));
    } catch (err) {
      console.error('Failed to fetch Replicate schema:', err);
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
          if ((outputVal.type === 'Image' || outputVal.type === 'Video') && outputVal.value && typeof outputVal.value === 'string') {
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
