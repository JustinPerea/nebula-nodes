import type { Edge, Node, Viewport } from '@xyflow/react';
import type { NodeData, NodeState } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { GRAPH_PARAMS_VERSION } from './savedParamsUpgrades';
import { FailureNotice } from './errorCopy';
import type { ProjectSnapshot } from './projects';
import { canonicalBackendAssetUrls } from './backend';

/**
 * The parts of lib/graphFile.ts that startup code uses: the project store
 * normalizes params on every load, and a canvas selection bundle shares the
 * graph bundle's byte limits. graphFile.ts itself (serialize, save, open) is
 * a deferred module loaded at the moment of use (lib/deferredChunks.ts), so
 * these live here, in the startup entry, and graphFile re-exports them.
 * The .nebula writer is here too (serializeGraph, saveBlobWithPicker): a
 * stale tab's unsaved edits that Nebula refused for good are downloaded with
 * it (Q116 a), and that screen shows up when Nebula was updated under the
 * tab, exactly when an old build's deferred chunk may be gone.
 */

const RUNTIME_MEDIA_PARAM_KEYS = [
  'sourceDuration',
  'sourceFps',
  'sourceIsVfr',
] as const;

// JSZip holds source bytes until it emits the bundle. World graphs can include
// several SPZ variants, so bound both one response and the aggregate kept in
// memory. The ceilings comfortably cover ordinary 100K/150K/500K previews,
// panoramas, thumbnails, and collider meshes while preventing an imported
// graph from exhausting the browser with arbitrary assets.
export const GRAPH_BUNDLE_MAX_ASSET_BYTES = 256 * 1024 * 1024;
export const GRAPH_BUNDLE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
export const GRAPH_BUNDLE_MAX_IMPORT_BYTES = GRAPH_BUNDLE_MAX_TOTAL_BYTES + 16 * 1024 * 1024;

// A graph's limits (graphFile.ts re-exports them): the node, wire, depth and
// value counts the shape walk (assertGraphComplexityWithinLimits) allows. Its
// size has no limit of its own: a plain .nebula (Q118) and a bundle's
// graph.json (Q121 a; the backend's RESTORE_MAX_GRAPH_BYTES) both open up to
// GRAPH_BUNDLE_MAX_IMPORT_BYTES, and a graph over the 16 MiB save limit opens
// with saving paused.
export const GRAPH_MAX_NODES = 10_000;
export const GRAPH_MAX_EDGES = 50_000;
export const GRAPH_MAX_DEPTH = 64;
export const GRAPH_MAX_VALUES = 1_000_000;

/** A graph past one of those limits (a written line: the save or load alert
 * puts its own heading over it; error copy round 3e). One error, two fields
 * (GM PR #205 r10 item 4): `reason`, the person's line, worded for where the
 * check ran; `detail`, the engine's exact reason, for the log. */
export class GraphStructureLimitError extends FailureNotice {
  readonly detail: string;

  constructor(reason: string, detail = reason) {
    super('', reason);
    this.name = 'GraphStructureLimitError';
    this.detail = detail;
  }
}

/** Where a shape check ran: a Save, or a file being opened (Load canvas, and
 * whether Load canvas would open a downloaded edits file). */
export type GraphCheckUse = 'save' | 'open';

/** GM PR #205 r9 item 2: the node and connection limits, in the person's
 * words ("edges" is ours). */
export const tooManyNodesLine = (limit: number) => `The canvas has more than ${limit.toLocaleString()} nodes.`;
export const tooManyEdgesLine = (limit: number) => `The canvas has more than ${limit.toLocaleString()} connections.`;

/** GM PR #205 r10 item 4 and its addendum: the shape walk's reasons, which
 * the person can't act on, as a cause they understand. Too many values or
 * too deep: `complex`; a non-finite number or a circular value: `value`.
 * A Save can be undone into shape; a file can't be fixed in Nebula, so its
 * lines have no step. */
const SHAPE_LINES: Record<GraphCheckUse, Record<'complex' | 'value', string>> = {
  save: {
    complex: 'It’s too complex to save. Undo your last change, then try again.',
    value: 'Part of it holds a value Nebula can’t save. Undo your last change, then try again.',
  },
  open: {
    complex: 'This file is too complex to open.',
    value: 'Part of this file holds a value Nebula can’t read.',
  },
};

