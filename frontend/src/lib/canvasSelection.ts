import JSZip from 'jszip';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { apiFetch, backendAssetUrlSync } from './backend';
import {
  GRAPH_BUNDLE_MAX_ASSET_BYTES,
  GRAPH_BUNDLE_MAX_TOTAL_BYTES,
} from './graphFile';
import { readBoundedAssetResponse } from './boundedAsset';
import { isSafeWorldUrl, parseWorldValue } from './worldValue';


export function selectedNodeIds(nodes: Node<NodeData>[]): string[] {
  return nodes.filter((node) => node.selected).map((node) => node.id);
}


export async function publishCanvasSelection(nodeIds: string[], signal?: AbortSignal): Promise<void> {
  const response = await apiFetch('/api/canvas/selection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeIds }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Selection sync failed: HTTP ${response.status}`);
  }
}


export interface DownloadableOutput {
  nodeId: string;
  label: string;
  portId: string;
  url: string;
}


function outputUrls(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.startsWith('/api/') || value.startsWith('http://') || value.startsWith('https://')
      ? [value]
      : [];
  }
  if (Array.isArray(value)) return value.flatMap(outputUrls);
  if (value && typeof value === 'object') {
    const world = parseWorldValue(value);
    if (world) {
      return [
        ...Object.values(world.assets.splats),
        world.assets.panorama,
        world.assets.colliderMesh,
        world.assets.thumbnail,
      ].filter(isSafeWorldUrl);
    }
    if ('value' in value) return outputUrls((value as { value: unknown }).value);
  }
  return [];
}


export function collectDownloadableOutputs(nodes: Node<NodeData>[]): DownloadableOutput[] {
  const seen = new Set<string>();
  return nodes.flatMap((node) =>
    Object.entries(node.data.outputs ?? {}).flatMap(([portId, value]) =>
      outputUrls(value).flatMap((url) => {
        const key = `${node.id}:${url}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{
          nodeId: node.id,
          label: node.data.label,
          portId,
          url,
        }];
      }),
    ),
  );
}


function safeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'output';
}


function extensionFor(url: string, contentType: string | null): string {
  const pathname = (() => {
    try {
      return new URL(url, window.location.href).pathname;
    } catch {
      return url;
    }
  })();
  const match = pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
  if (match) return match[1].toLowerCase();
  const subtype = contentType?.split(';')[0].split('/')[1];
  return subtype?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'bin';
}


export async function downloadSelectedOutputs(nodes: Node<NodeData>[]): Promise<number> {
  const outputs = collectDownloadableOutputs(nodes);
  if (outputs.length === 0) return 0;
  const zip = new JSZip();
  const nameCounts = new Map<string, number>();
  let totalBytes = 0;
  for (const output of outputs) {
    const remainingBytes = GRAPH_BUNDLE_MAX_TOTAL_BYTES - totalBytes;
    if (remainingBytes <= 0) {
      throw new Error('Selected outputs exceed the safe ZIP size limit. Download fewer outputs at once.');
    }
    const response = await fetch(backendAssetUrlSync(output.url), { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not download ${output.nodeId}:${output.portId}`);
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedAssetResponse(
        response,
        Math.min(GRAPH_BUNDLE_MAX_ASSET_BYTES, remainingBytes),
      );
    } catch {
      throw new Error(
        `Output ${output.nodeId}:${output.portId} exceeds the safe ZIP size limit. Download it separately.`,
      );
    }
    totalBytes += bytes.byteLength;
    const base = `${safeFilenamePart(output.nodeId)}-${safeFilenamePart(output.label)}-${safeFilenamePart(output.portId)}`;
    const seen = nameCounts.get(base) ?? 0;
    nameCounts.set(base, seen + 1);
    const suffix = seen === 0 ? '' : `-${seen + 1}`;
    zip.file(`${base}${suffix}.${extensionFor(output.url, response.headers.get('content-type'))}`, bytes);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `nebula-selected-outputs-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  return outputs.length;
}
