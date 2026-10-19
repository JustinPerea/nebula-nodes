import { useMemo } from 'react';
import type { PortValue } from '../../types';
import { backendAssetUrlSync } from '../../lib/backend';
import { isMoodboardBundle } from '../../lib/moodboardBundle';
import {
  boundedJson, CARD_LIMITS, describeStructuredValue, FULL_LIMITS, type StructuredView,
} from '../../lib/structuredValue';
import { CopyValueButton, ExpandableBlock } from './ExpandableBlock';
import { MoodboardBundlePreview, SwatchRow, type StructuredVariant } from './MoodboardBundlePreview';
import { OverviewImage } from './OverviewImage';
import '../../styles/structured-preview.css';

/** The most JSON the Inspector shows; Copy takes the whole value. */
const FULL_JSON_LIMIT = 20_000;

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function copyJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * A port value that none of a card's media renderers draw: a Moodboard
 * bundle as its board, a list of media as media, a list of colours as
 * swatches, an object as a short key/value list, anything else as clamped
 * text. On a card (`card`) everything is capped; in the Inspector (`full`)
 * objects and lists show as JSON (up to FULL_JSON_LIMIT characters) with Copy.
 */
export function StructuredValuePreview({ output, label, variant = 'card' }: {
  output: PortValue;
  /** The port's name, when the card shows more than one value. */
  label?: string;
  variant?: StructuredVariant;
}) {
  const { type, value } = output;
  const view = useMemo(
    () => describeStructuredValue(value, variant === 'full' ? FULL_LIMITS : CARD_LIMITS),
    [value, variant],
  );
  const json = useMemo(() => {
    if (variant !== 'full' || (view.kind !== 'record' && view.kind !== 'list')) return null;
    return boundedJson(value, FULL_JSON_LIMIT);
  }, [value, variant, view.kind]);

  if (isMoodboardBundle(type, value)) {
    return (
      <>
        {label && <div className="structured-preview__port">{label}</div>}
        <MoodboardBundlePreview value={value} variant={variant} />
      </>
    );
  }

  const title = view.kind === 'record' ? view.title : null;
  // "CameraRig" reads as "Camera Rig".
  const typeName = String(type).replace(/([a-z])([A-Z])/g, '$1 $2');
  const meta = [title ? typeName : null, countFor(view)].filter(Boolean).join(' · ');
  return (
    <div className={`structured-preview structured-preview--${view.kind} structured-preview--${variant}`}
      role="group" aria-label={title ? `${typeName} ${title}` : typeName}>
      {label && <div className="structured-preview__port">{label}</div>}
      <div className="structured-preview__head">
        <span className={title ? 'structured-preview__title' : 'structured-preview__type'}>{title ?? typeName}</span>
        {meta && <span className="structured-preview__meta">{meta}</span>}
      </div>
      <StructuredBody view={view} variant={variant} json={json} />
      {variant === 'full' && view.kind !== 'empty' && (
        <div className="structured-preview__actions">
          {json?.truncated && (
            <span className="structured-preview__note">
              Showing the first {FULL_JSON_LIMIT.toLocaleString('en-US')} characters. Copy takes all of it.
            </span>
          )}
          <CopyValueButton text={() => copyJson(value)} />
        </div>
      )}
    </div>
  );
}

function countFor(view: StructuredView): string | null {
  switch (view.kind) {
    case 'media': return plural(view.total, view.media === 'audio' ? 'audio file' : view.media);
    case 'colors': return plural(view.total, 'color');
    case 'list': return plural(view.total, 'item');
    case 'record': return plural(view.total, 'field');
    default: return null;
  }
}

