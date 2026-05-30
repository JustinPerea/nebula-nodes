import { useEffect, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { CinemaStudioToolbar } from './CinemaStudioToolbar';
import { CinemaSharedControls } from './CinemaSharedControls';
import { CinemaShotsRail } from './CinemaShotsRail';
import { CinemaShotPanel } from './CinemaShotPanel';
import type { CinemaSceneSpec, CinemaShot } from '../../types';
import '../../styles/cinema-studio.css';

/** A minimal valid scene for a node that has none yet (e.g. dragged from the
 *  library before the Studio seeded it). License guard (spec §10): the default
 *  base must be commercial-OK — never FLUX.1-dev. Mirrors graphStore's
 *  createDefaultScene so the editor and store agree on the empty shape. */
function emptyScene(): CinemaSceneSpec {
  return {
    version: 1,
    base: { model: 'seedream-4-5' },
    aspectRatio: '16:9',
    shots: [],
  };
}

/** Full-screen Cinema Studio host. Mounted by App.tsx when uiStore
 *  .cinemaEditorNodeId is set — mirrors RemotionEditorView's mount pattern.
 *  Reads the target node's data.params.scene; every edit routes back through
 *  graphStore.updateScene (optimistic store + cli_graph round-trip). */
export function CinemaStudioView() {
  const cinemaNodeId = useUIStore((s) => s.cinemaEditorNodeId);
  const exitCinemaEditor = useUIStore((s) => s.exitCinemaEditor);
  const node = useGraphStore((s) =>
    cinemaNodeId ? s.nodes.find((n) => n.id === cinemaNodeId) : null,
  );
  const updateScene = useGraphStore((s) => s.updateScene);
  const addShot = useGraphStore((s) => s.addShot);
  const removeShot = useGraphStore((s) => s.removeShot);

  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);

  const scene: CinemaSceneSpec =
    (node?.data as { params?: { scene?: CinemaSceneSpec } } | undefined)?.params?.scene ?? emptyScene();

  // Keep a valid selection: prefer the existing one, else the first shot. Runs
  // after render to avoid setState-during-render; declared before any early
  // return to satisfy the Rules of Hooks.
  useEffect(() => {
    if (!cinemaNodeId) return;
    const ids = scene.shots.map((s) => s.id);
    if (selectedShotId && ids.includes(selectedShotId)) return;
    setSelectedShotId(ids[0] ?? null);
  }, [cinemaNodeId, scene.shots, selectedShotId]);

  if (!cinemaNodeId || !node) {
    return (
      <div className="cinema-studio-view">
        <div className="cinema-studio-view__empty">
          No cinema-scene node selected.{' '}
          <button type="button" onClick={exitCinemaEditor}>
            Back to canvas
          </button>
        </div>
      </div>
    );
  }

  const selectedShot = scene.shots.find((s) => s.id === selectedShotId) ?? null;

  const handleAddShot = () => {
    const id = addShot(cinemaNodeId);
    if (id) setSelectedShotId(id);
  };

  const handleRemoveShot = (shotId: string) => {
    removeShot(cinemaNodeId, shotId);
    if (selectedShotId === shotId) setSelectedShotId(null);
  };

  const handleReorder = (shots: CinemaShot[]) => {
    updateScene(cinemaNodeId, { ...scene, shots });
  };

  const handleChangeShot = (next: CinemaShot) => {
    updateScene(cinemaNodeId, {
      ...scene,
      shots: scene.shots.map((s) => (s.id === next.id ? next : s)),
    });
  };

  return (
    <div className="cinema-studio-view">
      <header className="cinema-studio-view__header">
        <CinemaStudioToolbar cinemaNodeId={cinemaNodeId} />
      </header>

      <div className="cinema-studio-view__shared">
        <CinemaSharedControls
          scene={scene}
          onChange={(next) => updateScene(cinemaNodeId, next)}
        />
      </div>

      <div className="cinema-studio-view__rail">
        <CinemaShotsRail
          scene={scene}
          selectedShotId={selectedShotId}
          onSelect={setSelectedShotId}
          onAddShot={handleAddShot}
          onRemoveShot={handleRemoveShot}
          onReorder={handleReorder}
        />
      </div>

      <div className="cinema-studio-view__panel">
        {selectedShot ? (
          <CinemaShotPanel
            cinemaNodeId={cinemaNodeId}
            scene={scene}
            shot={selectedShot}
            onChangeShot={handleChangeShot}
          />
        ) : (
          <div className="cinema-studio-view__panel-empty">
            Add a shot to begin storyboarding.
          </div>
        )}
      </div>
    </div>
  );
}
