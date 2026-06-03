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
