import type { PortValue, NodeState } from '../../types';
import { findStructuredRepresentation } from '../../lib/representationViewerRegistry';
import { MeshPreview } from '../nodes/DeferredViewers';
import { RepresentationViewer } from '../nodes/RepresentationViewer';
import { NodeError } from '../nodes/NodeError';

function urlOf(v: PortValue['value']): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'url' in (v as Record<string, unknown>)) {
    return (v as { url: string }).url;
  }
  return null;
}

function findByType(outputs: Record<string, PortValue>, type: PortValue['type']): PortValue | undefined {
  return Object.values(outputs).find((o) => o.type === type && o.value);
}

export function OutputRenderer({
  outputs,
  state,
  error,
  errorCategory,
  errorFriendly,
  errorPerson,
  errorProviderText,
  errorProvider,
  streamingText,
  streamingPartials,
  streamingSvg,
}: {
  outputs: Record<string, PortValue>;
  state: NodeState;
  error?: string;
  /** The node's run error readings (error copy round 3c): the card's lines, not the raw text. */
  errorCategory?: string;
  errorFriendly?: string;
  errorPerson?: string;
  errorProviderText?: boolean;
  /** The provider the run called (round 3f): GM's general line names it. */
  errorProvider?: string;
  streamingText?: string;
  streamingPartials?: { index: number; src: string }[];
  streamingSvg?: { index: number; svg: string; isFinal: boolean };
}) {
  if (state === 'queued' || state === 'executing') {
    if (streamingSvg?.svg) {
      return <img className="create-output__media" src={`data:image/svg+xml;utf8,${encodeURIComponent(streamingSvg.svg)}`} alt="Generating preview" />;
    }
    const lastPartial = streamingPartials && streamingPartials.length > 0
      ? streamingPartials[streamingPartials.length - 1]
      : null;
    if (lastPartial) {
      return <img className="create-output__media" src={lastPartial.src} alt="Generating preview" />;
    }
    if (streamingText) {
      return <div className="create-output__text">{streamingText}</div>;
    }
    return (
      <div className="create-output create-output--loading" role="status" aria-live="polite">
        <span className="create-output__spinner" aria-hidden="true" />
        <span className="create-output__loading-label">Generating…</span>
      </div>
    );
  }
  if (state === 'error') {
    // The same lines as the canvas card (lib/nodeErrorCopy.ts): the person's
    // line or GM's, the raw provider text only behind Details.
    return <NodeError className="create-output create-output--error" raw={error ?? 'Generation failed'}
      category={errorCategory} friendly={errorFriendly} person={errorPerson} providerText={errorProviderText}
      provider={errorProvider} />;
  }

  const isComplete = state === 'complete';
  const world = isComplete ? findByType(outputs, 'World') : undefined;
  const video = isComplete ? findByType(outputs, 'Video') : undefined;
  const image = isComplete ? (findByType(outputs, 'Image') ?? findByType(outputs, 'SVG')) : undefined;
  const mesh = isComplete ? findByType(outputs, 'Mesh') : undefined;
  const audio = isComplete ? findByType(outputs, 'Audio') : undefined;
  const spatial = isComplete ? findStructuredRepresentation(outputs, { includeWorld: false }) : undefined;
  const text = findByType(outputs, 'Text');

  if (world) return <RepresentationViewer type={world.type} value={world.value} compact />;
  if (video) return <video className="create-output__media" src={urlOf(video.value) ?? ''} controls loop playsInline />;
  if (image) return <img className="create-output__media" src={urlOf(image.value) ?? ''} alt="Generated output" />;
  if (mesh) return <MeshPreview src={urlOf(mesh.value) ?? ''} />;
  if (audio) return <audio className="create-output__audio" src={urlOf(audio.value) ?? ''} controls />;
  if (spatial) return <RepresentationViewer type={spatial.type} value={spatial.value} compact />;
  if (text) return <div className="create-output__text">{String(text.value)}</div>;

  return <div className="create-output create-output--empty" aria-hidden="true" />;
}
