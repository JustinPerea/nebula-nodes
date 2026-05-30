import { useRef, useState } from 'react';
import { apiFetch, backendAssetUrlSync } from '../../lib/backend';
import type { CinemaSceneSpec } from '../../types';

interface CinemaSharedControlsProps {
  scene: CinemaSceneSpec;
  onChange: (next: CinemaSceneSpec) => void;
}

/** Edit-capable base models the storyboard supports. Reference-edit identity is
 *  achieved purely by conditioning these models on the shared character refs
 *  (spec §2.3 / §5.3) — never FLUX.1-dev (license guard, spec §10). */
const BASE_MODELS: Array<{ id: string; label: string }> = [
  { id: 'seedream-4-5', label: 'Seedream 4.5' },
  { id: 'nano-banana', label: 'Nano Banana' },
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

function normalizeHex(input: string): string | null {
  let v = input.trim().toLowerCase();
  if (!v) return null;
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

export function CinemaSharedControls({ scene, onChange }: CinemaSharedControlsProps) {
  const refInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const palette = scene.palette ?? { swatches: [], strength: 0.7, method: 'lab-transfer' as const };
  const look = scene.look ?? defaultLook();
  const characterRefs = scene.character?.refImageUrls ?? [];

  const setBase = (model: string) => onChange({ ...scene, base: { ...scene.base, model } });
  const setAspect = (aspectRatio: string) => onChange({ ...scene, aspectRatio });

  const setPalette = (next: Partial<NonNullable<CinemaSceneSpec['palette']>>) =>
    onChange({ ...scene, palette: { ...palette, ...next } });
  const setLook = (next: Partial<NonNullable<CinemaSceneSpec['look']>>) =>
    onChange({ ...scene, look: { ...look, ...next } });

  const setSwatches = (swatches: string[]) => setPalette({ swatches });

  const addCharacterRefs = (urls: string[]) => {
    const merged = [...characterRefs, ...urls];
    onChange({
      ...scene,
      character: {
        refImageUrls: merged,
        strength: scene.character?.strength ?? 0.8,
        sheetUrl: scene.character?.sheetUrl,
      },
    });
  };

  const removeCharacterRef = (idx: number) => {
    const next = characterRefs.filter((_, i) => i !== idx);
    onChange({
      ...scene,
      character: next.length
        ? { refImageUrls: next, strength: scene.character?.strength ?? 0.8, sheetUrl: scene.character?.sheetUrl }
        : undefined,
    });
  };

  // Multi-image upload via the existing /api/uploads endpoint (spec §8). Each
  // file is posted independently; the server returns { filePath, url }.
  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const uploads = Array.from(files).map((file) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiFetch('/api/uploads', { method: 'POST', body: fd })
        .then((r) => r.json())
        .then((data: { filePath: string; url: string }) => data.url);
    });
    Promise.all(uploads)
      .then((urls) => addCharacterRefs(urls.filter(Boolean)))
      .catch((err) => console.error('[cinema] character ref upload failed:', err))
      .finally(() => setUploading(false));
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
          {characterRefs.map((url, idx) => (
            <div key={`${url}-${idx}`} className="cinema-shared-controls__ref">
              <img src={backendAssetUrlSync(url)} alt="" draggable={false} />
              <button
                type="button"
                className="cinema-shared-controls__ref-remove"
                title="Remove reference"
                onClick={() => removeCharacterRef(idx)}
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="cinema-shared-controls__ref-add"
            onClick={() => refInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? '…' : '+'}
          </button>
          <input
            ref={refInputRef}
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
                    const next = [...palette.swatches];
                    next[idx] = e.target.value;
                    setSwatches(next);
                  }}
                />
                <button
                  type="button"
                  className="cinema-shared-controls__swatch-remove"
                  title="Remove swatch"
                  onClick={() => setSwatches(palette.swatches.filter((_, i) => i !== idx))}
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
            onClick={() => setSwatches([...palette.swatches, '#808080'])}
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
              onClick={() => setLook({ preset: p.id })}
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