/** True when JSON.stringify failed because the text is longer than the engine
 * lets a string be (#190). Chromium (V8, the desktop app's engine too) caps a
 * string at 2^29 - 24 = 536,870,888 characters, 24 short of 512 MiB, and
 * throws RangeError("Invalid string length"); Nebula opens a graph.json up to
 * GRAPH_BUNDLE_MAX_IMPORT_BYTES (528 MiB), so a graph between the two can't be
 * written here at all. The other RangeError stringify can throw (a stack
 * overflow) is not this. Save graph (lib/graphFile.ts) and the two downloads
 * below read it. */
export function isStringLengthLimit(error: unknown): boolean {
  return error instanceof RangeError && !/call stack/i.test(error.message);
}

/** GM - Design, 2026-10-25: the line under "Couldn't download your edits." and
 * "Couldn't download a copy." for that case. It matches Save graph's "It's too
 * big to save in a browser.", so the two read as a pair with only the verb
 * changed. */
export const TOO_BIG_TO_DOWNLOAD = "It's too big to download in a browser.";

/** A download whose .nebula text is past the browser's string cap. */
export class BrowserStringLimitError extends GraphStructureLimitError {
  constructor() {
    super(TOO_BIG_TO_DOWNLOAD);
    this.name = 'BrowserStringLimitError';
  }
}

/** The download's text, or BrowserStringLimitError past the string cap. */
function downloadText(file: NebulaFile): string {
  try {
    return JSON.stringify(file);
  } catch (error) {
    if (isStringLengthLimit(error)) throw new BrowserStringLimitError();
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function* jsonChildValues(value: object): Generator<unknown> {
  if (Array.isArray(value)) {
    // JSON.stringify materializes sparse slots as null, so count every index.
    for (let index = 0; index < value.length; index += 1) yield value[index];
    return;
  }
  for (const key in value as Record<string, unknown>) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      yield (value as Record<string, unknown>)[key];
    }
  }
}

/** Match the backend restore preflight without recursive JavaScript calls.
 * The enter/exit frames preserve JSON-tree depth semantics and reject cycles
 * in live state before JSON.stringify can throw after expensive asset work. */
export function assertGraphComplexityWithinLimits(value: unknown, use: GraphCheckUse): void {
  const refuse = (kind: 'complex' | 'value', detail: string) => new GraphStructureLimitError(SHAPE_LINES[use][kind], detail);
  if (isRecord(value)) {
    if (Array.isArray(value.nodes) && value.nodes.length > GRAPH_MAX_NODES) {
      throw new GraphStructureLimitError(tooManyNodesLine(GRAPH_MAX_NODES), `Graph contains more than ${GRAPH_MAX_NODES.toLocaleString()} nodes.`);
    }
    if (Array.isArray(value.edges) && value.edges.length > GRAPH_MAX_EDGES) {
      throw new GraphStructureLimitError(tooManyEdgesLine(GRAPH_MAX_EDGES), `Graph contains more than ${GRAPH_MAX_EDGES.toLocaleString()} edges.`);
    }
  }

  type Frame =
    | { kind: 'value'; value: unknown; depth: number }
    | { kind: 'children'; iterator: Iterator<unknown>; depth: number }
    | { kind: 'exit'; value: object };
  const stack: Frame[] = [{ kind: 'value', value, depth: 0 }];
  const ancestors = new WeakSet<object>();
  let valueCount = 0;

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    if (frame.kind === 'exit') {
      ancestors.delete(frame.value);
      continue;
    }
    if (frame.kind === 'children') {
      const child = frame.iterator.next();
      if (!child.done) {
        // Resume this iterator after validating one child. Keeping iterators
        // rather than pushing every sibling bounds traversal memory by depth,
        // including for a sparse or million-value live array.
        stack.push(frame);
        stack.push({ kind: 'value', value: child.value, depth: frame.depth });
      }
      continue;
    }

    const current = frame.value;
    valueCount += 1;
    if (valueCount > GRAPH_MAX_VALUES) {
      throw refuse('complex', `Graph contains more than ${GRAPH_MAX_VALUES.toLocaleString()} values.`);
    }
    if (frame.depth > GRAPH_MAX_DEPTH) {
      throw refuse('complex', `Graph is nested more than ${GRAPH_MAX_DEPTH} levels deep.`);
    }
    if (typeof current === 'number' && !Number.isFinite(current)) {
      throw refuse('value', 'Graph contains a non-finite number.');
    }
    if (!current || typeof current !== 'object') continue;
    if (ancestors.has(current)) {
      throw refuse('value', 'Graph contains a circular value that cannot be saved.');
    }

    ancestors.add(current);
    stack.push({ kind: 'exit', value: current });
    stack.push({
      kind: 'children',
      iterator: jsonChildValues(current),
      depth: frame.depth + 1,
    });
  }
}

