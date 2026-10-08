import { useRef } from 'react';
import { backendAssetUrlSync } from '../../lib/backend';
import { attachCinemaReferences, removeCinemaReferenceUpload, retryCinemaReferenceUpload } from '../../lib/cinemaUploads';
import { useCinemaUploadStore } from '../../store/cinemaUploadStore';
import type { CinemaSceneSpec } from '../../types';

interface CinemaSharedControlsProps {
  cinemaNodeId: string;
  scene: CinemaSceneSpec;
  /** Character refs wired into the node's `character_refs` port on the canvas.
   *  Shown read-only here (disconnect on the canvas to remove) so the Studio and
   *  the node view stay in sync. */
  connectedRefs?: string[];
  onChange: (update: (current: CinemaSceneSpec) => CinemaSceneSpec) => void;
}

/** Edit-capable base models the storyboard supports. Reference-edit identity is
 *  achieved purely by conditioning these models on the shared character refs
 *  (spec §2.3 / §5.3) — never FLUX.1-dev (license guard, spec §10). */
const BASE_MODELS: Array<{ id: string; label: string }> = [
  { id: 'seedream-4-5', label: 'Seedream 4.5' },
  { id: 'nano-banana', label: 'Nano Banana (Google)' },
  { id: 'nano-banana-fal-edit', label: 'Nano Banana Edit (FAL)' },
  { id: 'flux-kontext', label: 'FLUX Kontext' },
];

const ASPECT_RATIOS = ['16:9', '2.39:1', '4:5', '1:1', '9:16'];

/** Named look presets — must match cinema-look's PRESETS keys (spec §4.2). */
const LOOK_PRESETS: Array<{ id: string; label: string }> = [
  { id: 'custom', label: 'Custom' },
  { id: 'kodak-portra', label: 'Kodak Portra' },
  { id: 'fuji-400h', label: 'Fuji 400H' },
  { id: 'cinestill-800t', label: 'CineStill 800T' },
  { id: 'bw-tri-x', label: 'B&W Tri-X' },
  { id: 'teal-orange', label: 'Teal & Orange' },
];

const LOOK_SLIDERS: Array<{ key: keyof NonNullable<CinemaSceneSpec['look']>; label: string; min: number; max: number }> = [
  { key: 'grain', label: 'Grain', min: 0, max: 1 },
  { key: 'halation', label: 'Halation', min: 0, max: 1 },
  { key: 'vignette', label: 'Vignette', min: 0, max: 1 },
  { key: 'contrast', label: 'Contrast', min: -1, max: 1 },
  { key: 'saturation', label: 'Saturation', min: -1, max: 1 },
  { key: 'temperature', label: 'Temperature', min: -1, max: 1 },
];

function defaultLook(): NonNullable<CinemaSceneSpec['look']> {
  return { preset: 'custom', grain: 0.2, halation: 0.2, vignette: 0.25, contrast: 0, saturation: 0, temperature: 0 };
}

function defaultPalette(): NonNullable<CinemaSceneSpec['palette']> {
  return { swatches: [], strength: 0.7, method: 'lab-transfer' };
}

