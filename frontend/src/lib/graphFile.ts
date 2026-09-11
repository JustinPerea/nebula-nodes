import JSZip from 'jszip';
import type { Node, Edge, Viewport } from '@xyflow/react';
import type { NodeData, NodeState } from '../types';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { apiFetch, backendAssetUrlSync, getCachedBackendBaseUrl } from './backend';
import { AssetByteLimitError, readBoundedAssetResponse } from './boundedAsset';
import {
  hasRepresentationViewer,
  parseRepresentation,
} from './representationViewerRegistry';
import { isSafeWorldUrl } from './worldValue';

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
export const GRAPH_JSON_MAX_IMPORT_BYTES = 16 * 1024 * 1024;
export const GRAPH_BUNDLE_MAX_MEMBERS = 4096;
export const GRAPH_BUNDLE_MAX_ASSET_MEMBERS = GRAPH_BUNDLE_MAX_MEMBERS - 1; // graph.json
export const GRAPH_MAX_NODES = 10_000;
export const GRAPH_MAX_EDGES = 50_000;
export const GRAPH_MAX_DEPTH = 64;
export const GRAPH_MAX_VALUES = 1_000_000;

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

function warnAboutSkippedBundleAssets(summary: GraphBundleAssetSummary): void {
  if (summary.skipped === 0) return;
  const noun = summary.skipped === 1 ? 'asset was' : 'assets were';
  alert(
    `Graph saved, but ${summary.skipped} referenced ${noun} not included. `
    + 'Those outputs may be unavailable when the bundle is opened elsewhere.',
  );
}

export class GraphBundleImportTooLargeError extends Error {}
export class GraphStructureLimitError extends Error {}

export interface GraphFileSelection {
  file: Blob;
  isZip: boolean;
}

/** Inspect only four signature bytes, retaining ZIPs as Blobs so fetch can
 * stream them to the backend without first duplicating the whole selection in
 * JavaScript memory. Plain JSON gets a much smaller parse-memory ceiling. */
