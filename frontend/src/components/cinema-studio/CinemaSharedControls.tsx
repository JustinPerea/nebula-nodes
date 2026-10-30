import { useId, useRef } from 'react';
import { backendAssetUrlSync } from '../../lib/backend';
import { cinemaLookLabel, defaultCinemaLook, defaultCinemaPalette } from '../../lib/cinemaArtDirection';
import { attachCinemaReferences, removeCinemaReferenceUpload, retryCinemaReferenceUpload } from '../../lib/cinemaUploads';
import { useCinemaUploadStore } from '../../store/cinemaUploadStore';
import { shortLine } from '../../lib/errorCopy';
import { normalizeCinemaScene } from '../../lib/cinemaScene';
import type { CinemaSceneSpec } from '../../types';
import { CinemaLookControls, CinemaPaletteControls } from './CinemaArtDirectionControls';
import { lockedAction, useCanvasLock } from '../../lib/canvasLock';

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

export function CinemaSharedControls({ cinemaNodeId, scene: given, connectedRefs = [], onChange }: CinemaSharedControlsProps) {
  // Read through the defaults, so a scene saved without its base still shows
  // (PR #198 review 2, M2).
  const scene = normalizeCinemaScene(given);
  // Round 23 (review 22, L-3): the scene's settings edit the canvas: the lock.
  const lock = useCanvasLock();
  const controlId = useId();
  const refInputRef = useRef<HTMLInputElement>(null);
  const uploads = useCinemaUploadStore((state) => state.uploads);
  const characterUploads = uploads.filter((upload) => upload.nodeId === cinemaNodeId && upload.shotId === undefined);
  const palette = scene.palette ?? defaultCinemaPalette();
  const look = scene.look ?? defaultCinemaLook();
  const characterRefs = scene.character?.refImageUrls ?? [];
  const attachedRefCount = characterRefs.length;
  const refCount = attachedRefCount + connectedRefs.length;
  const model = BASE_MODELS.find((candidate) => candidate.id === scene.base.model);
  const paletteCount = scene.palette?.swatches.length ?? 0;

  const setBase = (nextModel: string) => onChange((current) => ({ ...current, base: { ...current.base, model: nextModel } }));
  const setAspect = (aspectRatio: string) => onChange((current) => ({ ...current, aspectRatio }));
  const setPalette = (update: (current: NonNullable<CinemaSceneSpec['palette']>) => NonNullable<CinemaSceneSpec['palette']>) =>
    onChange((current) => ({ ...current, palette: update(current.palette ?? defaultCinemaPalette()) }));
  const setLook = (update: (current: NonNullable<CinemaSceneSpec['look']>) => NonNullable<CinemaSceneSpec['look']>) =>
    onChange((current) => ({ ...current, look: update(current.look ?? defaultCinemaLook()) }));

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
    <div className="cinema-scene-settings-group">
      <details className="cinema-scene-settings">
        <summary className="cinema-scene-settings__summary">
          <span className="cinema-scene-settings__title">Scene settings</span>
          <span className="cinema-scene-settings__overview">
            <span>{model?.label ?? scene.base.model}</span>
            <span>{scene.aspectRatio}</span>
            <span>{cinemaLookLabel(scene.look)}</span>
            <span>{paletteCount ? `${paletteCount} palette ${paletteCount === 1 ? 'color' : 'colors'}` : 'No palette'}</span>
            <span>{refCount ? `${refCount} character ${refCount === 1 ? 'reference' : 'references'}` : 'No character references'}</span>
          </span>
        </summary>
        <div className="cinema-shared-controls cinema-scene-settings__body">
          {/* Every setting here writes the scene, so one fieldset locks them
              offline (GM - Design, PR #198 round 5) and while following an
              agent's switch (the canvas lock, #195 round 23). */}
          <fieldset className="cinema-offline-lock" disabled={lock.locked} {...lock.mark}
            title={lockedAction(lock).title}>
          <section className="cinema-shared-controls__section">
            <label htmlFor={`${controlId}-model`} className="cinema-shared-controls__label">Base model</label>
            <select id={`${controlId}-model`} className="cinema-shared-controls__select" value={scene.base.model}
              onChange={(event) => setBase(event.target.value)} {...lock.act({ offline: true })}>
              {!model && <option value={scene.base.model}>{scene.base.model || 'No model selected'}</option>}
              {BASE_MODELS.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.label}</option>)}
            </select>
          </section>

          <section className="cinema-shared-controls__section">
            <label htmlFor={`${controlId}-aspect`} className="cinema-shared-controls__label">Aspect ratio</label>
            <select id={`${controlId}-aspect`} className="cinema-shared-controls__select" value={scene.aspectRatio}
              onChange={(event) => setAspect(event.target.value)} {...lock.act({ offline: true })}>
              {!ASPECT_RATIOS.includes(scene.aspectRatio) && <option value={scene.aspectRatio}>{scene.aspectRatio || 'No aspect ratio selected'}</option>}
              {ASPECT_RATIOS.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
            </select>
          </section>

          <section className="cinema-shared-controls__section cinema-shared-controls__section--wide">
            <span className="cinema-shared-controls__label">Character references</span>
            <div className="cinema-shared-controls__refs">
              {connectedRefs.map((url, index) => (
                <div key={`linked-${url}-${index}`} className="cinema-shared-controls__ref cinema-shared-controls__ref--linked"
                  title="Connected from the canvas — disconnect on the canvas to remove">
                  <img src={backendAssetUrlSync(url)} alt={`Connected character reference ${index + 1}`} draggable={false} />
                  <span className="cinema-shared-controls__ref-link" aria-label="Connected on canvas">🔗</span>
                </div>
              ))}
              {characterRefs.map((url, index) => (
                <div key={`${url}-${index}`} className="cinema-shared-controls__ref">
                  <img src={backendAssetUrlSync(url)} alt={`Character reference ${index + 1}`} draggable={false} />
                  <button type="button" className="cinema-shared-controls__ref-remove" {...lockedAction(lock, { title: 'Remove reference' })}
                    aria-label={`Remove character reference ${index + 1}`} onClick={() => removeCharacterRef(url)}>×</button>
                </div>
              ))}
              <button type="button" className="cinema-shared-controls__ref-add" onClick={() => refInputRef.current?.click()}
                aria-label="Attach character references" {...lock.act({ offline: true })}>+</button>
              <input ref={refInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp"
                // Its + takes the lock; the field itself too, so nothing opens it while locked (review 2 L-5).
                aria-label="Character reference images" multiple hidden disabled={lock.locked} onChange={(event) => {
                  handleFiles(event.target.files);
                  event.target.value = '';
                }} />
            </div>
          </section>

          <section className="cinema-shared-controls__section cinema-shared-controls__section--wide">
            <span className="cinema-shared-controls__label">Palette</span>
            <CinemaPaletteControls value={palette} onChange={setPalette} labelPrefix="Scene" />
          </section>
          <section className="cinema-shared-controls__section cinema-shared-controls__section--wide">
            <span className="cinema-shared-controls__label">Film look</span>
            <CinemaLookControls value={look} onChange={setLook} labelPrefix="Scene" />
          </section>
          </fieldset>
        </div>
      </details>

      {/* Upload ownership and recovery remain reachable with settings collapsed. */}
      {characterUploads.length > 0 && (
        <div className="cinema-reference-uploads" aria-label="Character reference uploads">
          {characterUploads.map((upload) => (
            <div key={upload.id} className="cinema-reference-upload" aria-busy={upload.status === 'uploading'}>
              <span className="cinema-reference-upload__name">{upload.name}</span>
              <span className="cinema-reference-upload__status" role={upload.status === 'error' ? 'alert' : 'status'}>
                {/* GM's WRAP rule: with Retry shown, the reason drops its own "try again". */}
                {upload.status === 'uploading' ? 'Uploading…'
                  : upload.canRetry ? shortLine(upload.error ?? "Couldn't upload this image.")
                    : upload.error ?? "Couldn't upload this image."}
              </span>
              <div className="cinema-reference-upload__actions">
                {upload.status === 'error' && upload.canRetry && (
                  <button type="button" className="cinema-reference-upload__retry" onClick={() => retryCinemaReferenceUpload(upload.id)} aria-label={`Retry ${upload.name}`}
                    {...lockedAction(lock, { offline: true })}>Retry</button>
                )}
                <button type="button" className="cinema-upload__remove" onClick={() => removeCinemaReferenceUpload(upload.id)} aria-label={`Remove upload ${upload.name}`}>Remove</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
