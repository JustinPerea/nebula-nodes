import JSZip from 'jszip';
import type { Node, Edge, Viewport } from '@xyflow/react';
import type { DynamicNodeData, NodeData } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { shotPortId } from '../constants/ports';
import { backendAssetUrlSync, canonicalBackendAssetUrls, getCachedBackendBaseUrl } from './backend';
import { AssetByteLimitError, readBoundedAssetResponse } from './boundedAsset';
import { apiRequest } from './apiRequest';
import { FailureNotice, failureMessage, oneLine } from './errorCopy';
import { showNotice } from './canvasNotice';
import {
  hasRepresentationViewer,
  parseRepresentation,
} from './representationViewerRegistry';
import { isSafeWorldUrl } from './worldValue';
import { GRAPH_PARAMS_VERSION } from './savedParamsUpgrades';
import {
  GRAPH_BUNDLE_MAX_ASSET_BYTES,
  GRAPH_BUNDLE_MAX_IMPORT_BYTES,
  GRAPH_BUNDLE_MAX_TOTAL_BYTES,
  GRAPH_MAX_DEPTH,
  GRAPH_MAX_EDGES,
  GRAPH_MAX_NODES,
  GRAPH_MAX_VALUES,
  GraphStructureLimitError,
  assertGraphComplexityWithinLimits,
  normalizeRuntimeMediaParams,
  projectFileName,
  saveBlobWithPicker,
  serializeGraph,
  type NebulaFile,
  type NebulaNode,
} from './graphFileShared';

/** The Toolbar's "Save graph" / "Load graph", as GM's headings (round 2). */
const SAVE_GRAPH = "Couldn't save the graph.";
const LOAD_GRAPH = "Couldn't load the graph.";

/**
 * .nebula.zip / .nebula file format — graph persistence.
 *
 * v3 (current): zip bundle containing `graph.json` plus every referenced
 * asset under `assets/<original-relative-path>`. Self-contained — the file
 * survives the backend purging output/ or being moved to another machine.
 * On load the frontend uploads the untouched zip to POST /api/outputs/restore.
 * The backend bounds and validates graph.json before atomically extracting
 * assets, then returns the validated graph and a URL mapping. The browser
 * never inflates an attacker-controlled ZIP.
 *
 * v2: plain JSON with URL references to output/. Still loadable (backward-
 * compat path) — just shows broken images if the referenced files are gone.
 * v1: structure + params only, no outputs.
 */

/**
 * GRAPH_PARAMS_VERSION: one-time param upgrades a graph file has had (backend
 * services/saved_graph_upgrades.py PARAMS_VERSION; defined in
 * savedParamsUpgrades.ts, and a backend test keeps the two equal). Files
 * written now carry it; a file without it is version 0, and
 * POST /api/graph/import upgrades its params once when it loads.
 */
export { GRAPH_PARAMS_VERSION };
// Shared with startup code (lib/graphFileShared.ts); re-exported for this module's callers.
export { GRAPH_BUNDLE_MAX_ASSET_BYTES, GRAPH_BUNDLE_MAX_IMPORT_BYTES, GRAPH_BUNDLE_MAX_TOTAL_BYTES, normalizeRuntimeMediaParams };
// The .nebula writer lives in the startup entry (graphFileShared) so a held
// recovered copy can be downloaded even when this chunk can't load (Q116 a).
export { serializeGraph };
export type { NebulaFile };
// Load graph's limits and its shape walk live there too, so the unsaved
// edits download can tell whether Load graph will open its file
// (editsFileReopens), from the same numbers (Q116 a review).
export {
  GRAPH_MAX_DEPTH, GRAPH_MAX_EDGES, GRAPH_MAX_NODES, GRAPH_MAX_VALUES,
  GraphStructureLimitError, assertGraphComplexityWithinLimits,
};


export const GRAPH_BUNDLE_MAX_MEMBERS = 4096;
export const GRAPH_BUNDLE_MAX_ASSET_MEMBERS = GRAPH_BUNDLE_MAX_MEMBERS - 1; // graph.json

export interface GraphBundleAssetLimits {
  maxAssetBytes: number;
  maxTotalBytes: number;
  maxAssetMembers?: number;
}

export interface GraphBundleAssetSummary {
  included: number;
  skipped: number;
  totalBytes: number;
}

/** GM, round 3f: "Graph saved without {n} of its files. They may be missing
 * when the graph is opened somewhere else." (singular: "without 1 of its
 * files. It may be missing…"). */
export function skippedFilesLine(skipped: number): string {
  return skipped === 1
    ? 'Graph saved without 1 of its files. It may be missing when the graph is opened somewhere else.'
    : `Graph saved without ${skipped} of its files. They may be missing when the graph is opened somewhere else.`;
}

/** GM, round 3f: "This graph is {n} MB. Nebula opens graphs up to {m} MB."
 * (the same pattern for the JSON and the finished bundle). */
export function graphSizeLine(bytes: number, limitBytes: number): string {
  return `This graph is ${(bytes / (1024 * 1024)).toFixed(1)} MB. `
    + `Nebula opens graphs up to ${Math.floor(limitBytes / (1024 * 1024))} MB.`;
}

function warnAboutSkippedBundleAssets(summary: GraphBundleAssetSummary): void {
  if (summary.skipped === 0) return;
  showNotice(skippedFilesLine(summary.skipped), 'info');
}

