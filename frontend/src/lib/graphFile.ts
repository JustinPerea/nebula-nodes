import JSZip from 'jszip';
import type { Node, Edge, Viewport } from '@xyflow/react';
import type { NodeData } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

/**
 * .nebula.zip / .nebula file format — graph persistence.
 *
 * v3 (current): zip bundle containing `graph.json` plus every referenced
 * asset under `assets/<original-relative-path>`. Self-contained — the file
 * survives the backend purging output/ or being moved to another machine.
 * On load the frontend uploads the zip to POST /api/outputs/restore which
 * extracts assets to a fresh output dir and returns a URL mapping; we then
 * rewrite each output URL in graph.json in-place before hydrating the canvas.
 *
 * v2: plain JSON with URL references to output/. Still loadable (backward-
 * compat path) — just shows broken images if the referenced files are gone.
 * v1: structure + params only, no outputs.
 */

export interface NebulaFile {
  version: 1 | 2 | 3;
  name: string;
  createdAt: string;
  nodes: NebulaNode[];
  edges: NebulaEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

interface NebulaNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    definitionId: string;
    params: Record<string, unknown>;
    outputs?: Record<string, unknown>;
    state?: 'idle' | 'executing' | 'complete' | 'error';
  };
}

interface NebulaEdge {
  id: string;
  source: string;
  sourceHandle: string | null | undefined;
  target: string;
  targetHandle: string | null | undefined;
  type: string;
  data?: Record<string, unknown>;
}

/**
 * Serialize current graph state to .nebula format.
 * Strips outputs, errors, progress, streaming state — only persists structure + params.
 */
export function serializeGraph(
  nodes: Node<NodeData>[],
  edges: Edge[],
  viewport?: Viewport,
  name?: string,
): NebulaFile {
  return {
    version: 2,
    name: name ?? 'Untitled Graph',
    createdAt: new Date().toISOString(),
    nodes: nodes.map((n) => {
      const hasOutputs = n.data.outputs && Object.keys(n.data.outputs).length > 0;
      return {
        id: n.id,
        type: n.type ?? 'model-node',
        position: { x: n.position.x, y: n.position.y },
        data: {
          label: n.data.label,
          definitionId: n.data.definitionId,
          params: { ...n.data.params },
          outputs: hasOutputs ? { ...n.data.outputs } : undefined,
          state: hasOutputs ? 'complete' : 'idle',
        },
      };
    }),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      sourceHandle: e.sourceHandle,
      target: e.target,
      targetHandle: e.targetHandle,
      type: e.type ?? 'typed-edge',
      data: e.data ? { ...(e.data as Record<string, unknown>) } : undefined,
    })),
    viewport: viewport
      ? { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
      : undefined,
  };
}

/**
 * Deserialize a .nebula file back into React Flow nodes and edges.
 * Validates that node definitions exist. Unknown nodes get a warning but are still loaded.
 * State is always reset to 'idle', outputs are empty.
 */
export function deserializeGraph(
  file: NebulaFile,
): { nodes: Node<NodeData>[]; edges: Edge[]; viewport?: Viewport; warnings: string[] } {
  const warnings: string[] = [];

  const nodes: Node<NodeData>[] = file.nodes.map((n) => {
    const definition = NODE_DEFINITIONS[n.data.definitionId];
    if (!definition) {
      warnings.push(`Unknown node definition: "${n.data.definitionId}" (node ${n.id})`);
    }
    const outputs = (n.data.outputs ?? {}) as Record<string, unknown>;
    const hasOutputs = Object.keys(outputs).length > 0;
    // v2+: trust saved state (complete if outputs present). v1: always idle, no outputs.
    const state = hasOutputs ? (n.data.state ?? 'complete') : 'idle';
    return {
      id: n.id,
      type: n.type,
      position: n.position,
      data: {
        label: n.data.label,
        definitionId: n.data.definitionId,
        params: n.data.params,
        state,
        outputs,
      },
    };
  });

  const edges: Edge[] = file.edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
    type: e.type,
    data: e.data,
  }));

  const viewport = file.viewport
    ? { x: file.viewport.x, y: file.viewport.y, zoom: file.viewport.zoom }
    : undefined;

  return { nodes, edges, viewport, warnings };
}

