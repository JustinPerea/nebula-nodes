import type { Edge, Node } from '@xyflow/react';
import type { NodeData, PaperRunInput } from '../types';
import type { PaperSourceRecord } from './paperSource';
import { edgesInto, nodeById } from './graphIndex';

/**
 * What a canvas card draws from other nodes, read from the store's arrays.
 * Each returns a primitive, so a card's store selector re-renders it only
 * when the value it draws changes (see components/nodes/ModelNode.tsx).
 */

/** The image a Mask Painter paints over: its wired source's preview or image output. */
export function maskSourcePreview(nodes: readonly Node[], edges: readonly Edge[], nodeId: string): string | null {
  const inEdge = edgesInto(edges, nodeId).find((edge) => (edge.targetHandle ?? 'image') === 'image');
  if (!inEdge) return null;
  const source = nodeById(nodes, inEdge.source);
  if (!source) return null;
  const data = source.data as unknown as NodeData;
  if (data.definitionId === 'image-input' && data.params._previewUrl) return String(data.params._previewUrl);
  const imageOutput = Object.values(data.outputs ?? {}).find(
    (output) => output.type === 'Image' && typeof output.value === 'string' && output.value,
  );
  if (imageOutput) return String(imageOutput.value);
  if (data.params._previewUrl) return String(data.params._previewUrl);
  return null;
}

/** Whether every Paper source an output was made from has a current export
 * to rerun with (the card's "Rerun with latest source"). */
export function paperSourcesReady(nodes: readonly Node[], inputs: readonly PaperRunInput[]): boolean {
  return inputs.every((input) => {
    const source = (nodeById(nodes, input.nodeId)?.data as NodeData | undefined)?.params._paperSource as PaperSourceRecord | undefined;
    return source?.state === 'current' && Boolean(source.snapshot);
  });
}

/** Whether a wire reaches this input port. */
export function portWired(edges: readonly Edge[], nodeId: string, portId: string): boolean {
  return edgesInto(edges, nodeId).some((edge) => edge.targetHandle === portId);
}
