import { deferredAtOnce } from '../deferredAtOnce';
import { DeferredJevResultView, DeferredRepresentationViewer, DeferredStructuredOutputs } from '../../lib/deferredChunks';

/**
 * The result views a finished node card draws: a Jev answer, a world or
 * spatial value, structured output. Each is mounted at once and draws nothing
 * until its chunk lands, so a card that mounts one must not be drawn before
 * that chunk has settled: the canvas holds such a node back (lib/cardHold.ts;
 * lib/cardChunks.ts finds the views a node needs with the predicates in
 * lib/resultViews.ts, which the cards use too). A view that mounts later, when
 * a run finishes, appears when its chunk lands (long loaded by then).
 */
export const JevResultView = deferredAtOnce(DeferredJevResultView, 'JevResultView');
export const RepresentationViewer = deferredAtOnce(DeferredRepresentationViewer, 'RepresentationViewer');
export const StructuredOutputs = deferredAtOnce(DeferredStructuredOutputs, 'StructuredOutputs');
