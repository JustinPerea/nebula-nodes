import type { Node, Edge, Viewport } from '@xyflow/react';
import type { NodeData } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';

/**
 * .nebula file format — versioned JSON for graph persistence.
 *
 * Design decisions:
 * - Outputs and execution state are stripped on save (don't persist generated images)
 * - Node state is reset to 'idle' on save
 * - Version field allows future format migrations
 * - Viewport is optional (defaults to fit-all on load)
 */

export interface NebulaFile {
  version: 1;
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
    version: 1,
    name: name ?? 'Untitled Graph',
    createdAt: new Date().toISOString(),
    nodes: nodes.map((n) => ({
      id: n.id,
      type: n.type ?? 'model-node',
      position: { x: n.position.x, y: n.position.y },
      data: {
        label: n.data.label,
        definitionId: n.data.definitionId,
        params: { ...n.data.params },
      },
    })),
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
    return {
      id: n.id,
      type: n.type,
      position: n.position,
      data: {
        label: n.data.label,
        definitionId: n.data.definitionId,
        params: n.data.params,
        state: 'idle' as const,
        outputs: {},
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
 * Save graph to a file using the File System Access API.
 * Falls back to download-link approach if the API is not available.
 */
export async function saveToFile(
  nodes: Node<NodeData>[],
  edges: Edge[],
  viewport?: Viewport,
): Promise<void> {
  const file = serializeGraph(nodes, edges, viewport);
  const json = JSON.stringify(file, null, 2);
  const blob = new Blob([json], { type: 'application/json' });

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
        suggestedName: `${file.name.replace(/[^a-zA-Z0-9-_ ]/g, '')}.nebula`,
        types: [
          {
            description: 'Nebula Node Graph',
            accept: { 'application/json': ['.nebula'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (err) {
      // User cancelled the picker — this is expected, not an error
      if ((err as DOMException).name === 'AbortError') return;
      console.warn('File System Access API failed, falling back to download:', err);
    }
  }

  // Fallback: download via <a> tag
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${file.name.replace(/[^a-zA-Z0-9-_ ]/g, '')}.nebula`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Load graph from a file using the File System Access API.
 * Falls back to <input type="file"> if the API is not available.
 * Returns the deserialized result, or null if the user cancelled.
 */
export async function loadFromFile(): Promise<{
  nodes: Node<NodeData>[];
  edges: Edge[];
  viewport?: Viewport;
  warnings: string[];
} | null> {
  let text: string;

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
            accept: { 'application/json': ['.nebula', '.json'] },
          },
        ],
        multiple: false,
      });
      const file = await handle.getFile();
      text = await file.text();
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      console.warn('File System Access API failed, falling back to input:', err);
      text = await loadViaInput();
      if (!text) return null;
    }
  } else {
    text = await loadViaInput();
    if (!text) return null;
  }

  try {
    const parsed = JSON.parse(text) as NebulaFile;

    // Basic validation
    if (parsed.version !== 1) {
      throw new Error(`Unsupported .nebula file version: ${parsed.version}`);
    }
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      throw new Error('Invalid .nebula file: missing nodes or edges arrays');
    }

    return deserializeGraph(parsed);
  } catch (err) {
    console.error('Failed to parse .nebula file:', err);
    alert(`Failed to load graph: ${(err as Error).message}`);
    return null;
  }
}

/** Fallback file picker using a hidden <input> element. */
function loadViaInput(): Promise<string> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.nebula,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve('');
        return;
      }
      const text = await file.text();
      resolve(text);
    };
    // If the user cancels, onchange never fires — resolve empty after timeout
    input.oncancel = () => resolve('');
    input.click();
  });
}