/**
 * Walk a serialized graph and collect every `/api/outputs/<path>` URL that
 * appears in node outputs OR in params (image-input nodes hold upload paths).
 * Returns a map of `<path>` (no prefix) → absolute URL we'll fetch.
 */
function collectAssetPaths(file: NebulaFile): Map<string, string> {
  const paths = new Map<string, string>();
  const PREFIX = '/api/outputs/';

  const record = (value: unknown) => {
    if (typeof value !== 'string' || !value.startsWith(PREFIX)) return;
    const rel = value.slice(PREFIX.length);
    if (rel && !paths.has(rel)) paths.set(rel, value);
  };

  const walk = (v: unknown) => {
    if (v == null) return;
    if (typeof v === 'string') return record(v);
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };

  for (const node of file.nodes) {
    if (node.data.outputs) walk(node.data.outputs);
    if (node.data.params) walk(node.data.params);
  }
  return paths;
}

/**
 * Save the graph as a `.nebula.zip` bundle: graph.json plus every referenced
 * asset under assets/. Self-contained and portable — the file reloads cleanly
 * even after output/ is purged or on a fresh checkout.
 *
 * Fetch errors (vanished asset between Save click and fetch) are logged and
 * the asset is skipped; the rest of the bundle still saves. Load will show
 * a broken-image placeholder for the missing one, same as today.
 */