export async function inspectGraphFileWithinLimit(file: Blob): Promise<GraphFileSelection> {
  if (file.size > GRAPH_BUNDLE_MAX_IMPORT_BYTES) {
    throw new GraphBundleImportTooLargeError(
      `The selected graph is ${(file.size / (1024 * 1024)).toFixed(1)} MB. `
      + `Nebula can safely open bundles up to ${Math.floor(GRAPH_BUNDLE_MAX_IMPORT_BYTES / (1024 * 1024))} MB.`,
    );
  }
  const signature = await file.slice(0, 4).arrayBuffer();
  const isZip = isZipBuffer(signature);
  if (!isZip && file.size > GRAPH_JSON_MAX_IMPORT_BYTES) {
    throw new GraphBundleImportTooLargeError(
      `The selected JSON graph is ${(file.size / (1024 * 1024)).toFixed(1)} MB. `
      + `Nebula can safely parse JSON graphs up to ${Math.floor(GRAPH_JSON_MAX_IMPORT_BYTES / (1024 * 1024))} MB.`,
    );
  }
  return { file, isZip };
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
          params: normalizeRuntimeMediaParams(n.data.definitionId, n.data.params),
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
    const outputs = (n.data.outputs ?? {}) as NodeData['outputs'];
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
        params: normalizeRuntimeMediaParams(n.data.definitionId, n.data.params),
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
    file = serializeGraph(nodes, edges, viewport);
    file.version = 3;
    assertGraphComplexityWithinLimits(file);
    graphJson = JSON.stringify(file, null, 2);
    const graphBytes = new TextEncoder().encode(graphJson).byteLength;
    if (graphBytes > GRAPH_JSON_MAX_IMPORT_BYTES) {
      throw new GraphStructureLimitError(
        `graph.json is ${(graphBytes / (1024 * 1024)).toFixed(1)} MB; the portable limit is `
        + `${Math.floor(GRAPH_JSON_MAX_IMPORT_BYTES / (1024 * 1024))} MB.`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The graph could not be serialized safely.';
    alert(`Failed to save graph: ${message}`);
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
    const message = error instanceof Error ? error.message : 'The portable bundle could not be created.';
    alert(`Failed to save graph: ${message}`);
    return null;
  }
  if (blob.size > GRAPH_BUNDLE_MAX_IMPORT_BYTES) {
    alert(
      `Failed to save graph: the finished bundle is ${(blob.size / (1024 * 1024)).toFixed(1)} MB, `
      + `above Nebula's ${Math.floor(GRAPH_BUNDLE_MAX_IMPORT_BYTES / (1024 * 1024))} MB portable limit.`,
    );
    return null;
  }
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
      warnAboutSkippedBundleAssets(assetSummary);
      return assetSummary;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
      console.warn('File System Access API failed, falling back to download:', err);
    }
  }

  // Fallback: download via <a> tag
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
export function assertGraphComplexityWithinLimits(value: unknown): void {
  if (isRecord(value)) {
    if (Array.isArray(value.nodes) && value.nodes.length > GRAPH_MAX_NODES) {
      throw new GraphStructureLimitError(`Graph contains more than ${GRAPH_MAX_NODES.toLocaleString()} nodes.`);
    }
    if (Array.isArray(value.edges) && value.edges.length > GRAPH_MAX_EDGES) {
      throw new GraphStructureLimitError(`Graph contains more than ${GRAPH_MAX_EDGES.toLocaleString()} edges.`);
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
      throw new GraphStructureLimitError(
        `Graph contains more than ${GRAPH_MAX_VALUES.toLocaleString()} values.`,
      );
    }
    if (frame.depth > GRAPH_MAX_DEPTH) {
      throw new GraphStructureLimitError(`Graph is nested more than ${GRAPH_MAX_DEPTH} levels deep.`);
    }
    if (typeof current === 'number' && !Number.isFinite(current)) {
      throw new GraphStructureLimitError('Graph contains a non-finite number.');
    }
    if (!current || typeof current !== 'object') continue;
    if (ancestors.has(current)) {
      throw new GraphStructureLimitError('Graph contains a circular value that cannot be saved.');
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
  if (!isRecord(parsed)) throw new Error('Invalid .nebula file: graph must be an object');
  if (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) {
    throw new Error(`Unsupported .nebula file version: ${String(parsed.version)}`);
  }
  if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
    throw new Error('Invalid .nebula file: name must be a non-empty string');
  }
  if (typeof parsed.createdAt !== 'string' || !parsed.createdAt.trim()) {
    throw new Error('Invalid .nebula file: createdAt must be a non-empty string');
  }
  if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error('Invalid .nebula file: missing nodes or edges arrays');
  }

  parsed.nodes.forEach((node, index) => {
    if (!isRecord(node)) throw new Error(`Invalid .nebula file: nodes[${index}] must be an object`);
    if (typeof node.id !== 'string' || !node.id) {
      throw new Error(`Invalid .nebula file: nodes[${index}].id must be a non-empty string`);
    }
    if (typeof node.type !== 'string' || !node.type || !isFinitePoint(node.position)) {
      throw new Error(`Invalid .nebula file: nodes[${index}] is missing its type or position`);
    }
    if (!isRecord(node.data)) {
      throw new Error(`Invalid .nebula file: nodes[${index}].data must be an object`);
    }
    if (
      typeof node.data.label !== 'string'
      || typeof node.data.definitionId !== 'string'
      || !node.data.definitionId
      || !isRecord(node.data.params)
    ) {
      throw new Error(`Invalid .nebula file: nodes[${index}].data has an invalid graph shape`);
    }
    if (node.data.outputs != null && !isRecord(node.data.outputs)) {
      throw new Error(`Invalid .nebula file: nodes[${index}].data.outputs must be an object`);
    }
    if (isRecord(node.data.outputs)) {
      Object.entries(node.data.outputs).forEach(([portId, output]) => {
        if (!portId || !isRecord(output) || typeof output.type !== 'string' || !output.type) {
          throw new Error(`Invalid .nebula file: nodes[${index}].data.outputs.${portId} must be a typed port object`);
        }
      });
    }
    if (
      node.data.state != null
      && !['idle', 'queued', 'executing', 'complete', 'error'].includes(String(node.data.state))
    ) {
      throw new Error(`Invalid .nebula file: nodes[${index}].data.state is invalid`);
    }
  });

  parsed.edges.forEach((edge, index) => {
    if (!isRecord(edge)) throw new Error(`Invalid .nebula file: edges[${index}] must be an object`);
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
      throw new Error(`Invalid .nebula file: edges[${index}] has an invalid graph shape`);
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
    throw new Error('Invalid .nebula file: viewport must contain finite x, y, and zoom values');
  }
}

function validatedRestoreMapping(value: unknown): Map<string, string> {
  if (!isRecord(value)) throw new Error('Asset restore returned an invalid URL mapping');
  const mapping = new Map<string, string>();
  for (const [rawPath, rawMappedUrl] of Object.entries(value)) {
    if (typeof rawMappedUrl !== 'string') {
      throw new Error('Asset restore returned an invalid URL mapping');
    }
    const path = canonicalPortableOutputRelativePath(rawPath);
    const mapped = parseLocalOutputReference(rawMappedUrl);
    if (!path || mapped.kind !== 'valid') {
      throw new Error('Asset restore returned an invalid URL mapping');
    }
    const existing = mapping.get(path);
    const portableUrl = `${OUTPUTS_PREFIX}${mapped.relativePath}`;
    if (existing && existing !== portableUrl) {
      throw new Error('Asset restore returned colliding URL mapping keys');
    }
    mapping.set(path, portableUrl);
  }
  return mapping;
}

async function restoreFailureMessage(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { detail?: unknown } | null;
  return typeof payload?.detail === 'string' && payload.detail.trim()
    ? payload.detail
    : `Asset restore failed (HTTP ${response.status})`;
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
        alert(`Failed to load graph: ${err.message}`);
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
    let parsed: unknown;
    let restoreWarnings: string[] = [];

    if (selection.isZip) {
      // The backend owns bounded ZIP preflight, graph.json inflation, graph
      // validation, and atomic extraction. Do not pass this buffer to JSZip:
      // compressed member sizes are not a trustworthy browser-memory bound.
      const resp = await apiFetch('/api/outputs/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: selection.file,
      });
      if (!resp.ok) throw new Error(await restoreFailureMessage(resp));

      const restored = await resp.json() as unknown;
      if (!isRecord(restored)) throw new Error('Asset restore returned an invalid response');
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
    }

    const worldWarnings = sanitizeImportedSpatialOutputs(parsed.nodes);
    const result = deserializeGraph(parsed);
    return {
      ...result,
      warnings: [...restoreWarnings, ...worldWarnings, ...result.warnings],
    };
  } catch (err) {
    console.error('Failed to load graph file:', err);
    alert(`Failed to load graph: ${(err as Error).message}`);
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
        const message = error instanceof Error ? error.message : 'The selected file could not be read.';
        alert(`Failed to load graph: ${message}`);
        resolve(null);
      }
    };
    // If the user cancels, onchange never fires — resolve null after cancel
    input.oncancel = () => resolve(null);
    input.click();
  });
}
