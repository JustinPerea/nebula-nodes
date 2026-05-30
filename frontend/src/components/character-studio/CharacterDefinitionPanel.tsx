import { useRef, useState } from 'react';
import { apiFetch, backendAssetUrlSync } from '../../lib/backend';
import type { CharacterDraft } from './CharacterStudioView';

interface CharacterDefinitionPanelProps {
  draft: CharacterDraft;
  /** Resolved thumbnail (= referenceViews[0] or the server's auto-pick). */
  thumbnail: string;
  onChange: (next: CharacterDraft) => void;
}

const SUBJECT_TYPES: Array<{ id: CharacterDraft['subjectType']; label: string }> = [
  { id: 'human', label: 'Human' },
  { id: 'non-human', label: 'Non-human' },
  { id: 'stylized', label: 'Stylized' },
];

/** The Character definition form (spec §4.5): name, subjectType, the multi-view
 *  reference bundle (≥3 required), the verbatim frozenTraitString, seed, and the
 *  consistencyStrength slider. Mirrors CinemaSharedControls for the /api/uploads
 *  multi-image uploader.
 *
 *  Verbatim contract (spec §6): the UI never reorders referenceViews or
 *  transforms frozenTraitString — appended uploads keep insertion order and the
 *  trait string is stored exactly as typed. */
export function CharacterDefinitionPanel({
  draft,
  thumbnail,
  onChange,
}: CharacterDefinitionPanelProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const addReferenceViews = (urls: string[]) => {
    if (urls.length === 0) return;
    onChange({ ...draft, referenceViews: [...draft.referenceViews, ...urls] });
  };

  const removeReferenceView = (idx: number) => {
    onChange({
      ...draft,
      referenceViews: draft.referenceViews.filter((_, i) => i !== idx),
    });
  };

  // Multi-image upload via the existing /api/uploads endpoint (mirrors
  // CinemaSharedControls.handleFiles). Each file is posted independently; the
  // server returns { filePath, url }. Insertion order is preserved.
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadError(null);
    const uploads = Array.from(files).map((file) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiFetch('/api/uploads', { method: 'POST', body: fd })
        .then((r) => {
          if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
          return r.json();
        })
        .then((data: { filePath: string; url: string }) => data.url);
    });
    Promise.all(uploads)
      .then((urls) => addReferenceViews(urls.filter(Boolean)))
      .catch((err) => {
        console.error('[character] reference view upload failed:', err);
        setUploadError('Upload failed — retry.');
      })
      .finally(() => setUploading(false));
  };

  return (
    <div className="character-def">
      <section className="character-def__head">
        <div className="character-def__thumb">
          {thumbnail ? (
            <img src={backendAssetUrlSync(thumbnail)} alt="" draggable={false} />
          ) : (
            <span className="character-def__thumb-empty">no thumbnail</span>
          )}
        </div>
        <div className="character-def__head-fields">
          <label className="character-def__field">
            <span className="character-def__label">Name</span>
            <input
              type="text"
              className="character-def__input"
              placeholder="e.g. Captain Vega"
              value={draft.name}
              onChange={(e) => onChange({ ...draft, name: e.target.value })}
            />
          </label>
          <label className="character-def__field">
            <span className="character-def__label">Subject type</span>
            <select
              className="character-def__select"
              value={draft.subjectType}
              onChange={(e) =>
                onChange({
                  ...draft,
                  subjectType: e.target.value as CharacterDraft['subjectType'],
                })
              }
            >
              {SUBJECT_TYPES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      {/* Multi-view reference bundle — ≥3 required. Thumbnail auto-picks the
          first view, so order matters; we never reorder it. */}
      <section className="character-def__section">
        <div className="character-def__section-head">
          <span className="character-def__label">
            Reference views ({draft.referenceViews.length})
          </span>
          <span className="character-def__hint">≥3 required · first view = thumbnail</span>
        </div>
        <div className="character-def__refs">
          {draft.referenceViews.map((url, idx) => (
            <div key={`${url}-${idx}`} className="character-def__ref">
              <img src={backendAssetUrlSync(url)} alt="" draggable={false} />
              {idx === 0 && <span className="character-def__ref-badge">cover</span>}
              <button
                type="button"
                className="character-def__ref-remove"
                title="Remove view"
                aria-label="Remove reference view"
                onClick={() => removeReferenceView(idx)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="character-def__ref-add"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            title="Add reference views"
          >
            {uploading ? '…' : '+'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        {uploadError && (
          <span className="character-def__error">{uploadError}</span>
        )}
      </section>

      {/* frozenTraitString — re-emitted VERBATIM into prompts. Labeled clearly
          so the user understands paraphrasing it breaks identity. */}
      <section className="character-def__section">
        <label className="character-def__field">
          <span className="character-def__label">Frozen trait string</span>
          <span className="character-def__hint">
            Re-emitted verbatim into every prompt — paraphrasing breaks identity.
            Write it once, exactly as the model should read it.
          </span>
          <textarea
            className="character-def__textarea"
            rows={4}
            placeholder="e.g. a tall woman, copper-red undercut, hexagonal scar over left brow, matte-black flight jacket…"
            value={draft.frozenTraitString}
            onChange={(e) =>
              onChange({ ...draft, frozenTraitString: e.target.value })
            }
          />
        </label>
      </section>

      {/* Seed + consistency strength */}
      <section className="character-def__section character-def__section--row">
        <label className="character-def__field character-def__field--narrow">
          <span className="character-def__label">Seed</span>
          <input
            type="number"
            className="character-def__input"
            value={draft.seed}
            onChange={(e) =>
              onChange({ ...draft, seed: Math.trunc(Number(e.target.value)) || 0 })
            }
          />
        </label>
        <label className="character-def__field character-def__field--grow">
          <span className="character-def__label">
            Consistency strength · {draft.consistencyStrength.toFixed(2)}
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={draft.consistencyStrength}
            onChange={(e) =>
              onChange({
                ...draft,
                consistencyStrength: Number(e.target.value),
              })
            }
          />
        </label>
      </section>
    </div>
  );
}
