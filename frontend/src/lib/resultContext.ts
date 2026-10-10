import type { Node } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import type { ModelNodeDefinition, NodeData, PortValue } from '../types';
import type { CreateDraftSeed } from '../store/createDraftStore';
import { backendAssetUrlSync } from './backend';
import { isCreateModel } from './createModels';
import { kreaModeFor, supportsKreaAccount } from './kreaConnection';
import type { RunRecord, RunSnapshotNode } from './runHistory';

export interface ResultContext {
  key: string;
  modelName: string;
  definitionId: string;
  prompt: string;
  timestamp?: number;
  provenance: 'saved-run' | 'unrecorded';
  params: Record<string, unknown>;
  refs: string[];
  inputs?: Array<{ label: string; type: string; value: unknown; resolved: boolean }>;
  runId?: string;
  reusableDraft?: CreateDraftSeed;
  reuseUnavailableReason?: string;
}

/** Local media links can change origins when another backend owns a preview.
 * Provider URLs, signed query strings and arbitrary text stay intact. */
function localAssetPath(value: string): string {
  try {
    const url = new URL(value);
    if ((url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
      && !url.username && !url.password
      && ['/api/outputs/', '/api/uploads/'].some((prefix) => url.pathname.startsWith(prefix))) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
  } catch { /* Already relative or a filesystem path. */ }
  return value;
}

function canonical(value: unknown, media = false): unknown {
  if (typeof value === 'string') return media ? localAssetPath(value) : value;
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, media));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonical(entry, media)]));
  }
  return value;
}

function outputIdentity(outputs: Record<string, PortValue>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(outputs).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, port]) => [key, canonical(port,
      ['Image', 'Video', 'Audio', 'Mesh', 'SVG'].includes(port?.type))])));
}

function authorParams(params: Record<string, unknown>, definition?: ModelNodeDefinition): Record<string, unknown> {
  const authored = structuredClone(Object.fromEntries(Object.entries(params)
    .filter(([key]) => !key.startsWith('_') || key === '_kreaAuth')));
  // Old gateway recipes used API billing even when their mode was not written.
  if (supportsKreaAccount(definition)) authored._kreaAuth = kreaModeFor(definition, params);
  return authored;
}

function modelName(definitionId: string, params: Record<string, unknown>): string {
  const definition = NODE_DEFINITIONS[definitionId];
  if (!definition) return definitionId;
  const selected = [...definition.params, ...(definition.sharedParams ?? []),
    ...(definition.directParams ?? []), ...(definition.falParams ?? [])]
    .find((param) => param.key === 'model')?.options?.find((option) => option.value === params.model)?.label;
  return selected && selected !== definition.displayName
    ? `${definition.displayName} · ${selected}` : definition.displayName;
}

interface ResolvedInput { type: string; value: unknown }

function frozenInput(run: RunRecord, sourceId: string, handle: string, seen = new Set<string>()): ResolvedInput | null {
  const identity = `${sourceId}:${handle}`;
  if (seen.has(identity)) return null;
  const source = run.snapshot.nodes.find((candidate) => candidate.id === sourceId);
  if (!source) return null;
  // Input authoring params are the recipe. Pre-run outputs may be stale.
  if (source.definitionId === 'text-input' && handle === 'text') {
    return typeof source.params.value === 'string' ? { type: 'Text', value: source.params.value } : null;
  }
  if (source.definitionId === 'image-input' && handle === 'image') {
    return typeof source.params.filePath === 'string' ? { type: 'Image', value: source.params.filePath } : null;
  }
  const recorded = run.resultOutputs?.[sourceId]?.[handle] ?? source.outputs[handle];
  if (recorded && typeof recorded === 'object' && 'type' in recorded && 'value' in recorded) {
    return recorded as ResolvedInput;
  }
  if (source.definitionId === 'reroute' && handle === 'output') {
    const incoming = run.snapshot.edges.filter((edge) => edge.target === sourceId && edge.targetHandle === 'input');
    const edge = incoming.at(-1);
    return edge?.sourceHandle
      ? frozenInput(run, edge.source, edge.sourceHandle, new Set([...seen, identity])) : null;
  }
  return null;
}

function imageRefs(value: unknown): string[] | null {
  if (typeof value === 'string') return value.trim() ? [localAssetPath(value)] : null;
  if (Array.isArray(value)) {
    const entries = value.map(imageRefs);
    return entries.length && entries.every((entry) => entry !== null) ? entries.flat() as string[] : null;
  }
  if (value && typeof value === 'object' && 'url' in value) return imageRefs(value.url);
  return null;
}

function ancestryHasBatch(run: RunRecord, nodeId: string, seen = new Set<string>()): boolean {
  if (seen.has(nodeId)) return false;
  if ((run.batchOutputs?.[nodeId]?.length ?? 0) > 1) return true;
  seen.add(nodeId);
  return run.snapshot.edges.filter((edge) => edge.target === nodeId)
    .some((edge) => ancestryHasBatch(run, edge.source, seen));
}

function frozenCopy<T>(value: T): T {
  const copy = structuredClone(value);
  function freeze(entry: unknown): void {
    if (entry && typeof entry === 'object') {
      Object.values(entry).forEach(freeze);
      Object.freeze(entry);
    }
  }
  freeze(copy);
  return copy;
}