// Error copy round 3e (GM): the file's own size and shape limits are written
// lines (FailureNotice with no heading: the save or load alert puts its own
// heading over them). A file that fails its shape checks reads one written
// line; the check's text ("nodes[0] must be an object") is `detail`, for the
// console.
export class GraphBundleImportTooLargeError extends FailureNotice {
  constructor(reason: string) {
    super('', reason);
    this.name = 'GraphBundleImportTooLargeError';
  }
}

const GRAPH_FILE_DAMAGED_COPY = "This file is damaged or isn't a Nebula graph.";
const GRAPH_FILE_NEWER_COPY = 'This file is from a newer Nebula. Update Nebula, then open it again.';

export class GraphFileInvalidError extends FailureNotice {
  readonly detail: string;

  constructor(detail: string, reason = GRAPH_FILE_DAMAGED_COPY) {
    super('', reason);
    this.name = 'GraphFileInvalidError';
    this.detail = detail;
  }
}

export interface GraphFileSelection {
  file: Blob;
  isZip: boolean;
  /** The picked file's name, for the canvas's line after it opens (Q118). */
  name?: string;
}

/** Inspect only four signature bytes, retaining ZIPs as Blobs so fetch can
 * stream them to the backend without first duplicating the whole selection in
 * JavaScript memory. A plain JSON file is read up to the same ceiling as a
 * bundle (Q118, Justin: "Let Load graph open bigger .nebula files (up to the
 * 512 MiB it already allows for a bundle)"); one over the 16 MiB save limit
 * opens, and the canvas pauses saving until it is trimmed. A bundle's graph
 * opens the same way (Q121 a). The shape walk's
 * limits still apply once it is parsed. */
export async function inspectGraphFileWithinLimit(file: Blob): Promise<GraphFileSelection> {
  if (file.size > GRAPH_BUNDLE_MAX_IMPORT_BYTES) {
    throw new GraphBundleImportTooLargeError(graphSizeLine(file.size, GRAPH_BUNDLE_MAX_IMPORT_BYTES));
  }
  const signature = await file.slice(0, 4).arrayBuffer();
  const isZip = isZipBuffer(signature);
  const name = typeof File !== 'undefined' && file instanceof File && file.name ? file.name : undefined;
  return name === undefined ? { file, isZip } : { file, isZip, name };
}


/**
 * Deserialize a .nebula file back into React Flow nodes and edges.
 * Validates that node definitions exist. Unknown nodes get a warning but are still loaded.
 * State is always reset to 'idle', outputs are empty.
 */