export async function saveToFile(
  nodes: Node<NodeData>[],
  edges: Edge[],
  viewport?: Viewport,
): Promise<void> {
  const file = serializeGraph(nodes, edges, viewport);
  file.version = 3;

  const zip = new JSZip();
  zip.file('graph.json', JSON.stringify(file, null, 2));

  const assetPaths = collectAssetPaths(file);
  const assetsFolder = zip.folder('assets');
  if (assetsFolder) {
    await Promise.all(
      Array.from(assetPaths.entries()).map(async ([rel, url]) => {
        try {
          const resp = await fetch(url);
          if (!resp.ok) {
            console.warn(`[save] ${url} → HTTP ${resp.status}, skipping`);
            return;
          }
          const bytes = await resp.arrayBuffer();
          assetsFolder.file(rel, bytes);
        } catch (err) {
          console.warn(`[save] failed to fetch ${url}:`, err);
        }
      }),
    );
  }

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const suggestedName = `${file.name.replace(/[^a-zA-Z0-9-_ ]/g, '')}.nebula.zip`;

  // Try File System Access API first (Chrome/Edge)
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (window as unknown as {
        showSaveFilePicker: (opts: {
          suggestedName: string;
          types: Array<{
            description: string;
            accept: Record<string, string[]>;
          }>;
        }) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker({
        suggestedName,
        types: [
          {
            description: 'Nebula Node Graph Bundle',
            accept: { 'application/zip': ['.nebula.zip', '.zip'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return;
      console.warn('File System Access API failed, falling back to download:', err);
    }
  }

  // Fallback: download via <a> tag
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Walk a loaded graph and rewrite every `/api/outputs/<old-rel>` URL it
 * contains, using the mapping returned by POST /api/outputs/restore. Mutates
 * nodes/params/outputs in place. Entries without a mapping entry stay as-is
 * (they'll render broken images, same as loading a pre-v3 file today).
 */
function rewriteAssetUrls(
  nodes: NebulaNode[],
  mapping: Record<string, string>,
): void {
  const PREFIX = '/api/outputs/';
  const remap = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith(PREFIX)) {
      const rel = v.slice(PREFIX.length);
      return mapping[rel] ?? v;
    }
    if (Array.isArray(v)) return v.map(remap);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = remap(val);
      }
      return out;
    }
    return v;
  };
  for (const node of nodes) {
    if (node.data.outputs) {
      node.data.outputs = remap(node.data.outputs) as Record<string, unknown>;
    }
    if (node.data.params) {
      node.data.params = remap(node.data.params) as Record<string, unknown>;
    }
  }
}

/** Zip magic bytes: "PK\x03\x04". */
function isZipBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const b = new Uint8Array(buf, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

/**
 * Load graph from a file using the File System Access API.
 * Falls back to <input type="file"> if the API is not available.
 *
 * Detects .nebula.zip bundles (v3) vs plain JSON (v1/v2). Zips get
 * restored via POST /api/outputs/restore so asset URLs point at the freshly
 * extracted files; plain JSON files load as before (backward compat — assets
 * will render broken if the referenced output/ files are gone).
 *
 * Returns null on user cancellation or hard parse failure.
 */
export async function loadFromFile(): Promise<{
  nodes: Node<NodeData>[];
  edges: Edge[];
  viewport?: Viewport;
  warnings: string[];
} | null> {
  let buffer: ArrayBuffer | null = null;

  // Try File System Access API first
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (window as unknown as {
        showOpenFilePicker: (opts: {
          types: Array<{
            description: string;
            accept: Record<string, string[]>;
          }>;
          multiple: boolean;
        }) => Promise<FileSystemFileHandle[]>;
      }).showOpenFilePicker({
        types: [
          {
            description: 'Nebula Node Graph',
            accept: {
              'application/zip': ['.nebula.zip', '.zip'],
              'application/json': ['.nebula', '.json'],
            },
          },
        ],
        multiple: false,
      });
      const file = await handle.getFile();
      buffer = await file.arrayBuffer();
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      console.warn('File System Access API failed, falling back to input:', err);
      buffer = await loadViaInput();
      if (!buffer) return null;
    }
  } else {
    buffer = await loadViaInput();
    if (!buffer) return null;
  }

  try {
    const warnings: string[] = [];
    let parsed: NebulaFile;

    if (isZipBuffer(buffer)) {
      const zip = await JSZip.loadAsync(buffer);
      const graphEntry = zip.file('graph.json');
      if (!graphEntry) {
        throw new Error('Bundle missing graph.json');
      }
      parsed = JSON.parse(await graphEntry.async('string')) as NebulaFile;

      // Re-export the zip as bytes for the restore endpoint. Using the
      // original buffer directly also works — but re-generating ensures we
      // send exactly what JSZip already decompressed / normalized.
      const blob = new Blob([buffer], { type: 'application/zip' });
      try {
        const resp = await fetch('http://localhost:8000/api/outputs/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/zip' },
          body: blob,
        });
        if (!resp.ok) {
          warnings.push(`Asset restore failed (HTTP ${resp.status}) — images may appear broken.`);
        } else {
          const { urlMapping } = (await resp.json()) as { urlMapping: Record<string, string> };
          rewriteAssetUrls(parsed.nodes, urlMapping);
        }
      } catch (err) {
        warnings.push(`Asset restore failed: ${(err as Error).message}`);
      }
    } else {
      // Plain JSON — v1/v2 backward compat.
      const text = new TextDecoder('utf-8').decode(buffer);
      parsed = JSON.parse(text) as NebulaFile;
    }

    if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) {
      throw new Error(`Unsupported .nebula file version: ${parsed.version}`);
    }
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error('Invalid .nebula file: missing nodes or edges arrays');
    }

    const result = deserializeGraph(parsed);
    return { ...result, warnings: [...warnings, ...result.warnings] };
  } catch (err) {
    console.error('Failed to load graph file:', err);
    alert(`Failed to load graph: ${(err as Error).message}`);
    return null;
  }
}

/** Fallback file picker using a hidden <input> element. Returns the file
 * contents as an ArrayBuffer so the caller can detect zip vs JSON itself. */
function loadViaInput(): Promise<ArrayBuffer | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.nebula,.nebula.zip,.zip,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      resolve(await file.arrayBuffer());
    };
    // If the user cancels, onchange never fires — resolve null after cancel
    input.oncancel = () => resolve(null);
    input.click();
  });
}
