import { useRef, useState } from 'react';
import { backendAssetUrlSync } from '../../lib/backend';
import { attachCinemaReferences, removeCinemaReferenceUpload, retryCinemaReferenceUpload } from '../../lib/cinemaUploads';
import { getCinemaUploadIssue, useCinemaUploadStore } from '../../store/cinemaUploadStore';
import { useGraphStore } from '../../store/graphStore';
import { sendCinemaShotToMotion, viewCinemaMotionNode } from '../../lib/cinemaMotion';
import { useCinemaMotionStore } from '../../store/cinemaMotionStore';
import type { CinemaSceneSpec, CinemaShot } from '../../types';

interface CinemaShotPanelProps {
  cinemaNodeId: string;
  scene: CinemaSceneSpec;
  shot: CinemaShot;
  onChangeShot: (update: (current: CinemaShot) => CinemaShot) => void;
}

export function CinemaShotPanel({ cinemaNodeId, scene, shot, onChangeShot }: CinemaShotPanelProps) {
  const refInputRef = useRef<HTMLInputElement>(null);
  const [variationCount, setVariationCount] = useState(2);

  const executeNode = useGraphStore((s) => s.executeNode);
  const executeShot = useGraphStore((s) => s.executeShot);
  const promoteShotVariation = useGraphStore((s) => s.promoteShotVariation);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const isImportingGraph = useGraphStore((s) => s.isImportingGraph);
  const activeRuns = useGraphStore((s) => s.activeRuns);
  const cancelRun = useGraphStore((s) => s.cancelRun);
  const shotRun = activeRuns.find((run) => run.kind === 'cinema-shot' && run.nodeId === cinemaNodeId && run.shotId === shot.id);
  const overlappingGraph = activeRuns.some((run) => run.kind === 'graph' && run.nodeIds.includes(cinemaNodeId));
  const admissionBlocked = useGraphStore((state) => state.isShotAdmissionBlocked(cinemaNodeId, shot.id));
  const motionHandoff = useCinemaMotionStore((state) => state.handoffs.find((item) => item.nodeId === cinemaNodeId && item.shotId === shot.id));
  const uploads = useCinemaUploadStore((state) => state.uploads);
  const shotUploads = uploads.filter((upload) => upload.nodeId === cinemaNodeId && upload.shotId === shot.id);
  const referenceIssue = getCinemaUploadIssue(cinemaNodeId, shot.id);
  const allReferenceIssue = getCinemaUploadIssue(cinemaNodeId, undefined, true);

  const shotRefs = shot.refImageUrls ?? [];
  const paletteOverridden = shot.overrides?.palette !== undefined;
  const lookOverridden = shot.overrides?.look !== undefined;
  const previewUrl = shot.output?.imageUrl ?? null;
  const status = shot.output?.status ?? 'idle';

  const setPrompt = (prompt: string) => onChangeShot((current) => ({ ...current, prompt }));

  const currentSharedScene = () => (useGraphStore.getState().nodes.find((node) => node.id === cinemaNodeId)
    ?.data.params.scene as CinemaSceneSpec | undefined) ?? scene;

  const togglePaletteOverride = () => {
    onChangeShot((current) => {
      const overrides = { ...(current.overrides ?? {}) };
      if (overrides.palette !== undefined) delete overrides.palette;
      else {
        const palette = currentSharedScene().palette;
        overrides.palette = palette ? structuredClone(palette) : {};
      }
      return { ...current, overrides: Object.keys(overrides).length ? overrides : undefined };
    });
  };

  const toggleLookOverride = () => {
    onChangeShot((current) => {
      const overrides = { ...(current.overrides ?? {}) };
      if (overrides.look !== undefined) delete overrides.look;
      else {
        const look = currentSharedScene().look;
        overrides.look = look ? { ...look } : {};
      }
      return { ...current, overrides: Object.keys(overrides).length ? overrides : undefined };
    });
  };

  const removeShotRef = (url: string) => {
    onChangeShot((current) => {
      const next = (current.refImageUrls ?? []).filter((ref) => ref !== url);
      return { ...current, refImageUrls: next.length ? next : undefined };
    });
  };

  const handleFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    attachCinemaReferences(cinemaNodeId, shot.id, Array.from(files));
  };

  // "Generate shot" regenerates ONLY this shot via the dedicated per-shot
  // entrypoint (POST /api/cinema/generate-shot): the rail spinner scopes to this
  // row and siblings' outputs are untouched. "Generate all" still runs the whole
  // cinema-scene node. Both stream results back into scene.shots[*].output via
  // the same graphSync channel that drives ModelNode previews.
  const shotRunning = Boolean(shotRun) || status === 'running';
  const shotBlocked = shotRunning || overlappingGraph || admissionBlocked || Boolean(referenceIssue);
  const sharedInputsBlocked = admissionBlocked && !shotRunning && !overlappingGraph && !referenceIssue;
  const sharedInputsMessage = isImportingGraph
    ? 'Wait for the graph import to finish.'
    : 'Another run is using shared inputs. Wait for it to finish or stop it.';
  const shotStopping = shotRun?.status === 'cancelling';
  const handleGenerateShot = () => {
    if (getCinemaUploadIssue(cinemaNodeId, shot.id)) return;
    executeShot(cinemaNodeId, shot.id);
  };
  const handleGenerateAll = () => {
    if (getCinemaUploadIssue(cinemaNodeId, undefined, true)) return;
    executeNode(cinemaNodeId);
  };
  // Variations: one base-model run per distinct seed, collected into the strip.
  const handleGenerateVariations = () => {
    if (getCinemaUploadIssue(cinemaNodeId, shot.id)) return;
    executeShot(cinemaNodeId, shot.id, undefined, variationCount);
  };

  return (
    <div className="cinema-shot-panel">
      <div className="cinema-shot-panel__preview">
        {previewUrl ? (
          <img src={backendAssetUrlSync(previewUrl)} alt="" draggable={false} />
        ) : (
          <div className="cinema-shot-panel__preview-empty">
            {status === 'running' ? 'Generating…' : 'No preview yet'}
          </div>
        )}
        {shot.output?.status === 'error' && shot.output.error && (
          <div className="cinema-shot-panel__error">{shot.output.error}</div>
        )}
      </div>

      {/* Variations strip — click a candidate to promote it to canonical. While a
          batch generates, the optimistic 'running' state shows above; the strip
          fills when the batch completes (graphSync). Falls back to the single
          preview when no variations exist yet. */}
      <div className="cinema-shot-panel__variations">
        {shot.variations && shot.variations.length > 0 ? (
          shot.variations.map((v, i) => (
            <button
              key={`${v.seed}-${i}`}
              type="button"
              className={`cinema-shot-panel__variation${shot.selectedVariation === i ? ' cinema-shot-panel__variation--active' : ''}`}
              onClick={() => void promoteShotVariation(cinemaNodeId, shot.id, i)}
              title={`Use variation ${i + 1} (seed ${v.seed})`}
            >
              <img src={backendAssetUrlSync(v.url)} alt={`Variation ${i + 1}`} draggable={false} />
            </button>
          ))
        ) : previewUrl ? (
          <div className="cinema-shot-panel__variation cinema-shot-panel__variation--active">
            <img src={backendAssetUrlSync(previewUrl)} alt="" draggable={false} />
          </div>
        ) : (
          <div className="cinema-shot-panel__variation cinema-shot-panel__variation--empty">—</div>
        )}
      </div>

      <label className="cinema-shot-panel__label">Prompt</label>
      <textarea
        className="cinema-shot-panel__prompt"
        value={shot.prompt}
        placeholder="Describe this shot…"
        onChange={(e) => setPrompt(e.target.value)}
      />

      <label className="cinema-shot-panel__label">Composition refs</label>
      <div className="cinema-shot-panel__refs">
        {shotRefs.map((url, idx) => (
          <div key={`${url}-${idx}`} className="cinema-shot-panel__ref">
            <img src={backendAssetUrlSync(url)} alt="" draggable={false} />
            <button
              type="button"
              className="cinema-shot-panel__ref-remove"
              title="Remove ref"
              aria-label={`Remove composition reference ${idx + 1}`}
              onClick={() => removeShotRef(url)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="cinema-shot-panel__ref-add"
          onClick={() => refInputRef.current?.click()}
          aria-label="Attach composition references"
        >
          +
        </button>
        <input
          ref={refInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          aria-label="Composition reference images"
          multiple
          hidden
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {shotUploads.length > 0 && (
        <div className="cinema-reference-uploads" aria-label="Composition reference uploads">
          {shotUploads.map((upload) => (
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

      <div className="cinema-shot-panel__toggles">
        <label className="cinema-shot-panel__toggle">
          <input type="checkbox" checked={paletteOverridden} onChange={togglePaletteOverride} />
          <span>Override palette</span>
        </label>
        <label className="cinema-shot-panel__toggle">
          <input type="checkbox" checked={lookOverridden} onChange={toggleLookOverride} />
          <span>Override look</span>
        </label>
      </div>

      <div className="cinema-shot-panel__variations-control">
        <span className="cinema-shot-panel__variations-label">Variations</span>
        <div className="cinema-shot-panel__stepper">
          <button
            type="button"
            className="cinema-shot-panel__stepper-btn"
            onClick={() => setVariationCount((c) => Math.max(1, c - 1))}
            disabled={variationCount <= 1 || shotBlocked}
            aria-label="Fewer variations"
          >
            −
          </button>
          <span className="cinema-shot-panel__stepper-value">{variationCount}</span>
          <button
            type="button"
            className="cinema-shot-panel__stepper-btn"
            onClick={() => setVariationCount((c) => Math.min(4, c + 1))}
            disabled={variationCount >= 4 || shotBlocked}
            aria-label="More variations"
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="cinema-shot-panel__action"
          onClick={handleGenerateVariations}
          disabled={shotBlocked}
          title={referenceIssue ?? (sharedInputsBlocked ? sharedInputsMessage : undefined)}
        >
          Generate {variationCount}
        </button>
      </div>

      {sharedInputsBlocked && <div className="cinema-shot-panel__variations-label" role="status">{sharedInputsMessage}</div>}
      {referenceIssue && <div className="cinema-reference-upload__message" role="status">{referenceIssue}</div>}
      {!referenceIssue && allReferenceIssue && <div className="cinema-reference-upload__message" role="status">{allReferenceIssue} Generate all will be available when the other shot’s references are resolved.</div>}

      <div className="cinema-shot-panel__actions">
        <button
          type="button"
          className="cinema-shot-panel__action cinema-shot-panel__action--primary"
          onClick={handleGenerateShot}
          disabled={shotBlocked}
          title={referenceIssue ?? (sharedInputsBlocked ? sharedInputsMessage : undefined)}
        >
          {shotRunning ? 'Generating…' : 'Generate shot'}
        </button>
        {shotRun && (
          <button
            type="button"
            className="cinema-shot-panel__action"
            onClick={() => void cancelRun(shotRun.id)}
            disabled={shotStopping}
            aria-busy={shotStopping}
          >
            {shotStopping ? 'Stopping…' : 'Stop shot'}
          </button>
        )}
        <button
          type="button"
          className="cinema-shot-panel__action"
          onClick={handleGenerateAll}
          disabled={isExecuting || isImportingGraph || Boolean(allReferenceIssue)}
          title={allReferenceIssue ?? undefined}
        >
          Generate all
        </button>
      </div>
      <div className="cinema-shot-panel__motion">
        <button type="button" className="cinema-shot-panel__action"
          onClick={() => motionHandoff?.status === 'ready'
            ? viewCinemaMotionNode(cinemaNodeId, shot.id) : void sendCinemaShotToMotion(cinemaNodeId, shot.id)}
          disabled={isImportingGraph || motionHandoff?.status === 'pending'
            || (motionHandoff?.status !== 'ready' && (shotRunning || status !== 'done' || !previewUrl))}
          aria-busy={motionHandoff?.status === 'pending' || undefined}>
          {motionHandoff?.status === 'ready' ? 'View video node'
            : motionHandoff?.status === 'pending' ? 'Connecting video node…'
              : motionHandoff?.status === 'error' ? 'Retry connection' : 'Send to motion'}
        </button>
        {motionHandoff?.status === 'error' ? (
          <p className="cinema-shot-panel__motion-feedback" role="alert">{motionHandoff.error}</p>
        ) : (
          <p className="cinema-shot-panel__motion-feedback" role={motionHandoff ? 'status' : undefined}>
            {motionHandoff?.status === 'ready' ? 'Video node connected. Open it to set the prompt and generate.'
              : motionHandoff?.status === 'pending' ? 'Connecting this shot to a video node…'
                : !previewUrl || status !== 'done' ? 'Generate a shot before sending it to motion.'
                  : 'Connects this shot to a video node. Generate when you’re ready.'}
          </p>
        )}
      </div>
    </div>
  );
}