export function deserializeGraph(
  file: NebulaFile,
): { nodes: Node<NodeData>[]; edges: Edge[]; viewport?: Viewport; paramsVersion: number; warnings: string[] } {
  const warnings: string[] = [];

  const nodes: Node<NodeData>[] = file.nodes.map((n) => {
    const definition = NODE_DEFINITIONS[n.data.definitionId];
    if (!definition) {
      warnings.push(`Unknown node definition: "${n.data.definitionId}" (node ${n.id})`);
    }
    const outputs = (n.data.outputs ?? {}) as NodeData['outputs'];
    const hasOutputs = Object.keys(outputs).length > 0;
    // v2+: trust saved state (complete if outputs present). v1: always idle, no outputs.
    const state = hasOutputs ? (n.data.state ?? 'complete') : 'idle';
    const params = normalizeRuntimeMediaParams(n.data.definitionId, n.data.params);
    const data: NodeData = {
      label: n.data.label,
      definitionId: n.data.definitionId,
      params,
      state,
      outputs,
    };
    if (n.data.definitionId === 'cinema-scene') {
      // These handles are derived from the saved shot identities, not runtime
      // metadata. Restore them so visible shots can be wired after import.
      const scene = params.scene as { shots?: unknown } | null | undefined;
      const shots = Array.isArray(scene?.shots) ? scene.shots : [];
      const dynamic: Partial<DynamicNodeData> = {
        isDynamic: true,
        providerType: 'fal', // inert for the custom Cinema node
        dynamicInputPorts: definition?.inputPorts ?? [],
        dynamicOutputPorts: shots.flatMap((shot: unknown, index: number) => {
          if (!shot || typeof shot !== 'object' || !('id' in shot)
            || typeof shot.id !== 'string' || !shot.id) return [];
          return [{ id: shotPortId(shot.id), label: `Shot ${index + 1}`,
            dataType: 'Image', required: false }];
        }),
        dynamicParams: [],
        providerMeta: {},
      };
      Object.assign(data, dynamic);
    }
    return {
      id: n.id,
      type: n.data.definitionId === 'batch' ? 'batchNode' : n.type,
      position: n.position,
      data,
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

  return { nodes, edges, viewport, paramsVersion: file.paramsVersion ?? 0, warnings };
}

const OUTPUTS_PREFIX = '/api/outputs/';
const OUTPUTS_ROOT = OUTPUTS_PREFIX.slice(0, -1);
const PORTABLE_COMPONENT_FORBIDDEN = /[<>:"|?#*\\]/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const PROTOTYPE_COMPONENTS = new Set(['__proto__', 'prototype', 'constructor']);

function containsControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function prototypeCollisionKey(value: string): string {
  // These are the non-ASCII folds that can spell one of the ASCII prototype
  // keys. Mirror Python casefold closely enough to keep frontend-created ZIP
  // members inside the backend's portability policy.
  return value.toLocaleLowerCase('en-US')
    .replaceAll('\u017f', 's')
    .replaceAll('\ufb05', 'st')
    .replaceAll('\ufb06', 'st');
}

type LocalOutputReference =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'valid'; relativePath: string; requestUrl: string };

/** Canonical ASCII archive/mapping key for one portable output-relative path.
 * Percent decoding happens before validation, then each NFC component is
 * encoded exactly once. This makes raw Unicode and percent-encoded legacy
 * bundle keys compare identically without letting encoded separators or dot
 * segments change meaning in a browser URL parser. */
function canonicalPortableOutputRelativePath(raw: string): string | null {
  if (!raw || raw.startsWith('/') || raw.endsWith('/') || raw.includes('\\')) return null;
  const rawParts = raw.split('/');
  if (rawParts.some((part) => !part)) return null;

  const canonicalParts: string[] = [];
  for (const rawPart of rawParts) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawPart).normalize('NFC');
    } catch {
      return null;
    }
    if (
      !decoded
      || decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || containsControlCharacters(decoded)
      || PORTABLE_COMPONENT_FORBIDDEN.test(decoded)
      || decoded.endsWith(' ')
      || decoded.endsWith('.')
      || WINDOWS_DEVICE_NAME.test(decoded)
      || PROTOTYPE_COMPONENTS.has(prototypeCollisionKey(decoded))
    ) return null;

    // URL and server stacks sometimes perform more than one decoding pass.
    // Probe nested encodings for separators, dot traversal, controls, and
    // non-portable names while retaining the once-encoded archive identity.
    let probe = decoded;
    for (let decodePass = 0; decodePass < 4 && probe.includes('%'); decodePass += 1) {
      let next: string;
      try {
        next = decodeURIComponent(probe).normalize('NFC');
      } catch {
        return null;
      }
      if (next === probe) break;
      if (
        !next
        || next === '.'
        || next === '..'
        || next.includes('/')
        || next.includes('\\')
        || containsControlCharacters(next)
        || PORTABLE_COMPONENT_FORBIDDEN.test(next)
        || next.endsWith(' ')
        || next.endsWith('.')
        || WINDOWS_DEVICE_NAME.test(next)
        || PROTOTYPE_COMPONENTS.has(prototypeCollisionKey(next))
      ) return null;
      probe = next;
    }
    if (probe.includes('%')) return null;

    let encoded: string;
    try {
      encoded = encodeURIComponent(decoded);
    } catch {
      // Lone UTF-16 surrogates are representable in live JavaScript strings,
      // but not in a UTF-8 ZIP member or browser URL.
      return null;
    }
    if (new TextEncoder().encode(encoded).byteLength > 255) return null;
    canonicalParts.push(encoded);
  }

  const canonical = canonicalParts.join('/');
  return new TextEncoder().encode(canonical).byteLength <= 1024 ? canonical : null;
}

function rawAbsolutePath(value: string): string {
  const schemeEnd = value.indexOf('://');
  if (schemeEnd < 0) return '';
  const pathStart = value.indexOf('/', schemeEnd + 3);
  if (pathStart < 0) return '';
  const queryStart = value.indexOf('?', pathStart);
  const hashStart = value.indexOf('#', pathStart);
  const endings = [queryStart, hashStart].filter((index) => index >= 0);
  const pathEnd = endings.length > 0 ? Math.min(...endings) : value.length;
  return value.slice(pathStart, pathEnd);
}

function isCurrentBackendOrigin(url: URL): boolean {
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return true;
  if (typeof window === 'undefined') return false;
  const cachedBaseUrl = getCachedBackendBaseUrl();
  try {
    const backendOrigin = new URL(cachedBaseUrl || window.location.origin, window.location.origin).origin;
    return url.origin === backendOrigin;
  } catch {
    return false;
  }
}

/** Classify non-canonical spellings before rejecting them. Browsers normalize
 * backslashes for special URL schemes and servers may decode escaped slashes,
 * so a local output URL must not evade remapping merely by spelling its prefix
 * ambiguously. This helper is only a detector; accepted paths still require
 * the exact OUTPUTS_PREFIX and component-level canonicalization below. */
function resemblesLocalOutputPath(raw: string): boolean {
  let probe = raw.replaceAll('\\', '/');
  for (let decodePass = 0; decodePass <= 4; decodePass += 1) {
    if (probe === OUTPUTS_ROOT || probe.startsWith(OUTPUTS_PREFIX)) return true;
    if (!probe.includes('%')) return false;
    // Decode valid ASCII escapes tolerantly for classification. A malformed
    // escape later in the filename must not hide an encoded `/api/outputs/`
    // prefix and make a local reference look external.
    const decoded = probe.replace(/%([0-7][0-9a-f])/gi, (_match, hex: string) => (
      String.fromCharCode(Number.parseInt(hex, 16))
    ));
    if (decoded === probe) return false;
    probe = decoded.replaceAll('\\', '/');
  }
  return false;
}