function normalizeHex(input: string): string | null {
  let v = input.trim().toLowerCase();
  if (!v) return null;
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

export function CinemaSharedControls({ cinemaNodeId, scene, connectedRefs = [], onChange }: CinemaSharedControlsProps) {
  const refInputRef = useRef<HTMLInputElement>(null);
  const uploads = useCinemaUploadStore((state) => state.uploads);
  const characterUploads = uploads.filter((upload) => upload.nodeId === cinemaNodeId && upload.shotId === undefined);

  const palette = scene.palette ?? defaultPalette();
  const look = scene.look ?? defaultLook();
  const characterRefs = scene.character?.refImageUrls ?? [];

  const setBase = (model: string) => onChange((current) => ({ ...current, base: { ...current.base, model } }));
  const setAspect = (aspectRatio: string) => onChange((current) => ({ ...current, aspectRatio }));

  const setPalette = (next: Partial<NonNullable<CinemaSceneSpec['palette']>>) =>
    onChange((current) => ({ ...current, palette: { ...defaultPalette(), ...current.palette, ...next } }));
  const setLook = (next: Partial<NonNullable<CinemaSceneSpec['look']>>) =>
    onChange((current) => ({ ...current, look: { ...defaultLook(), ...current.look, ...next } }));
  // Selecting a named preset drops the neutral default sliders: the backend lets
  // explicit float values override a preset, so carrying the editor's defaults
  // (grain 0.2 / contrast 0 / temperature 0 …) would flatten the preset's grade
  // back to a plain darken. 'custom' restores the editable sliders.
  const selectPreset = (id: string) =>
    onChange((current) => ({
      ...current,
      look: id === 'custom' ? { ...defaultLook(), ...current.look, preset: 'custom' } : { preset: id },
    }));

  const setSwatches = (update: (current: string[]) => string[]) =>
    onChange((current) => ({
      ...current,
      palette: { ...defaultPalette(), ...current.palette, swatches: update(current.palette?.swatches ?? []) },
    }));

  const removeCharacterRef = (url: string) => {
    onChange((current) => {
      const character = current.character;
      if (!character?.refImageUrls.includes(url)) return current;
      const next = character.refImageUrls.filter((ref) => ref !== url);
      return {
        ...current,
        character: next.length || character.sheetUrl ? { ...character, refImageUrls: next } : undefined,
      };
    });
  };

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    attachCinemaReferences(cinemaNodeId, undefined, Array.from(files));
  };

  return (
    <div className="cinema-shared-controls">
      {/* Base model picker */}
      <section className="cinema-shared-controls__section">
        <label className="cinema-shared-controls__label">Base model</label>
        <select
          className="cinema-shared-controls__select"
          value={scene.base.model}
          onChange={(e) => setBase(e.target.value)}
        >
          {BASE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </section>

      {/* Aspect ratio */}
      <section className="cinema-shared-controls__section">
        <label className="cinema-shared-controls__label">Aspect</label>
        <select
          className="cinema-shared-controls__select"
          value={scene.aspectRatio}
          onChange={(e) => setAspect(e.target.value)}
        >
          {ASPECT_RATIOS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
      </section>

      {/* Character refs dropzone (multi-image) */}
      <section className="cinema-shared-controls__section cinema-shared-controls__section--wide">
        <label className="cinema-shared-controls__label">Character refs</label>
        <div className="cinema-shared-controls__refs">
          {connectedRefs.map((url, idx) => (
            <div
              key={`linked-${url}-${idx}`}
              className="cinema-shared-controls__ref cinema-shared-controls__ref--linked"
              title="Connected from the canvas — disconnect on the canvas to remove"
            >
              <img src={backendAssetUrlSync(url)} alt="" draggable={false} />
              <span className="cinema-shared-controls__ref-link" aria-label="Connected on canvas">🔗</span>
            </div>
          ))}
          {characterRefs.map((url, idx) => (
            <div key={`${url}-${idx}`} className="cinema-shared-controls__ref">
              <img src={backendAssetUrlSync(url)} alt="" draggable={false} />
              <button
                type="button"
                className="cinema-shared-controls__ref-remove"
                title="Remove reference"
                aria-label={`Remove character reference ${idx + 1}`}
                onClick={() => removeCharacterRef(url)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="cinema-shared-controls__ref-add"
            onClick={() => refInputRef.current?.click()}
            aria-label="Attach character references"
          >
            +
          </button>
          <input
            ref={refInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            aria-label="Character reference images"
            multiple
            hidden
            onChange={(e) => {
              handleFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
        {characterUploads.length > 0 && (
          <div className="cinema-reference-uploads" aria-label="Character reference uploads">
            {characterUploads.map((upload) => (
              <div key={upload.id} className="cinema-reference-upload" aria-busy={upload.status === 'uploading'}>
                <span className="cinema-reference-upload__name">{upload.name}</span>
                <span className="cinema-reference-upload__status" role={upload.status === 'error' ? 'alert' : 'status'}>
                  {upload.status === 'uploading' ? 'Uploading…' : upload.error ?? 'Could not upload this image.'}
                </span>
                <div className="cinema-reference-upload__actions">
                  {upload.status === 'error' && upload.canRetry && (
                    <button type="button" onClick={() => retryCinemaReferenceUpload(upload.id)} aria-label={`Retry ${upload.name}`}>Retry</button>
                  )}
                  <button type="button" onClick={() => removeCinemaReferenceUpload(upload.id)} aria-label={`Remove upload ${upload.name}`}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Palette swatches */}
      <section className="cinema-shared-controls__section cinema-shared-controls__section--wide">
        <label className="cinema-shared-controls__label">Palette</label>
        <div className="cinema-shared-controls__swatches">
          {palette.swatches.map((hex, idx) => {
            const safe = normalizeHex(hex) ?? '#000000';
            return (
              <div key={idx} className="cinema-shared-controls__swatch">
                <input
                  type="color"
                  value={safe}
                  aria-label={`Swatch ${idx + 1}`}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSwatches((swatches) => swatches.map((swatch, i) => i === idx ? value : swatch));
                  }}
                />
                <button
                  type="button"
                  className="cinema-shared-controls__swatch-remove"
                  title="Remove swatch"
                  onClick={() => setSwatches((swatches) => swatches.filter((_, i) => i !== idx))}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="cinema-shared-controls__swatch-add"
            title="Add swatch"
            onClick={() => setSwatches((swatches) => [...swatches, '#808080'])}
          >
            +
          </button>
        </div>
        <div className="cinema-shared-controls__inline">
          <span className="cinema-shared-controls__sub">Strength</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={palette.strength}
            onChange={(e) => setPalette({ strength: Number(e.target.value) })}
          />
          <select
            className="cinema-shared-controls__select cinema-shared-controls__select--sm"
            value={palette.method}
            onChange={(e) => setPalette({ method: e.target.value as NonNullable<CinemaSceneSpec['palette']>['method'] })}
          >
            <option value="lab-transfer">Lab</option>
            <option value="reinhard">Reinhard</option>
            <option value="histogram">Histogram</option>
          </select>
        </div>
      </section>

      {/* Film look — preset chips + sliders */}
      <section className="cinema-shared-controls__section cinema-shared-controls__section--wide">
        <label className="cinema-shared-controls__label">Film look</label>
        <div className="cinema-shared-controls__chips">
          {LOOK_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`cinema-shared-controls__chip ${look.preset === p.id ? 'cinema-shared-controls__chip--active' : ''}`}
              onClick={() => selectPreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        {look.preset === 'custom' && (
          <div className="cinema-shared-controls__sliders">
            {LOOK_SLIDERS.map((s) => (
              <div key={s.key} className="cinema-shared-controls__slider-row">
                <span className="cinema-shared-controls__sub">{s.label}</span>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={0.05}
                  value={Number(look[s.key] ?? 0)}
                  onChange={(e) => setLook({ [s.key]: Number(e.target.value) } as Partial<NonNullable<CinemaSceneSpec['look']>>)}
                />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
