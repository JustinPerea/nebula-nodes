import type { DragEvent as ReactDragEvent } from 'react';
import type { MoodboardAnalysis, MoodboardImage } from '../../types';
import { backendAssetUrlSync } from '../../lib/backend';
import { AutoGrowTextarea } from '../AutoGrowTextarea';
import { ImageColors } from './MoodboardColors';
import { isSetAside, setAsidePatch } from './steering';

// The backend's cap on a private note (services/moodboard_store.py).
export const PRIVATE_NOTE_LIMIT = 2000;

/**
 * The List view: the board's images as a grid of tiles, each with its weight,
 * Set aside and notes. This is Moodboard Studio's grid as it was before the
 * Board view (moodboard canvas PR5), moved here unchanged.
 */
export function MoodboardListView({ images, analysis, uploading, onFiles, onDrop, onRemove, onUpdate, onTextDone }: {
  images: MoodboardImage[];
  analysis: MoodboardAnalysis | null;
  uploading: boolean;
  onFiles: (files: FileList | null) => void;
  onDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: Partial<MoodboardImage>) => void;
  /** A note lost focus: send it now. */
  onTextDone: () => void;
}) {
  return (
    <section
      className={`moodboard-dropzone ${uploading ? 'moodboard-dropzone--busy' : ''}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="moodboard-dropzone__head">
        <div>
          <span className="moodboard-dropzone__label">Images ({images.length})</span>
          <span className="moodboard-dropzone__hint">Drag images here or add files.</span>
        </div>
        <label className={`moodboard-dropzone__file-wrap ${uploading ? 'moodboard-dropzone__file-wrap--disabled' : ''}`}>
          <span className="moodboard-dropzone__file-button">
            {uploading ? 'Uploading' : 'Add Images'}
          </span>
          <input
            className="moodboard-dropzone__file-input"
            type="file"
            accept="image/*"
            multiple
            disabled={uploading}
            aria-label="Add Images"
            onChange={(event) => {
              onFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </label>
      </div>
      <div className="moodboard-grid">
        {images.map((img, index) => (
          <div key={img.id} className={`moodboard-tile ${isSetAside(img) ? 'moodboard-tile--set-aside' : ''}`}>
            <div className="moodboard-tile__image">
              <img src={backendAssetUrlSync(img.url)} alt="" draggable={false} />
              <span className="moodboard-tile__number" aria-label={`Image ${index + 1}`}>#{index + 1}</span>
              <button type="button" className="moodboard-tile__remove" onClick={() => onRemove(img.id)}>
                x
              </button>
            </div>
            <ImageColors analysis={analysis} imageId={img.id} />
            <div className="moodboard-tile__controls">
              <label>
                <span>Weight {img.weight.toFixed(2)}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={img.weight}
                  onChange={(event) => onUpdate(img.id, { weight: Number(event.target.value) })}
                />
              </label>
              <label className="moodboard-tile__toggle" title="Still read for its colors; never steers">
                <input
                  type="checkbox"
                  checked={isSetAside(img)}
                  onChange={(event) => onUpdate(img.id, setAsidePatch(img, event.target.checked))}
                />
                <span>Set aside</span>
              </label>
              <label className="moodboard-tile__note">
                <span>Image note</span>
                <AutoGrowTextarea
                  rows={2}
                  value={img.notes}
                  placeholder="What to take from this image"
                  onChange={(event) => onUpdate(img.id, { notes: event.target.value })}
                  onBlur={onTextDone}
                />
              </label>
              <div className="moodboard-tile__note moodboard-tile__note--private">
                <label className="moodboard-tile__note">
                  <span>Private note</span>
                  <AutoGrowTextarea
                    rows={1}
                    value={img.privateNote ?? ''}
                    maxLength={PRIVATE_NOTE_LIMIT}
                    placeholder="A label for you, like Liked"
                    aria-describedby={`private-note-hint-${img.id}`}
                    onChange={(event) => onUpdate(img.id, { privateNote: event.target.value })}
                    onBlur={onTextDone}
                  />
                </label>
                <span id={`private-note-hint-${img.id}`} className="moodboard-tile__note-hint">
                  Only for you. Not sent anywhere.
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
