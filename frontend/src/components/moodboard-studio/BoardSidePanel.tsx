import { useId, type ReactNode } from 'react';
import type { MoodboardAnalysis, MoodboardImage } from '../../types';
import { backendAssetUrlSync } from '../../lib/backend';
import { overviewThumbnailUrl } from '../../lib/canvasOverview';
import { AutoGrowTextarea } from '../AutoGrowTextarea';
import { ImageColors } from './MoodboardColors';
import { PRIVATE_NOTE_LIMIT } from './MoodboardListView';
import { isSetAside, setAsidePatch } from './steering';

/**
 * The Board view's side panel (moodboard canvas PR5). One reference
 * selected: its notes, colours, Set aside and weight, the same controls as
 * its tile in the List. Several: how many, and Remove. None: the board
 * itself (`children`: its fields, Direction and the brief, the analysis).
 */
export function BoardSidePanel({ images, selected, analysis, onUpdate, onRemove, onTextDone, children }: {
  images: MoodboardImage[];
  /** The selected references' image ids, in board order. */
  selected: string[];
  analysis: MoodboardAnalysis | null;
  onUpdate: (id: string, patch: Partial<MoodboardImage>) => void;
  onRemove: (ids: string[]) => void;
  onTextDone: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const picked = images.flatMap((image, index) => (selected.includes(image.id) ? [{ image, number: index + 1 }] : []));
  const title = picked.length === 0 ? 'Board' : picked.length === 1 ? `Reference #${picked[0].number}`
    : `${picked.length} references`;
  return (
    <aside className="moodboard-board-panel" aria-labelledby={titleId}>
      <div className="moodboard-board-panel__head">
        <h2 id={titleId} className="moodboard-board-panel__title">{title}</h2>
        {picked.length === 1 && <span className="moodboard-board-panel__sub">{referenceLine(picked[0].image)}</span>}
        {picked.length > 1 && (
          <span className="moodboard-board-panel__sub">{picked.map((item) => `#${item.number}`).join(' · ')}</span>
        )}
      </div>
      {picked.length === 0 && children}
      {picked.length === 1 && (
        <Reference image={picked[0].image} analysis={analysis} onUpdate={onUpdate} onTextDone={onTextDone}
          onRemove={() => onRemove([picked[0].image.id])} />
      )}
      {picked.length > 1 && (
        <div className="moodboard-board-panel__section">
          <span className="moodboard-board-panel__hint">Drag any of them to move them together.</span>
          <button type="button" className="moodboard-board-panel__remove"
            onClick={() => onRemove(picked.map((item) => item.image.id))}>Remove {picked.length} references</button>
        </div>
      )}
    </aside>
  );
}

function referenceLine(image: MoodboardImage): string {
  const card = image.placements?.[0];
  const parts = [`w ${image.weight.toFixed(2)}`];
  if (card) parts.push(`${card.w} × ${card.h}`);
  if (isSetAside(image)) parts.push('set aside');
  return parts.join(' · ');
}

function Reference({ image, analysis, onUpdate, onRemove, onTextDone }: {
  image: MoodboardImage;
  analysis: MoodboardAnalysis | null;
  onUpdate: (id: string, patch: Partial<MoodboardImage>) => void;
  onRemove: () => void;
  onTextDone: () => void;
}) {
  const hintId = useId();
  const preview = overviewThumbnailUrl(image.url) ?? image.url;
  return (
    <div className="moodboard-board-panel__section">
      <div className="moodboard-board-panel__image">
        <img src={backendAssetUrlSync(preview)} alt="" draggable={false} />
      </div>
      <ImageColors analysis={analysis} imageId={image.id} />
      <label className="moodboard-field">
        <span>Weight {image.weight.toFixed(2)}</span>
        <input type="range" min={0} max={1} step={0.05} value={image.weight}
          onChange={(event) => onUpdate(image.id, { weight: Number(event.target.value) })} />
      </label>
      <label className="moodboard-board-panel__toggle" title="Still read for its colors; never steers">
        <input type="checkbox" checked={isSetAside(image)}
          onChange={(event) => onUpdate(image.id, setAsidePatch(image, event.target.checked))} />
        <span>Set aside</span>
      </label>
      <label className="moodboard-field">
        <span>Image note</span>
        <AutoGrowTextarea rows={3} value={image.notes} placeholder="What to take from this image"
          onChange={(event) => onUpdate(image.id, { notes: event.target.value })} onBlur={onTextDone} />
      </label>
      <label className="moodboard-field">
        <span>Private note</span>
        <AutoGrowTextarea rows={1} value={image.privateNote ?? ''} maxLength={PRIVATE_NOTE_LIMIT}
          placeholder="A label for you, like Liked" aria-describedby={hintId}
          onChange={(event) => onUpdate(image.id, { privateNote: event.target.value })} onBlur={onTextDone} />
      </label>
      <span id={hintId} className="moodboard-board-panel__hint">Only for you. Not sent anywhere.</span>
      <button type="button" className="moodboard-board-panel__remove" onClick={onRemove}>Remove from board</button>
    </div>
  );
}