/** Parse the only local-output reference shape eligible for bundling/remap. */
function parseLocalOutputReference(value: string): LocalOutputReference {
  let rawPath = '';
  let candidate = false;
  let absolute: URL | null = null;

  if (value.startsWith(OUTPUTS_PREFIX)) {
    candidate = true;
    rawPath = value.split(/[?#]/, 1)[0];
  } else if (value.startsWith('/') && resemblesLocalOutputPath(value.split(/[?#]/, 1)[0])) {
    return { kind: 'invalid' };
  } else {
    try {
      const schemeRelative = value.startsWith('//') || value.startsWith('\\\\');
      absolute = schemeRelative && typeof window !== 'undefined'
        ? new URL(value, window.location.origin)
        : new URL(value);
      rawPath = rawAbsolutePath(value);
      candidate = isCurrentBackendOrigin(absolute)
        && (resemblesLocalOutputPath(rawPath) || resemblesLocalOutputPath(absolute.pathname));
    } catch {
      return { kind: 'none' };
    }
  }

  if (!candidate) return { kind: 'none' };
  if (
    !rawPath.startsWith(OUTPUTS_PREFIX)
    || value !== value.trim()
    || containsControlCharacters(value)
    || value.includes('\\')
  ) return { kind: 'invalid' };

  if (absolute) {
    if (
      (absolute.protocol !== 'http:' && absolute.protocol !== 'https:')
      || absolute.username
      || absolute.password
      || absolute.search
      || absolute.hash
    ) return { kind: 'invalid' };
  } else if (value.includes('?') || value.includes('#')) {
    return { kind: 'invalid' };
  }

  const relativePath = canonicalPortableOutputRelativePath(rawPath.slice(OUTPUTS_PREFIX.length));
  if (!relativePath) return { kind: 'invalid' };
  return {
    kind: 'valid',
    relativePath,
    requestUrl: backendAssetUrlSync(`${OUTPUTS_PREFIX}${relativePath}`),
  };
}

function portablePathCollisionKey(canonicalPath: string): string {
  return canonicalPath
    .split('/')
    .map((part) => decodeURIComponent(part)
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .replaceAll('ß', 'ss')
      .replaceAll('ς', 'σ'))
    .join('/');
}

interface CollectedAssetPaths {
  paths: Map<string, string>;
  invalidReferenceSamples: Set<string>;
  invalidReferenceCount: number;
  excessReferenceCount: number;
}

/** Walk the already complexity-bounded graph and collect canonical local assets. */
function collectAssetPaths(file: NebulaFile, maxPaths: number): CollectedAssetPaths {
  const paths = new Map<string, string>();
  const collisionPaths = new Map<string, string>();
  const invalidReferenceSamples = new Set<string>();
  let invalidReferenceCount = 0;
  let excessReferenceCount = 0;

  const recordInvalid = (value: string) => {
    invalidReferenceCount += 1;
    if (invalidReferenceSamples.size < 20) invalidReferenceSamples.add(value);
  };

  const record = (value: unknown) => {
    if (typeof value !== 'string') return;
    const parsed = parseLocalOutputReference(value);
    if (parsed.kind === 'invalid') {
      recordInvalid(value);
    } else if (parsed.kind === 'valid' && !paths.has(parsed.relativePath)) {
      const collisionKey = portablePathCollisionKey(parsed.relativePath);
      const existingPath = collisionPaths.get(collisionKey);
      if (existingPath && existingPath !== parsed.relativePath) {
        recordInvalid(value);
      } else if (paths.size >= maxPaths) {
        excessReferenceCount += 1;
      } else {
        collisionPaths.set(collisionKey, parsed.relativePath);
        paths.set(parsed.relativePath, parsed.requestUrl);
      }
    }
  };

  const walk = (value: unknown) => {
    if (value == null) return;
    if (typeof value === 'string') return record(value);
    if (Array.isArray(value)) return value.forEach(walk);
    if (typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(walk);
  };

  for (const node of file.nodes) {
    if (node.data.outputs) walk(node.data.outputs);
    if (node.data.params) walk(node.data.params);
  }
  return {
    paths,
    invalidReferenceSamples,
    invalidReferenceCount,
    excessReferenceCount,
  };
}

/** Add local graph assets sequentially so several large World variants are
 * never resident as in-flight response buffers at the same time. */
export async function addGraphAssetsToBundle(
  zip: JSZip,
  file: NebulaFile,
  limits: GraphBundleAssetLimits = {
    maxAssetBytes: GRAPH_BUNDLE_MAX_ASSET_BYTES,
    maxTotalBytes: GRAPH_BUNDLE_MAX_TOTAL_BYTES,
  },
): Promise<GraphBundleAssetSummary> {
  const summary: GraphBundleAssetSummary = { included: 0, skipped: 0, totalBytes: 0 };
  const maxAssetBytes = Math.max(0, Math.min(
    GRAPH_BUNDLE_MAX_ASSET_BYTES,
    Number.isSafeInteger(limits.maxAssetBytes) ? limits.maxAssetBytes : 0,
  ));
  const maxTotalBytes = Math.max(0, Math.min(
    GRAPH_BUNDLE_MAX_TOTAL_BYTES,
    Number.isSafeInteger(limits.maxTotalBytes) ? limits.maxTotalBytes : 0,
  ));
  const maxAssetMembers = Math.max(0, Math.min(
    GRAPH_BUNDLE_MAX_ASSET_MEMBERS,
    Number.isSafeInteger(limits.maxAssetMembers)
      ? (limits.maxAssetMembers as number)
      : GRAPH_BUNDLE_MAX_ASSET_MEMBERS,
  ));
  const collected = collectAssetPaths(file, maxAssetMembers);

  for (const invalid of collected.invalidReferenceSamples) {
    console.warn(`[save] rejected unsafe output asset reference: ${invalid}`);
  }
  if (collected.invalidReferenceCount > collected.invalidReferenceSamples.size) {
    console.warn(
      `[save] rejected ${collected.invalidReferenceCount - collected.invalidReferenceSamples.size} `
      + 'additional unsafe output asset references',
    );
  }
  if (collected.excessReferenceCount > 0) {
    console.warn(
      `[save] graph bundle member ceiling reached; skipping ${collected.excessReferenceCount} asset references`,
    );
  }
  summary.skipped += collected.invalidReferenceCount + collected.excessReferenceCount;

  for (const [rel, url] of collected.paths) {
    const remainingBytes = maxTotalBytes - summary.totalBytes;
    if (remainingBytes <= 0) {
      console.warn(`[save] graph bundle byte ceiling reached; skipping ${url}`);
      summary.skipped += 1;
      continue;
    }

    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        console.warn(`[save] ${url} → HTTP ${response.status}, skipping`);
        summary.skipped += 1;
        continue;
      }
      const bytes = await readBoundedAssetResponse(
        response,
        Math.min(maxAssetBytes, remainingBytes),
      );
      // Do not create explicit directory entries. One graph.json plus at most
      // 4095 asset files then stays within the backend's 4096-member ceiling.
      zip.file(`assets/${rel}`, bytes, { createFolders: false });
      summary.included += 1;
      summary.totalBytes += bytes.byteLength;
    } catch (error) {
      const reason = error instanceof AssetByteLimitError
        ? error.message
        : error instanceof Error
          ? error.message
          : 'unknown fetch failure';
      console.warn(`[save] failed to include ${url}: ${reason}`);
      summary.skipped += 1;
    }
  }

  return summary;
}

/**
 * Save the graph as a `.nebula.zip` bundle: graph.json plus every referenced
 * asset under assets/. Self-contained and portable — the file reloads cleanly
 * even after output/ is purged or on a fresh checkout.
 *
 * Fetch errors (vanished asset between Save click and fetch) are logged and
 * the asset is skipped; the rest of the bundle still saves. On load, omitted
 * local references are explicitly marked unavailable instead of silently
 * rebinding to a same-named file on the destination backend.
 */
export async function saveToFile(
  nodes: Node<NodeData>[],
  edges: Edge[],
  viewport?: Viewport,
  projectName?: string,
): Promise<GraphBundleAssetSummary | null> {
  let file: NebulaFile;
  let graphJson: string;
  try {
    if (nodes.length > GRAPH_MAX_NODES) {
      throw new GraphStructureLimitError(`Graph contains more than ${GRAPH_MAX_NODES.toLocaleString()} nodes.`);
    }
    if (edges.length > GRAPH_MAX_EDGES) {
      throw new GraphStructureLimitError(`Graph contains more than ${GRAPH_MAX_EDGES.toLocaleString()} edges.`);
    }
    file = serializeGraph(nodes, edges, viewport, projectName);
    file.version = 3;
    assertGraphComplexityWithinLimits(file);
    graphJson = JSON.stringify(file, null, 2);
    // Q121 a: a graph over the 16 MiB save limit still saves as a bundle; one
    // past the bundle's ceiling never fits, so it's refused before any asset
    // is fetched.
    const graphBytes = new TextEncoder().encode(graphJson).byteLength;
    if (graphBytes > GRAPH_BUNDLE_MAX_IMPORT_BYTES) {
      throw new GraphStructureLimitError(graphSizeLine(graphBytes, GRAPH_BUNDLE_MAX_IMPORT_BYTES));
    }
  } catch (error) {
    console.error('[nebula] graph save', error);
    showNotice(failureMessage(error, SAVE_GRAPH));
    return null;
  }

  const zip = new JSZip();
  zip.file('graph.json', graphJson, { createFolders: false });

  const assetSummary = await addGraphAssetsToBundle(zip, file);

  let blob: Blob;
  try {
    // Store bytes verbatim. Assets such as SPZ are already compressed, and
    // DEFLATE could turn a repetitive but valid graph.json into a >250:1 ZIP
    // that the restore endpoint must reject as a compression bomb. STORE keeps
    // every frontend-produced bundle inside the backend's ratio policy.
    blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  } catch (error) {
    console.error('[nebula] graph bundle', error);
    showNotice(failureMessage(error, SAVE_GRAPH));
    return null;
  }
  if (blob.size > GRAPH_BUNDLE_MAX_IMPORT_BYTES) {
    showNotice(`${SAVE_GRAPH} ${graphSizeLine(blob.size, GRAPH_BUNDLE_MAX_IMPORT_BYTES)}`);
    return null;
  }
  // Named after the open project, as "Download a copy" is, so Load graph
  // names the project it opens after it again (Q120).
  const suggestedName = projectName
    ? `${projectFileName(projectName)}.zip`
    : `${file.name.replace(/[^a-zA-Z0-9-_ ]/g, '')}.nebula.zip`;
  const saved = await saveBlobWithPicker(blob, suggestedName,
    { description: 'Nebula Node Graph Bundle', accept: { 'application/zip': ['.nebula.zip', '.zip'] } });
  if (saved === null) return null;
  warnAboutSkippedBundleAssets(assetSummary);
  return assetSummary;
}

/**
 * Walk a loaded graph and rewrite every `/api/outputs/<old-rel>` URL it
 * contains, using the mapping returned by POST /api/outputs/restore. Mutates
 * nodes/params/outputs in place. An omitted or unsafe local asset becomes null
 * rather than being rebound to an unrelated file at the same path on the
 * destination backend.
 */
function rewriteAssetUrls(
  nodes: NebulaNode[],
  mapping: Map<string, string>,
): string[] {
  const missingSamples = new Set<string>();
  let missingCount = 0;
  let invalidCount = 0;
  const remap = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const parsed = parseLocalOutputReference(v);
      if (parsed.kind === 'none') return v;
      if (parsed.kind === 'invalid') {
        invalidCount += 1;
        return null;
      }
      const mapped = mapping.get(parsed.relativePath);
      if (!mapped) {
        missingCount += 1;
        if (missingSamples.size < 20) missingSamples.add(parsed.relativePath);
        return null;
      }
      return mapped;
    }
    if (Array.isArray(v)) return v.map(remap);
    if (v && typeof v === 'object') {
      // Object.fromEntries defines `__proto__` as an own data property instead
      // of invoking Object.prototype's legacy setter.
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([key, value]) => [key, remap(value)]),
      );
    }
    return v;
  };
  for (const node of nodes) {
    if (node.data.outputs) {
      node.data.outputs = remap(node.data.outputs) as NodeData['outputs'];
    }
    if (node.data.params) {
      node.data.params = remap(node.data.params) as Record<string, unknown>;
    }
  }
  const warnings = [
    ...[...missingSamples].map((path) => `Bundled asset unavailable: ${path}`),
    ...(missingCount > missingSamples.size
      ? [`${missingCount - missingSamples.size} additional bundled asset references were unavailable.`]
      : []),
    ...(invalidCount > 0
      ? [`Rejected ${invalidCount} unsafe bundled asset reference${invalidCount === 1 ? '' : 's'}.`]
      : []),
  ];
  for (const warning of warnings) console.warn(`[load] ${warning}`);
  return warnings;
}

