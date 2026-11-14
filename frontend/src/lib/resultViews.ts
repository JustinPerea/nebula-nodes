import type { NodeData, PortValue } from '../types';
import { parseJevOutputs, type JevResult } from './jev';
import { findStructuredRepresentation } from './representationViewerRegistry';

/**
 * Which result views a finished node card mounts, decided from its outputs
 * alone. ModelNode and DynamicNode call these to decide what to draw, and
 * lib/cardChunks.ts calls them to learn which deferred chunks a card needs
 * (components/nodes/DeferredOutputViews.tsx), so the two cannot drift. Kept
 * free of the view components so it stays in the startup set.
 */

export type NodeOutputs = Readonly<Record<string, PortValue>>;

/** The Jev answer a card shows in place of its generic previews, when it has a readable one. */
export function jevResultFor(definitionId: unknown, outputs: NodeOutputs, complete: boolean): JevResult | null {
  return complete ? parseJevOutputs(definitionId, outputs) : null;
}

export function worldOutputOf(outputs: NodeOutputs): PortValue | undefined {
  return Object.values(outputs).find((output) => output.type === 'World' && output.value);
}


/** The spatial value (depth, point cloud, camera path...) the viewer can draw. */
export function spatialOutputOf(outputs: NodeOutputs): PortValue | undefined {
  return findStructuredRepresentation(outputs, { includeWorld: false });
}

const firstWithValue = (outputs: NodeOutputs, type: PortValue['type']): PortValue | undefined => (
  Object.values(outputs).find((output) => output.type === type && output.value)
);

/**
 * True when the card draws one of the outputs as media, text or a world: the
 * first image, SVG, video, mesh or audio that has a value is a string, there
 * is a world, or there is text (and no streamed text, which the card shows
 * instead). A finished card with none of these draws its values as
 * structured outputs. The cards add their own cases (an inline text node, a
 * mask composite), which only make a card draw more media, so this answers
 * "may mount StructuredOutputs" without ever missing one.
 */
export function drawsMediaOrText(outputs: NodeOutputs, hasStreamingText = false): boolean {
  if (worldOutputOf(outputs)) return true;
  for (const type of ['Image', 'SVG', 'Video', 'Mesh', 'Audio'] as const) {
    if (typeof firstWithValue(outputs, type)?.value === 'string') return true;
  }
  return !hasStreamingText && typeof firstWithValue(outputs, 'Text')?.value === 'string';
}

/** Whether a card with these outputs draws them as structured values: finished, and nothing else drew them. */
export function structuredOutputsFor(outputs: NodeOutputs, complete: boolean, hasStreamingText = false): [string, PortValue][] {
  return complete && !drawsMediaOrText(outputs, hasStreamingText) ? Object.entries(outputs) : [];
}

export interface ResultViewNeeds { readonly jev: boolean; readonly viewer: boolean; readonly structured: boolean }

const NONE: ResultViewNeeds = { jev: false, viewer: false, structured: false };

/**
 * The result views a card for `data` may mount now or after the person
 * browses another batch result (each batch output is a set of outputs the
 * card can show). An over-estimate is allowed: a card that ends up not using
 * a view only waits for its chunk, a missed view draws empty.
 */
export function resultViewNeeds(data: NodeData | undefined): ResultViewNeeds {
  if (!data || typeof data !== 'object') return NONE;
  const sets: NodeOutputs[] = [];
  const batch = Array.isArray(data.batchOutputs) ? data.batchOutputs : [];
  if (data.outputs && typeof data.outputs === 'object') sets.push(data.outputs);
  sets.push(...batch.filter((outputs) => outputs && typeof outputs === 'object'));
  if (sets.length === 0) return NONE;
  // A card browsing batch results is complete whatever its state says; one that is running is not.
  const browsing = batch.length > 0 && data.state !== 'queued' && data.state !== 'executing';
  const complete = data.state === 'complete' || browsing;
  if (!complete) return NONE;
  const streaming = data.streamingText != null;
  let jev = false;
  let viewer = false;
  let structured = false;
  for (const outputs of sets) {
    jev ||= jevResultFor(data.definitionId, outputs, true) !== null;
    viewer ||= worldOutputOf(outputs) !== undefined || spatialOutputOf(outputs) !== undefined;
    structured ||= structuredOutputsFor(outputs, true, streaming).length > 0;
  }
  return { jev, viewer, structured };
}
