import type { Node, Edge } from '@xyflow/react';
import type { NodeData } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

const RAW_INPUT_TYPES = ['text-input', 'image-input', 'reroute'];

export interface ComposerPrefill {
  modelId: string;
  prompt: string;
  params: Record<string, unknown>;
}

export interface ComposerSelectionState {
  selectedIds: string[];
  prefill: ComposerPrefill | null;
}

/**
 * Given the current canvas nodes + edges, snapshot the selection and derive a
 * composer prefill when exactly one generation-model node is selected.
 *
 * - `selectedIds`: ids of ALL selected nodes (regardless of type).
 * - `prefill`: non-null only when exactly one selected node is a model node
 *   (exists in NODE_DEFINITIONS and is not a raw-input/wiring type).
 *   For that node:
 *     • `modelId`  = its definitionId
 *     • `params`   = its params with all `_`-prefixed keys stripped (so a fresh
 *                    `_variant` is minted on the next generate call)
 *     • `prompt`   = the `value` param of the upstream text-input node feeding
 *                    it (traced via edges), else ''
 */
export function composerStateFromSelection(
  nodes: Node<NodeData>[],
  edges: Edge[],
): ComposerSelectionState {
  const selectedNodes = nodes.filter((n) => n.selected);
  const selectedIds = selectedNodes.map((n) => n.id);

  if (selectedIds.length === 0) return { selectedIds, prefill: null };

  // A model node is defined in NODE_DEFINITIONS and is not a raw-input/wiring
  const modelNodes = selectedNodes.filter(
    (n) =>
      NODE_DEFINITIONS[n.data.definitionId] !== undefined &&
      !RAW_INPUT_TYPES.includes(n.data.definitionId),
  );

  if (modelNodes.length !== 1) return { selectedIds, prefill: null };

  const modelNode = modelNodes[0];

  // Strip _-prefixed params so a fresh variant is minted on next generate
  const params: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(modelNode.data.params ?? {})) {
    if (!k.startsWith('_')) params[k] = v;
  }

  // Trace upstream text-input: find an edge whose target is this node and
  // whose source is a text-input node
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  let prompt = '';
  for (const edge of edges) {
    if (edge.target !== modelNode.id) continue;
    const sourceNode = nodeById.get(edge.source);
    if (!sourceNode || sourceNode.data.definitionId !== 'text-input') continue;
    const val = (sourceNode.data.params?.value ?? sourceNode.data.outputs?.value) as unknown;
    if (typeof val === 'string') {
      prompt = val;
      break;
    }
  }

  return {
    selectedIds,
    prefill: {
      modelId: modelNode.data.definitionId,
      prompt,
      params,
    },
  };
}