function sanitizeImportedSpatialOutputs(nodes: NebulaNode[]): string[] {
  let unsafeAssetCount = 0;
  let invalidWorldCount = 0;
  let invalidSpatialCount = 0;

  const countUnsafeAssets = (value: unknown): void => {
    if (!isRecord(value)) return;
    const assets = isRecord(value.assets) ? value.assets : {};
    const candidates: unknown[] = [];
    if (isRecord(assets.splats)) {
      candidates.push(...Object.values(assets.splats));
    } else if (Array.isArray(assets.splats)) {
      candidates.push(
        ...assets.splats.map((item) => (
          isRecord(item) && isRecord(item.asset) ? item.asset.uri : undefined
        )),
      );
    }
    for (const key of ['panorama', 'colliderMesh', 'collider_mesh', 'thumbnail']) {
      const candidate = assets[key];
      candidates.push(isRecord(candidate) ? candidate.uri : candidate);
    }
    if (isRecord(assets.pointCloud) && isRecord(assets.pointCloud.asset)) {
      candidates.push(assets.pointCloud.asset.uri);
    }
    if (isRecord(assets.depthSequence) && Array.isArray(assets.depthSequence.frames)) {
      candidates.push(...assets.depthSequence.frames.map((frame) => (
        isRecord(frame) && isRecord(frame.asset) ? frame.asset.uri : undefined
      )));
    }
    unsafeAssetCount += candidates.filter(
      (candidate) => typeof candidate === 'string' && !isSafeWorldUrl(candidate),
    ).length;
  };

  for (const node of nodes) {
    if (!node.data.outputs) continue;
    for (const [portId, output] of Object.entries(node.data.outputs)) {
      if (!hasRepresentationViewer(output.type)) continue;
      if (output.type === 'World') countUnsafeAssets(output.value);
      const parsed = parseRepresentation(output.type, output.value);
      const parsedValue = parsed?.type === 'World'
        ? parsed.value.value
        : parsed?.value;
      const legacyWithoutSplats = parsed?.type === 'World'
        && parsed.value.version === 1
        && Object.keys(parsed.value.value.assets.splats).length === 0;
      if (!parsedValue || legacyWithoutSplats) {
        delete node.data.outputs[portId];
        if (output.type === 'World') invalidWorldCount += 1;
        else invalidSpatialCount += 1;
        continue;
      }
      output.value = parsedValue;
    }
  }

  const warnings: string[] = [];
  if (unsafeAssetCount > 0) {
    warnings.push(
      `${unsafeAssetCount} external World asset reference${unsafeAssetCount === 1 ? ' was' : 's were'} omitted; only Nebula output assets can be loaded.`,
    );
  }
  if (invalidWorldCount > 0) {
    warnings.push(
      `${invalidWorldCount} invalid World output${invalidWorldCount === 1 ? ' was' : 's were'} made unavailable.`,
    );
  }
  if (invalidSpatialCount > 0) {
    warnings.push(
      `${invalidSpatialCount} invalid spatial output${invalidSpatialCount === 1 ? ' was' : 's were'} made unavailable.`,
    );
  }
  return warnings;
}

