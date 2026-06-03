import type { Node } from '@xyflow/react';
import type { NodeData, PortValue } from '../types';

export interface GenerationRecord {
  genId: string;
  prompt: string;
  ts: number;
  modelNodeIds: string[];
}

export type ViewableKind = 'image' | 'video';

export interface ViewableMedia {
  url: string;
  kind: ViewableKind;
}

function resolveMediaUrl(v: PortValue['value']): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'url' in (v as Record<string, unknown>)) {
    return (v as { url: string }).url;
  }
  return null;
}

/**
 * The single image/video a completed result node should show in the fullscreen
 * lightbox, or null if there's nothing zoomable. Video takes precedence over
 * image/SVG to match OutputRenderer's render order.
 */
export function firstViewableMedia(node: Node<NodeData> | undefined): ViewableMedia | null {
  if (!node || node.data.state !== 'complete') return null;
  const outputs = node.data.outputs ?? {};
  const video = Object.values(outputs).find((o) => o && o.type === 'Video' && o.value);
  if (video) {
    const url = resolveMediaUrl(video.value);
    if (url) return { url, kind: 'video' };
  }
  const image = Object.values(outputs).find((o) => o && (o.type === 'Image' || o.type === 'SVG') && o.value);
  if (image) {
    const url = resolveMediaUrl(image.value);
    if (url) return { url, kind: 'image' };
  }
  return null;
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
