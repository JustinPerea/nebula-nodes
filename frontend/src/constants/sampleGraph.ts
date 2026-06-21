import { v4 as uuidv4 } from 'uuid';
import type { Node, Edge } from '@xyflow/react';
import type { NodeData } from '../types';
import { NODE_DEFINITIONS } from './nodeDefinitions';

/** A friendly starter prompt for the onboarding sample pipeline. */
const DEMO_PROMPT = 'a neon koi swimming through a nebula, cinematic, volumetric light';

/** Build a node's default params from its definition (mirrors graphStore.addNode). */
function defaultsFor(definitionId: string): Record<string, unknown> {
  const def = NODE_DEFINITIONS[definitionId];
  if (!def) return {};
  const out: Record<string, unknown> = {};
  const sources = def.sharedParams
    ? [...def.sharedParams, ...(def.falParams ?? []), ...(def.directParams ?? [])]
    : def.params;
  for (const p of sources) if (p.default !== undefined) out[p.key] = p.default;
  return out;
}

/**
 * A minimal, working starter pipeline for first-run onboarding: a Text Input
 * feeding a prompt into Imagen 4. Returns fresh UUIDs each call (loadable via
 * graphStore.loadSampleGraph). Node shape matches addNode's local fallback so
 * both render through ModelNode ('model-node').
 */
export function buildSampleGraph(): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const textId = uuidv4();
  const imagenId = uuidv4();

  const nodes: Node<NodeData>[] = [
    {
      id: textId,
      type: 'model-node',
      position: { x: 0, y: 40 },
      data: {
        label: NODE_DEFINITIONS['text-input']?.displayName ?? 'Text Input',
        definitionId: 'text-input',
        params: { ...defaultsFor('text-input'), value: DEMO_PROMPT },
        state: 'idle',
        outputs: {},
      },
    },
    {
      id: imagenId,
      type: 'model-node',
      position: { x: 420, y: 0 },
      data: {
        label: NODE_DEFINITIONS['imagen-4-generate']?.displayName ?? 'Imagen 4',
        definitionId: 'imagen-4-generate',
        params: defaultsFor('imagen-4-generate'),
        state: 'idle',
        outputs: {},
      },
    },
  ];

  const edges: Edge[] = [
    {
      id: `e-${textId}-${imagenId}`,
      source: textId,
      sourceHandle: 'text',
      target: imagenId,
      targetHandle: 'prompt',
      type: 'typed-edge',
    },
  ];

  return { nodes, edges };
}