/** Zip magic bytes: "PK\x03\x04". */
function isZipBuffer(buf: ArrayBuffer): boolean {
  if (buf.byteLength < 4) return false;
  const b = new Uint8Array(buf, 0, 4);
  return b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFinitePoint(value: unknown): value is { x: number; y: number } {
  return isRecord(value)
    && typeof value.x === 'number'
    && Number.isFinite(value.x)
    && typeof value.y === 'number'
    && Number.isFinite(value.y);
}

function isOptionalHandle(value: unknown): value is string | null | undefined {
  return value == null || typeof value === 'string';
}

function assertValidNebulaEnvelope(parsed: unknown): asserts parsed is NebulaFile {
  if (!isRecord(parsed)) throw new GraphFileInvalidError('Invalid .nebula file: graph must be an object');
  if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) {
    throw new GraphFileInvalidError(`Unsupported .nebula file version: ${String(parsed.version)}`,
      typeof parsed.version === 'number' && parsed.version > 3 ? GRAPH_FILE_NEWER_COPY : GRAPH_FILE_DAMAGED_COPY);
  }
  if (parsed.paramsVersion !== undefined
    && !(Number.isInteger(parsed.paramsVersion) && (parsed.paramsVersion as number) >= 0)) {
    throw new GraphFileInvalidError('Invalid .nebula file: paramsVersion must be a non-negative integer');
  }
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
    throw new GraphFileInvalidError('Invalid .nebula file: name must be a non-empty string');
  }
  if (typeof parsed.createdAt !== 'string' || !parsed.createdAt.trim()) {
    throw new GraphFileInvalidError('Invalid .nebula file: createdAt must be a non-empty string');
  }
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new GraphFileInvalidError('Invalid .nebula file: missing nodes or edges arrays');
  }

  parsed.nodes.forEach((node, index) => {
    if (!isRecord(node)) throw new GraphFileInvalidError(`Invalid .nebula file: nodes[${index}] must be an object`);
    if (typeof node.id !== 'string' || !node.id) {
      throw new GraphFileInvalidError(`Invalid .nebula file: nodes[${index}].id must be a non-empty string`);
    }
    if (typeof node.type !== 'string' || !node.type || !isFinitePoint(node.position)) {
      throw new GraphFileInvalidError(`Invalid .nebula file: nodes[${index}] is missing its type or position`);
    }
    if (!isRecord(node.data)) {
      throw new GraphFileInvalidError(`Invalid .nebula file: nodes[${index}].data must be an object`);
    }
    if (
      typeof node.data.label !== 'string'
      || typeof node.data.definitionId !== 'string'
      || !node.data.definitionId
      || !isRecord(node.data.params)
    ) {
      throw new GraphFileInvalidError(`Invalid .nebula file: nodes[${index}].data has an invalid graph shape`);
    }
    if (node.data.outputs != null && !isRecord(node.data.outputs)) {
      throw new GraphFileInvalidError(`Invalid .nebula file: nodes[${index}].data.outputs must be an object`);
    }
    if (isRecord(node.data.outputs)) {
      Object.entries(node.data.outputs).forEach(([portId, output]) => {
        if (!portId || !isRecord(output) || typeof output.type !== 'string' || !output.type) {
          throw new GraphFileInvalidError(`Invalid .nebula file: nodes[${index}].data.outputs.${portId} must be a typed port object`);
        }
      });
    }
    if (
      node.data.state != null
      && !['idle', 'queued', 'executing', 'complete', 'error', 'skipped'].includes(String(node.data.state))
    ) {
      throw new GraphFileInvalidError(`Invalid .nebula file: nodes[${index}].data.state is invalid`);
    }
  });

  parsed.edges.forEach((edge, index) => {
    if (!isRecord(edge)) throw new GraphFileInvalidError(`Invalid .nebula file: edges[${index}] must be an object`);
    if (
      typeof edge.id !== 'string'
      || !edge.id
      || typeof edge.source !== 'string'
      || !edge.source
      || typeof edge.target !== 'string'
      || !edge.target
      || typeof edge.type !== 'string'
      || !isOptionalHandle(edge.sourceHandle)
      || !isOptionalHandle(edge.targetHandle)
      || (edge.data != null && !isRecord(edge.data))
    ) {
      throw new GraphFileInvalidError(`Invalid .nebula file: edges[${index}] has an invalid graph shape`);
    }
  });

  if (
    parsed.viewport != null
    && (!isRecord(parsed.viewport)
      || typeof parsed.viewport.x !== 'number'
      || !Number.isFinite(parsed.viewport.x)
      || typeof parsed.viewport.y !== 'number'
      || !Number.isFinite(parsed.viewport.y)
      || typeof parsed.viewport.zoom !== 'number'
      || !Number.isFinite(parsed.viewport.zoom)
      || parsed.viewport.zoom <= 0)
  ) {
    throw new GraphFileInvalidError('Invalid .nebula file: viewport must contain finite x, y, and zoom values');
  }
}

