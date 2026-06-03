import type { PortValue, NodeState } from '../../types';

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
  streamingText,
  streamingPartials,
  streamingSvg,
}: {
  outputs: Record<string, PortValue>;
  state: NodeState;
  error?: string;
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
    return <div className="create-output create-output--error">{error ?? 'Generation failed'}</div>;
  }

  const isComplete = state === 'complete';
  const video = isComplete ? findByType(outputs, 'Video') : undefined;
  const image = isComplete ? (findByType(outputs, 'Image') ?? findByType(outputs, 'SVG')) : undefined;
  const mesh = isComplete ? findByType(outputs, 'Mesh') : undefined;
  const audio = isComplete ? findByType(outputs, 'Audio') : undefined;
  const text = findByType(outputs, 'Text');

  if (video) return <video className="create-output__media" src={urlOf(video.value) ?? ''} controls loop playsInline />;
  if (image) return <img className="create-output__media" src={urlOf(image.value) ?? ''} alt="Generated output" />;
  if (mesh) {
    return (
      <model-viewer
        className="create-output__media"
        src={urlOf(mesh.value) ?? ''}
        camera-controls
        auto-rotate
      />
    );
  }
  if (audio) return <audio className="create-output__audio" src={urlOf(audio.value) ?? ''} controls />;
  if (text) return <div className="create-output__text">{String(text.value)}</div>;

  return <div className="create-output create-output--empty" aria-hidden="true" />;
}
