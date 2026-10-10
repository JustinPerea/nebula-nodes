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
 * feeding a prompt into Nano Banana. Returns fresh UUIDs each call (loadable via
 * graphStore.loadSampleGraph). Node shape matches addNode's local fallback so
 * both render through ModelNode ('model-node').
 */
export function buildSampleGraph(): { nodes: Node<NodeData>[]; edges: Edge[] } {
  const textId = uuidv4();
  const imageId = uuidv4();

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
      id: imageId,
      type: 'model-node',
      position: { x: 420, y: 0 },
      data: {
        label: NODE_DEFINITIONS['nano-banana']?.displayName ?? 'Nano Banana',
        definitionId: 'nano-banana',
        params: defaultsFor('nano-banana'),
        state: 'idle',
        outputs: {},
      },
    },
  ];

  const edges: Edge[] = [
    {
      id: `e-${textId}-${imageId}`,
      source: textId,
      sourceHandle: 'text',
      target: imageId,
      targetHandle: 'prompt',
      type: 'typed-edge',
    },
  ];

  return { nodes, edges };
}