/**
 * Media probing used to write runtime metadata into every video-producing
 * node as if it were a provider parameter. Those keys are valid editor state
 * on video-edit, but are not part of provider schemas and therefore made a
 * freshly saved bundle fail strict import validation.
 *
 * Keep declared keys untouched and migrate only undeclared runtime metadata
 * to the private namespace already accepted by the graph API. Running this on
 * both save and load makes future bundles clean and keeps legacy v1-v3 files
 * loadable without weakening backend validation for arbitrary unknown params.
 */
export function normalizeRuntimeMediaParams(
  definitionId: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const definition = NODE_DEFINITIONS[definitionId];
  const declared = new Set(definition?.params.map((param) => param.key) ?? []);
  const normalized = { ...params };

  for (const key of RUNTIME_MEDIA_PARAM_KEYS) {
    if (declared.has(key) || !(key in normalized)) continue;
    const privateKey = `_${key}`;
    if (!(privateKey in normalized)) normalized[privateKey] = normalized[key];
    delete normalized[key];
  }

  return normalized;
}

export interface NebulaFile {
  version: 1 | 2 | 3;
  /** See GRAPH_PARAMS_VERSION. Missing in files saved before 2026-10-17. */
  paramsVersion?: number;
  name: string;
  createdAt: string;
  nodes: NebulaNode[];
  edges: NebulaEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

export interface NebulaNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: {
    label: string;
    definitionId: string;
    params: Record<string, unknown>;
    outputs?: NodeData['outputs'];
    state?: NodeState;
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
    paramsVersion: GRAPH_PARAMS_VERSION,
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
          // The relative asset links the backend gave, not the ones shown.
          params: canonicalBackendAssetUrls(normalizeRuntimeMediaParams(n.data.definitionId, n.data.params)),
          outputs: hasOutputs ? canonicalBackendAssetUrls({ ...n.data.outputs }) : undefined,
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
      data: e.data ? canonicalBackendAssetUrls({ ...(e.data as Record<string, unknown>) }) : undefined,
    })),
    viewport: viewport
      ? { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
      : undefined,
  };
}

/** What a save picker offers: its label and the type and extensions it saves. */
export interface SaveFileType {
  description: string;
  accept: Record<string, string[]>;
}

/**
 * Save `blob` as a file: through the save picker where there is one (Chrome,
 * Edge, the desktop app), which says when the person cancelled, else as a
 * download. Resolves to the file's name (the one the person chose in the
 * picker) or null when they cancelled. A plain download can't report a
 * cancel or where the file went: it resolves to `suggestedName`.
 *
 * A picker that fails before a file was chosen falls back to the plain
 * download. With `reportWriteFailure`, a write that fails after the person
 * chose the file (a full disk, say) rejects instead, after discarding the
 * partial file: the unsaved edits' download (Q116 a, GM's line 2) must say
 * the file wasn't written, and a plain download in its place could fail just
 * as silently while the screen said the edits were saved.
 */