function validatedRestoreMapping(value: unknown): Map<string, string> {
  if (!isRecord(value)) throw new GraphFileInvalidError('Asset restore returned an invalid URL mapping');
  const mapping = new Map<string, string>();
  for (const [rawPath, rawMappedUrl] of Object.entries(value)) {
    if (typeof rawMappedUrl !== 'string') {
      throw new GraphFileInvalidError('Asset restore returned an invalid URL mapping');
    }
    const path = canonicalPortableOutputRelativePath(rawPath);
    const mapped = parseLocalOutputReference(rawMappedUrl);
    if (!path || mapped.kind !== 'valid') {
      throw new GraphFileInvalidError('Asset restore returned an invalid URL mapping');
    }
    const existing = mapping.get(path);
    const portableUrl = `${OUTPUTS_PREFIX}${mapped.relativePath}`;
    if (existing && existing !== portableUrl) {
      throw new GraphFileInvalidError('Asset restore returned colliding URL mapping keys');
    }
    mapping.set(path, portableUrl);
  }
  return mapping;
}

/** The link reading Load graph does, for the shared parity test with the
 * backend's port (services/graph_file_links.py, Q123 a): agents open a bundle
 * there, and tests/graphFileLinksParity.test.ts runs these on the same cases.
 * Nothing else calls them through here. */
