import JSZip from 'jszip';
import type { Node } from '@xyflow/react';
import type { NodeData } from '../types';
import { backendAssetUrlSync } from './backend';
import { apiRequest } from './apiRequest';
import {
  GRAPH_BUNDLE_MAX_ASSET_BYTES,
  GRAPH_BUNDLE_MAX_TOTAL_BYTES,
} from './graphFileShared';
import { readBoundedAssetResponse } from './boundedAsset';
import { ConnectionLostError, copyForStatus, FailureNotice, isConnectionFailure, requestError, requestSucceeded } from './errorCopy';
import { isSafeWorldUrl, parseWorldValue } from './worldValue';


export function selectedNodeIds(nodes: Node<NodeData>[]): string[] {
  return nodes.filter((node) => node.selected).map((node) => node.id);
}


export async function publishCanvasSelection(nodeIds: string[], signal?: AbortSignal): Promise<void> {
  // Background sync, never shown; named like every request so the console
  // says what failed, once.
  await apiRequest("Couldn't share the selection.", '/api/canvas/selection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeIds }),
    signal,
  });
}


export interface DownloadableOutput {
  nodeId: string;
  label: string;
  portId: string;
  url: string;
  /** The output's data type ("Image", "Video", "World"), for a node with no name. */
  type?: string;
}


/** The data type a port's value says it is ("Image"), if any. */
function valueType(value: unknown): string | undefined {
  return value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
    ? (value as { type: string }).type : undefined;
}

/** How a too-large output is named to the person (GM, error-copy round 2):
 * by the name its card shows on the canvas, never "n1:image"; with no name,
 * by its type, "This image". */
function outputName(output: DownloadableOutput): string {
  const label = output.label?.trim();
  if (label) return label;
  const noun = output.type?.trim().toLowerCase();
  return `This ${noun || 'output'}`;
}

/** GM's lines, verbatim. */
export const SELECTION_TOO_LARGE_COPY = 'Those outputs are too large for one ZIP. Download fewer at a time.';
const outputTooLarge = (output: DownloadableOutput) => `${outputName(output)} is too large for the ZIP. Download it on its own.`;
const DOWNLOAD_OUTPUTS = "Couldn't download the outputs.";

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
          type: valueType(value),
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
    if (remainingBytes <= 0) throw new FailureNotice('', SELECTION_TOO_LARGE_COPY);
    // An asset URL, not an API path, so apiFetch can't make this request;
    // turn its failures into copy the same way (error-copy review): the
    // selection toolbar shows this error as the Download button's title, one
    // line: "Couldn't download the outputs. <reason>".
    const response = await fetch(backendAssetUrlSync(output.url), { cache: 'no-store' })
      .catch((error: unknown) => {
        throw isConnectionFailure(error) ? new ConnectionLostError(error, { heading: DOWNLOAD_OUTPUTS }) : error;
      });
    if (!response.ok) {
      // The ids stay for the console, not the title.
      throw await requestError(DOWNLOAD_OUTPUTS, response,
        { detail: `${output.nodeId}:${output.portId}`, reason: copyForStatus(response.status, undefined) });
    }
    requestSucceeded(DOWNLOAD_OUTPUTS);
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedAssetResponse(
        response,
        Math.min(GRAPH_BUNDLE_MAX_ASSET_BYTES, remainingBytes),
      );
    } catch {
      // Too large for what's left of the ZIP: the whole selection when other
      // outputs already filled it, else this one.
      // Written lines (GM, round 2), thrown as a FailureNotice so the toolbar
      // shows them under its heading rather than GM's general line.
      throw new FailureNotice('', remainingBytes < GRAPH_BUNDLE_MAX_ASSET_BYTES && totalBytes > 0
        ? SELECTION_TOO_LARGE_COPY : outputTooLarge(output));
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