export async function saveBlobWithPicker(blob: Blob, suggestedName: string, type: SaveFileType,
  options: { reportWriteFailure?: boolean } = {}): Promise<string | null> {
  if ('showSaveFilePicker' in window) {
    let writable: FileSystemWritableFileStream | null = null;
    try {
      const handle = await (window as unknown as {
        showSaveFilePicker: (opts: { suggestedName: string; types: SaveFileType[] }) => Promise<FileSystemFileHandle>;
      }).showSaveFilePicker({ suggestedName, types: [type] });
      try {
        writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } catch (err) {
        if (!options.reportWriteFailure) throw err;
        await writable?.abort().catch(() => {});
        throw new SaveFileWriteError(err);
      }
      return handle.name || suggestedName;
    } catch (err) {
      if (err instanceof SaveFileWriteError) throw err.cause;
      if ((err as DOMException).name === 'AbortError') return null;
      console.warn('File System Access API failed, falling back to download:', err);
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  try {
    document.body.appendChild(a);
    a.click();
  } finally {
    a.remove();
    // Match World asset downloads: allow the browser to consume the URL
    // before releasing its backing Blob, including asynchronous WebViews.
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
  return suggestedName;
}

/** A write that failed after the person chose the file (saveBlobWithPicker's
 * `reportWriteFailure`); `cause` is the browser's own error. */
class SaveFileWriteError extends Error {
  constructor(cause: unknown) { super("Couldn't write the file.", { cause }); this.name = 'SaveFileWriteError'; }
}

/** Characters no file name may hold on macOS, Windows or Linux. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_NAME = /[\u0000-\u001f\u007f/\\:*?"<>|]+/g;
const FILE_NAME_MAX = 80;

/** The unsaved edits file's name (Q116 a): the project's name made safe for a
 * file name, then " - unsaved edits.nebula". */
export function editsFileName(projectName: string): string {
  const safe = projectName.normalize('NFC').replace(UNSAFE_FILE_NAME, ' ').replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '').slice(0, FILE_NAME_MAX).replace(/[.\s]+$/, '');
  return `${safe || 'Untitled project'} - unsaved edits.nebula`;
}

/** A held recovered copy as a .nebula file: the graph file writer's own
 * format (serializeGraph, version 2 JSON), which Load graph opens. It holds
 * the canvas (nodes, wires, params, outputs, the view); a .nebula file has no
 * run history or Create draft, so those stay out. Written compact, as the
 * backend measured the copy, so the size the backend reports is the file's. */
export function editsFileText(snapshot: Pick<ProjectSnapshot, 'nodes' | 'edges' | 'viewport'>, projectName: string): string {
  return JSON.stringify(editsFile(snapshot, projectName));
}

function editsFile(snapshot: Pick<ProjectSnapshot, 'nodes' | 'edges' | 'viewport'>, projectName: string): NebulaFile {
  return serializeGraph(snapshot.nodes, snapshot.edges, snapshot.viewport ?? undefined, projectName);
}

/** Whether Load graph opens this edits file: within its file ceiling and its
 * shape walk's limits, checked the way the reader checks a plain .nebula
 * (inspectGraphFileWithinLimit, then the walk over the parsed file). The
 * backend refuses a recovered copy past its own versions of those limits
 * (413), so a held copy can be one Load graph won't open (Q116 a review).
 * Since Q118 a copy over the 16 MiB save limit opens (and the canvas pauses
 * saving it), so size alone fails only past the bundle ceiling.
 * `file` is `text` parsed, the form the reader walks. */
export function editsFileReopens(text: string, file: unknown): boolean {
  if (new Blob([text]).size > GRAPH_BUNDLE_MAX_IMPORT_BYTES) return false;
  try {
    assertGraphComplexityWithinLimits(file, 'open');
    return true;
  } catch (error) {
    if (error instanceof GraphStructureLimitError) return false;
    throw error;
  }
}

/** Where a held recovered copy went: the saved file's name (the person may
 * rename it in the save picker), and whether Load graph will open it. */
export interface SavedEditsFile { name: string; reopens: boolean }

/** Download a held recovered copy (Q116 a "Download your edits"). The file is
 * written whatever its size, so nothing is lost; `reopens` says whether Load
 * graph can open it. Resolves to null when the person cancelled the save
 * picker; rejects when the file couldn't be written. */
export async function saveEditsToFile(snapshot: Pick<ProjectSnapshot, 'nodes' | 'edges' | 'viewport'>,
  projectName: string): Promise<SavedEditsFile | null> {
  return writeGraphText(downloadText(editsFile(snapshot, projectName)), editsFileName(projectName));
}

/** "Download a copy" in the over-the-limit panel (Q118): the whole open
 * project's canvas as a plain .nebula, "{project}.nebula", the same writer and
 * format as the edits download, so Load graph opens it again. A .nebula holds
 * no run history or Create draft. */
export async function saveProjectCopyToFile(snapshot: Pick<ProjectSnapshot, 'nodes' | 'edges' | 'viewport'>,
  projectName: string): Promise<SavedEditsFile | null> {
  return writeGraphText(downloadText(editsFile(snapshot, projectName)), projectFileName(projectName));
}

/** The project's name made safe for a file name, then ".nebula". */
export function projectFileName(projectName: string): string {
  return editsFileName(projectName).replace(/ - unsaved edits\.nebula$/, '.nebula');
}

async function writeGraphText(text: string, suggestedName: string): Promise<SavedEditsFile | null> {
  // Parsed only when the size allows a reopen at all.
  const reopens = new Blob([text]).size <= GRAPH_BUNDLE_MAX_IMPORT_BYTES && editsFileReopens(text, JSON.parse(text));
  const blob = new Blob([text], { type: 'application/json' });
  const name = await saveBlobWithPicker(blob, suggestedName,
    { description: 'Nebula Node Graph', accept: { 'application/json': ['.nebula'] } }, { reportWriteFailure: true });
  return name === null ? null : { name, reopens };
}