export const graphFileLinksForTests = {
  canonicalPortableOutputRelativePath,
  parseLocalOutputReference,
  rewriteAssetUrls,
  sanitizeImportedSpatialOutputs,
  validatedRestoreMapping,
};

/** GM's heading for the bundle restore (error-copy round 2). */
const RESTORE_ASSETS = "Couldn't restore the asset.";

/** What Load graph hands the canvas. */
export interface LoadedGraph {
  nodes: Node<NodeData>[];
  edges: Edge[];
  viewport?: Viewport;
  /** Forwarded to POST /api/graph/import, which upgrades older files once. */
  paramsVersion: number;
  warnings: string[];
  /** The file's name, when the picker gave one. */
  fileName?: string;
}

/** A graph file as Load graph reads it (the reader loadFromFile uses, after
 * its picker): a .nebula.zip bundle goes through POST /api/outputs/restore,
 * a plain .nebula (JSON) is checked and read here. Throws what it found
 * wrong; loadFromFile turns that into the notice. */
export async function readGraphSelection(selection: GraphFileSelection): Promise<LoadedGraph> {
  let parsed: unknown;
  let restoreWarnings: string[] = [];

  if (selection.isZip) {
    // The backend owns bounded ZIP preflight, graph.json inflation, graph
    // validation, and atomic extraction. Do not pass this buffer to JSZip:
    // compressed member sizes are not a trustworthy browser-memory bound.
    const resp = await apiRequest(RESTORE_ASSETS, '/api/outputs/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: selection.file,
    });

    const restored = await resp.json() as unknown;
    if (!isRecord(restored)) throw new GraphFileInvalidError('Asset restore returned an invalid response');
    parsed = restored.graph;
    assertGraphComplexityWithinLimits(parsed);
    assertValidNebulaEnvelope(parsed);
    const mapping = validatedRestoreMapping(restored.urlMapping);
    restoreWarnings = rewriteAssetUrls(parsed.nodes, mapping);
  } else {
    // Plain JSON — v1/v2 backward compat.
    const buffer = await selection.file.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(buffer);
    parsed = JSON.parse(text) as unknown;
    assertGraphComplexityWithinLimits(parsed);
    assertValidNebulaEnvelope(parsed);
    // A file from an older Save graph can carry the tab's display links
    // (http://127.0.0.1:<port>/api/outputs/...). Read them as this backend's
    // relative links, as the bundle path's restore mapping does, before the
    // strict World check below.
    parsed.nodes = canonicalBackendAssetUrls(parsed.nodes);
  }

  const worldWarnings = sanitizeImportedSpatialOutputs(parsed.nodes);
  const result = deserializeGraph(parsed);
  return {
    ...result,
    warnings: [...restoreWarnings, ...worldWarnings, ...result.warnings],
    ...(selection.name ? { fileName: selection.name } : {}),
  };
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
export async function loadFromFile(): Promise<LoadedGraph | null> {
  let selection: GraphFileSelection | null = null;

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
      selection = await inspectGraphFileWithinLimit(file);
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      if (err instanceof GraphBundleImportTooLargeError) {
        showNotice(failureMessage(err, LOAD_GRAPH));
        return null;
      }
      console.warn('File System Access API failed, falling back to input:', err);
      selection = await loadViaInput();
      if (!selection) return null;
    }
  } else {
    selection = await loadViaInput();
    if (!selection) return null;
  }

  try {
    return await readGraphSelection(selection);
  } catch (err) {
    console.error('[nebula] graph load', err instanceof GraphFileInvalidError ? err.detail : err);
    // A request's error already names its action ("Couldn't restore the
    // asset. <reason>"); the file's own checks are written lines under
    // LOAD_GRAPH; anything else (JSON that doesn't parse) is a damaged file.
    showNotice(err instanceof SyntaxError
      ? oneLine({ heading: LOAD_GRAPH, reason: GRAPH_FILE_DAMAGED_COPY })
      : failureMessage(err, LOAD_GRAPH));
    return null;
  }
}

/** Fallback file picker using a hidden <input> element. Returns the file
 * after bounded four-byte inspection. ZIP bytes remain in the Blob. */
export function loadViaInput(): Promise<GraphFileSelection | null> {
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
      try {
        resolve(await inspectGraphFileWithinLimit(file));
      } catch (error) {
        console.error('[nebula] graph pick', error);
        showNotice(failureMessage(error, LOAD_GRAPH));
        resolve(null);
      }
    };
    // If the user cancels, onchange never fires — resolve null after cancel
    input.oncancel = () => resolve(null);
    input.click();
  });
}