function savedInputs(run: RunRecord, model: RunSnapshotNode, definition?: ModelNodeDefinition): {
  prompt: string; refs: string[]; reusableRefs: string[]; inputs: NonNullable<ResultContext['inputs']>; unavailable?: string;
} {
  let prompt = typeof model.params.prompt === 'string' ? model.params.prompt : '';
  const refs: string[] = [];
  const inputs: NonNullable<ResultContext['inputs']> = [];
  let reusableRefs: string[] = [];
  let unavailable: string | undefined;
  const textPort = definition?.inputPorts.find((port) => port.dataType === 'Text');
  const imagePort = definition?.inputPorts.find((port) => port.dataType === 'Image');
  for (const edge of run.snapshot.edges.filter((candidate) => candidate.target === model.id)) {
    const port = definition?.inputPorts.find((candidate) => candidate.id === edge.targetHandle);
    const input = edge.sourceHandle ? frozenInput(run, edge.source, edge.sourceHandle) : null;
    const resolved = input !== null && input.value !== null && input.value !== undefined;
    inputs.push({ label: port?.label ?? edge.targetHandle ?? 'Unknown input',
      type: input?.type ?? port?.dataType ?? 'Unknown', value: resolved ? input.value : null, resolved });
    const images = input?.type === 'Image' ? imageRefs(input.value) : null;
    if (images) refs.push(...images);
    if (!port || (port.id !== textPort?.id && port.id !== imagePort?.id)) {
      unavailable ??= `${port?.label ?? 'An input'} needs Canvas controls. Open this result in Canvas to reuse its recipe.`;
      continue;
    }
    if (port.id === textPort?.id) {
      if (input?.type === 'Text' && typeof input.value === 'string') prompt = input.value;
      else unavailable ??= 'The saved prompt input could not be recovered. Open the saved run in Run History.';
    } else {
      if (images) reusableRefs = port.multiple ? [...reusableRefs, ...images] : images;
      else unavailable ??= 'A saved image input could not be recovered. Open the saved run in Run History.';
    }
  }
  if (imagePort && !imagePort.multiple && reusableRefs.length > 1) {
    unavailable ??= 'This saved input has multiple images on one Canvas port. Reuse it from Run History.';
  }
  if (textPort?.required && !prompt.trim()) unavailable ??= 'The saved prompt is unavailable. Open the saved run in Run History.';
  if (imagePort?.required && reusableRefs.length === 0) unavailable ??= 'The saved image input is unavailable. Open the saved run in Run History.';
  if (ancestryHasBatch(run, model.id)) unavailable ??= 'This is a batch result. Reuse its iterator recipe from Run History.';
  return { prompt, refs, reusableRefs, inputs, unavailable };
}

/** Result provenance comes from its actual outputs and immutable run snapshot,
 * never from mutable Canvas settings or a generation-group tag. No execution
 * or graph mutation is performed when preparing a fresh single-result draft. */
export function resultContextForNode(node: Node<NodeData>, history: readonly RunRecord[]): ResultContext {
  const outputs = node.data.outputs ?? {};
  const identity = outputIdentity(outputs);
  const hasOutput = Object.values(outputs).some((port) => port?.value !== null && port?.value !== undefined && port?.value !== '');
  const run = hasOutput ? history.filter((candidate) => ['complete', 'failed', 'cancelled'].includes(candidate.status)
    && candidate.resultOutputs?.[node.id]
    && candidate.snapshot?.nodes?.some((saved) => saved.id === node.id)
    && outputIdentity(candidate.resultOutputs[node.id]) === identity)
    .sort((a, b) => b.startedAt - a.startedAt)[0] : undefined;
  const saved = run?.snapshot.nodes.find((candidate) => candidate.id === node.id);
  const definitionId = saved?.definitionId ?? node.data.definitionId;
  const definition = NODE_DEFINITIONS[definitionId];
  const params = authorParams(saved?.params ?? node.data.params ?? {}, definition);
  const context: ResultContext = {
    key: JSON.stringify([node.id, run?.id ?? null, identity]),
    modelName: modelName(definitionId, params), definitionId,
    prompt: '', provenance: run && saved ? 'saved-run' : 'unrecorded', params, refs: [],
  };
  if (!run || !saved) {
    context.reuseUnavailableReason = 'This result has no matching saved run. Its current Canvas settings may have changed.';
    return context;
  }
  const inputs = savedInputs(run, saved, definition);
  context.runId = run.id;
  context.timestamp = run.startedAt;
  context.prompt = inputs.prompt;
  context.refs = [...inputs.refs];
  context.inputs = frozenCopy(inputs.inputs);
  context.reuseUnavailableReason = !definition ? 'This model is no longer available.'
    : !isCreateModel(definition) ? 'This model needs Canvas controls. Reuse its saved recipe from Run History.'
      : inputs.unavailable;
  if (!context.reuseUnavailableReason) {
    context.reusableDraft = {
      modelId: definitionId, prompt: inputs.prompt, params: structuredClone(params), quantity: 1, uploads: [],
      refs: inputs.reusableRefs.map((filePath) => ({ filePath, previewUrl: backendAssetUrlSync(filePath) })),
    };
  }
  return context;
}
