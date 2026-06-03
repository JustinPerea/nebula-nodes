import type { Node } from '@xyflow/react';
import type { NodeData } from '../types';

export interface GenerationRecord {
  genId: string;
  prompt: string;
  ts: number;
  modelNodeIds: string[];
}

export interface GalleryItem {
  genId: string;
  prompt: string;
  ts: number;
  nodeId: string;
  node: Node<NodeData> | undefined;
}

/** Flatten session generations (newest first) into one item per live model node. */
export function galleryItemsFromSession(records: GenerationRecord[], nodes: Node<NodeData>[]): GalleryItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const items: GalleryItem[] = [];
  for (const rec of [...records].sort((a, b) => b.ts - a.ts)) {
    for (const nodeId of rec.modelNodeIds) {
      if (!byId.has(nodeId)) continue;
      items.push({ genId: rec.genId, prompt: rec.prompt, ts: rec.ts, nodeId, node: byId.get(nodeId) });
    }
  }
  return items;
}

const RAW_INPUT_TYPES = ['text-input', 'image-input', 'reroute'];

/**
 * Collect all canvas nodes that have at least one non-empty output,
 * excluding raw inputs and wiring nodes.  Optionally filtered to a
 * subset of node ids.  Returns items sorted newest-first (by
 * _createOrigin.ts when present, else ts=0).
 */
export function galleryItemsFromCanvas(
  nodes: Node<NodeData>[],
  selectedIds?: Set<string>,
): GalleryItem[] {
  const filtered = nodes.filter((n) => {
    if (selectedIds && selectedIds.size > 0 && !selectedIds.has(n.id)) return false;
    if (RAW_INPUT_TYPES.includes(n.data.definitionId)) return false;
    return Object.values(n.data.outputs ?? {}).some(
      (o) => o && (o as { value?: unknown }).value,
    );
  });

  return filtered
    .map((n) => {
      const origin = n.data._createOrigin as
        | { genId: string; prompt: string; ts: number }
        | undefined;
      return {
        genId: origin?.genId ?? n.id,
        prompt: origin?.prompt ?? n.data.label,
        ts: origin?.ts ?? 0,
        nodeId: n.id,
        node: n,
      };
    })
    .sort((a, b) => b.ts - a.ts);
}
