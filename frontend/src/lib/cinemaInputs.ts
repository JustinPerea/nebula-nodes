import type { Edge, Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { getReferenceRole } from './referenceRoles';

const INPUT_LABELS = {
  character_refs: 'Character refs',
  character: 'Character',
  camera_rig: 'Camera rig',
  reference_set: 'Reference set',
} as const;

export interface CinemaConnectedInput {
  edgeId: string;
  sourceId: string;
  sourceLabel: string;
  role: keyof typeof INPUT_LABELS;
  roleLabel: string;
  summary: string;
  imageUrls: string[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const strings = (value: unknown): string[] => (Array.isArray(value) ? value : [value])
  .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
const referenceCount = (count: number) => `${count} reference${count === 1 ? '' : 's'}`;

/** Inspect the connected output only. Other outputs on the same node must not
 * masquerade as the input wired to Cinema. No graph/model operation occurs. */
export function cinemaConnectedInputs(nodeId: string, nodes: Node<NodeData>[], edges: Edge[]): CinemaConnectedInput[] {
  if (!nodes.some((node) => node.id === nodeId && node.data.definitionId === 'cinema-scene')) return [];
  return edges.flatMap((edge) => {
    if (edge.target !== nodeId || !edge.targetHandle || !Object.hasOwn(INPUT_LABELS, edge.targetHandle)) return [];
    const source = nodes.find((node) => node.id === edge.source);
    if (!source) return [];
    const role = edge.targetHandle as CinemaConnectedInput['role'];
    let value: unknown = edge.sourceHandle ? source.data.outputs?.[edge.sourceHandle]?.value : undefined;
    // Static image inputs are usable before execution; these are the same
    // authoring fields used by their Canvas preview and backend input handler.
    if (role === 'character_refs' && edge.sourceHandle === 'image' && !value && source.data.definitionId === 'image-input') {
      value = source.data.params._previewUrl || source.data.params.filePath;
    }
    const bundle = record(value);
    let imageUrls: string[] = [];
    let summary = 'Awaiting output';
    if (role === 'character_refs') {
      imageUrls = strings(value);
      if (imageUrls.length) summary = referenceCount(imageUrls.length);
    } else if (role === 'character' && bundle) {
      imageUrls = [...strings(bundle.referenceViews), ...strings(bundle.overrideRefs)];
      const name = typeof bundle.name === 'string' ? bundle.name : 'Character data';
      summary = `${name} · ${referenceCount(imageUrls.length)}`;
    } else if (role === 'camera_rig' && bundle) {
      const focal = bundle.focalLength;
      const height = bundle.height;
      const parts = [typeof focal === 'number' && Number.isFinite(focal) ? `${focal} mm` : null,
        typeof height === 'number' && Number.isFinite(height) ? `${height} m height` : null].filter(Boolean);
      summary = parts.join(' · ') || 'Camera guidance';
    } else if (role === 'reference_set' && bundle && Array.isArray(bundle.items)) {
      const roles: string[] = [];
      for (const raw of bundle.items) {
        const item = record(raw);
        if (!item || typeof item.url !== 'string' || !item.url) continue;
        const weight = item.weight;
        const priority = weight === null || weight === undefined || weight === '' || typeof weight === 'boolean'
          ? 1 : Number(weight);
        if (Number.isFinite(priority) && priority <= 0) continue;
        const label = typeof item.role === 'string' ? getReferenceRole(item.role)?.label : undefined;
        if (!label) continue;
        imageUrls.push(item.url);
        if (!roles.includes(label)) roles.push(label);
      }
      summary = imageUrls.length ? `${referenceCount(imageUrls.length)} · ${roles.join(', ')}` : 'No active references';
    }
    return [{ edgeId: edge.id, sourceId: source.id, sourceLabel: source.data.label || source.id,
      role, roleLabel: INPUT_LABELS[role], summary, imageUrls }];
  });
}