function StructuredBody({ view, variant, json }: {
  view: StructuredView;
  variant: StructuredVariant;
  json: { text: string; truncated: boolean } | null;
}) {
  const collapsible = variant === 'card';
  switch (view.kind) {
    case 'empty':
      return <p className="structured-preview__empty">{view.text}</p>;
    case 'scalar':
      return (
        <ExpandableBlock lines={6} contentKey={view.text.slice(0, 2000)} longHint={view.long} collapsible={collapsible}>
          <p className="structured-preview__text">
            {view.text.length > FULL_JSON_LIMIT ? `${view.text.slice(0, FULL_JSON_LIMIT)}…` : view.text}
          </p>
        </ExpandableBlock>
      );
    case 'colors':
      return <SwatchRow label="Colors" colors={view.colors} limit={variant === 'full' ? 40 : 12} />;
    case 'media':
      return <MediaStrip media={view.media} urls={view.urls} more={view.total - view.urls.length} />;
    case 'list':
      if (json) return <JsonBlock json={json} />;
      return (
        <ol className="structured-preview__list">
          {view.items.map((item, index) => (
            // Items can repeat, so their place in the list is part of the key.
            <li key={`${index}:${item}`} className="structured-preview__item">{item}</li>
          ))}
          {view.total > view.items.length && (
            <li className="structured-preview__item structured-preview__item--more">
              {plural(view.total - view.items.length, 'more item')}
            </li>
          )}
        </ol>
      );
    case 'record':
      return (
        <>
          {view.thumbnails.length > 0 && <MediaStrip media="image" urls={view.thumbnails} more={0} />}
          {json ? <JsonBlock json={json} /> : (
            <ExpandableBlock lines={7} contentKey={view.fields.map((field) => field.key).join('\n')}
              longHint={view.fields.length > 6} collapsible={collapsible}>
              <dl className="structured-preview__fields">
                {view.fields.map((field) => (
                  <div key={field.key} className="structured-preview__field">
                    <dt>{field.key}</dt>
                    <dd>{field.value}</dd>
                  </div>
                ))}
              </dl>
              {view.total > view.fields.length && (
                <p className="structured-preview__note">
                  {plural(view.total - view.fields.length, 'more field')}: open the node's settings to read them
                </p>
              )}
            </ExpandableBlock>
          )}
        </>
      );
  }
}

function JsonBlock({ json }: { json: { text: string; truncated: boolean } }) {
  return (
    <pre className="structured-preview__json nodrag nowheel">{json.truncated ? `${json.text}\n…` : json.text}</pre>
  );
}

function MediaStrip({ media, urls, more }: { media: 'image' | 'video' | 'audio'; urls: string[]; more: number }) {
  if (media === 'audio') {
    return (
      <div className="structured-preview__audio">
        {urls.slice(0, 3).map((url) => (
          <audio key={url} src={backendAssetUrlSync(url)} controls preload="none"
            className="nodrag nowheel" onMouseDown={(event) => event.stopPropagation()} />
        ))}
        {more + Math.max(0, urls.length - 3) > 0 && (
          <span className="structured-preview__note">+{more + Math.max(0, urls.length - 3)} more</span>
        )}
      </div>
    );
  }
  return (
    <div className={`structured-preview__thumbs structured-preview__thumbs--${Math.min(urls.length, 4)}`}>
      {urls.map((url, index) => (
        <span key={`${url}-${index}`} className="structured-preview__thumb">
          {media === 'image'
            ? <OverviewImage src={backendAssetUrlSync(url)} alt={`Item ${index + 1}`} loading="lazy" draggable={false} />
            : <video src={backendAssetUrlSync(url)} muted preload="metadata" aria-label={`Video ${index + 1}`} />}
          {more > 0 && index === urls.length - 1 && (
            <span className="structured-preview__thumb-more" aria-label={`${more} more`}>+{more}</span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * Every value of a run that nothing else on the card drew. A card shows the
 * first few; the Inspector (`full`) shows them all.
 */
export function StructuredOutputs({ outputs, variant = 'card', labels }: {
  outputs: Array<[string, PortValue]>;
  variant?: StructuredVariant;
  labels?: Record<string, string>;
}) {
  const limit = variant === 'card' ? 3 : 12;
  const shown = outputs.slice(0, limit);
  const several = outputs.length > 1;
  return (
    <div className={`structured-outputs structured-outputs--${variant}`}>
      {shown.map(([port, output]) => (
        <StructuredValuePreview key={port} output={output} variant={variant}
          label={several ? labels?.[port] ?? port : undefined} />
      ))}
      {outputs.length > shown.length && (
        <p className="structured-preview__note">{plural(outputs.length - shown.length, 'more output')}</p>
      )}
    </div>
  );
}
