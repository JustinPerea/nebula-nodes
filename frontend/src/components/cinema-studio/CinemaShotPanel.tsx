import { useRef, useState } from 'react';
import { apiFetch, backendAssetUrlSync } from '../../lib/backend';
import { useGraphStore } from '../../store/graphStore';
import { shotPortId } from '../../constants/ports';
import type { CinemaSceneSpec, CinemaShot } from '../../types';

interface CinemaShotPanelProps {
  cinemaNodeId: string;
  scene: CinemaSceneSpec;
  shot: CinemaShot;
  onChangeShot: (next: CinemaShot) => void;
}

/** Motion model the "Send to motion" button targets. veo-3's first-frame input
 *  port is `image` (see nodeDefinitions). Swap to seedance/kling by changing
 *  this pair — both expose an equivalent first-frame Image input. */
const MOTION_TARGET = { definitionId: 'veo-3', firstFramePort: 'image' };

const CLI_ID_RE = /^n\d+$/;

export function CinemaShotPanel({ cinemaNodeId, scene, shot, onChangeShot }: CinemaShotPanelProps) {
  const refInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [sentToMotion, setSentToMotion] = useState(false);

  const executeNode = useGraphStore((s) => s.executeNode);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const addNodeAndConnect = useGraphStore((s) => s.addNodeAndConnect);
  const addNode = useGraphStore((s) => s.addNode);
  const onConnect = useGraphStore((s) => s.onConnect);

  const shotRefs = shot.refImageUrls ?? [];
  const paletteOverridden = shot.overrides?.palette !== undefined;
  const lookOverridden = shot.overrides?.look !== undefined;
  const previewUrl = shot.output?.imageUrl ?? null;
  const status = shot.output?.status ?? 'idle';

  const setPrompt = (prompt: string) => onChangeShot({ ...shot, prompt });

  const togglePaletteOverride = () => {
    const overrides = { ...(shot.overrides ?? {}) };
    if (paletteOverridden) {
      delete overrides.palette;
    } else {
      // Seed the override from the shared palette so the user starts from parity.
      overrides.palette = scene.palette ? { ...scene.palette } : {};
    }
    onChangeShot({ ...shot, overrides: Object.keys(overrides).length ? overrides : undefined });
  };

  const toggleLookOverride = () => {
    const overrides = { ...(shot.overrides ?? {}) };
    if (lookOverridden) {
      delete overrides.look;
    } else {
      overrides.look = scene.look ? { ...scene.look } : {};
    }
    onChangeShot({ ...shot, overrides: Object.keys(overrides).length ? overrides : undefined });
  };

  const addShotRefs = (urls: string[]) =>
    onChangeShot({ ...shot, refImageUrls: [...shotRefs, ...urls] });

  const removeShotRef = (idx: number) => {
    const next = shotRefs.filter((_, i) => i !== idx);
    onChangeShot({ ...shot, refImageUrls: next.length ? next : undefined });
  };

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
      .then((urls) => addShotRefs(urls.filter(Boolean)))
      .catch((err) => console.error('[cinema] shot ref upload failed:', err))
      .finally(() => setUploading(false));
  };

  // Generate flow (spec §8): reuse the existing node-execution pipeline. The
  // editor's edits already wrote the scene (incl. this shot) onto the node via
  // updateScene, so running the cinema-scene node regenerates all shots and the
  // per-shot results stream back into scene.shots[*].output through the same
  // store-update channel that drives ModelNode previews. There is no per-shot
  // backend entrypoint yet, so "Generate shot" runs the whole scene node too;
  // per-shot caching (shot.hash) means unchanged shots are cheap.
  const handleGenerate = () => {
    executeNode(cinemaNodeId);
  };

  // Send to motion (spec §8): create a veo-3 node on the canvas and wire THIS
  // shot's output port into its first-frame Image input. CLI-origin scene nodes
  // use the atomic addNodeAndConnect path (mirrors ConnectionPopup); frontend-
  // only UUID nodes fall back to addNode + local onConnect.
  const handleSendToMotion = async () => {
    const node = useGraphStore.getState().nodes.find((n) => n.id === cinemaNodeId);
    const basePos = node?.position ?? { x: 0, y: 0 };
    const position = { x: basePos.x + 360, y: basePos.y };
    const sourceHandle = shotPortId(shot.id);

    if (CLI_ID_RE.test(cinemaNodeId)) {
      await addNodeAndConnect(MOTION_TARGET.definitionId, position, {
        source: cinemaNodeId,
        sourceHandle,
        target: '',
        targetHandle: MOTION_TARGET.firstFramePort,
        newNodeIs: 'target',
      });
    } else {
      const newId = await addNode(MOTION_TARGET.definitionId, position);
      if (newId) {
        onConnect({
          source: cinemaNodeId,
          sourceHandle,
          target: newId,
          targetHandle: MOTION_TARGET.firstFramePort,
        });
      }
    }
    setSentToMotion(true);
    window.setTimeout(() => setSentToMotion(false), 2500);
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

      {/* Variations strip — placeholder until multi-output is wired. The scene
          handler currently emits a single image per shot; when variations land
          they will populate here from shot.output. */}
      <div className="cinema-shot-panel__variations">
        {previewUrl ? (
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
              onClick={() => removeShotRef(idx)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          className="cinema-shot-panel__ref-add"
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

      <div className="cinema-shot-panel__actions">
        <button
          type="button"
          className="cinema-shot-panel__action cinema-shot-panel__action--primary"
          onClick={handleGenerate}
          disabled={isExecuting}
        >
          {isExecuting ? 'Generating…' : 'Generate shot'}
        </button>
        <button
          type="button"
          className="cinema-shot-panel__action"
          onClick={handleGenerate}
          disabled={isExecuting}
        >
          Generate all
        </button>
        <button
          type="button"
          className="cinema-shot-panel__action"
          onClick={handleSendToMotion}
          title="Create a Veo 3 node wired to this shot's output"
        >
          {sentToMotion ? 'Sent ✓' : 'Send to motion ▸'}
        </button>
      </div>
    </div>
  );
}
