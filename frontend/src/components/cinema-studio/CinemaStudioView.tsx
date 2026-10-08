import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { CinemaStudioToolbar } from './CinemaStudioToolbar';
import { CinemaSharedControls } from './CinemaSharedControls';
import { CinemaShotsRail } from './CinemaShotsRail';
import { CinemaShotPanel } from './CinemaShotPanel';
import { cinemaConnectedInputs, type CinemaConnectedInput } from '../../lib/cinemaInputs';
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
  const edges = useGraphStore((s) => s.edges);
  const nodes = useGraphStore((s) => s.nodes);
  const panelRef = useRef<HTMLDivElement>(null);

  const [selection, setSelection] = useState<{ nodeId: string; shotId: string } | null>(null);
  const selectedShotId = selection?.nodeId === cinemaNodeId ? selection.shotId : null;
  const setSelectedShotId = (shotId: string | null) => setSelection(
    cinemaNodeId && shotId ? { nodeId: cinemaNodeId, shotId } : null,
  );

  const scene: CinemaSceneSpec =
    (node?.data as { params?: { scene?: CinemaSceneSpec } } | undefined)?.params?.scene ?? emptyScene();

  // Derive a valid effective selection during render: keep the stored id when it
  // still refers to a real shot, otherwise fall back to the first shot (or null).
  // Avoids a setState-in-effect cycle — selection validity is purely derived from
  // scene.shots, so it can be computed without a side-effect.
  const shotIds = scene.shots.map((s) => s.id);
  const effectiveShotId = selectedShotId && shotIds.includes(selectedShotId)
    ? selectedShotId
    : (shotIds[0] ?? null);

  useLayoutEffect(() => {
    // A new selected object starts at its prompt/preview. Authoring and output
    // updates keep the user's current scroll position within that same shot.
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [cinemaNodeId, effectiveShotId]);

  const connectedInputs = useMemo(() => cinemaNodeId
    ? cinemaConnectedInputs(cinemaNodeId, nodes, edges) : [], [cinemaNodeId, edges, nodes]);
  const connectedCharacterRefs = connectedInputs.filter((input) => input.role === 'character_refs')
    .flatMap((input) => input.imageUrls);

  if (!cinemaNodeId || !node || node.data.definitionId !== 'cinema-scene') {
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

  const selectedShot = scene.shots.find((s) => s.id === effectiveShotId) ?? null;

  const handleAddShot = () => {
    const id = addShot(cinemaNodeId);
    if (id) setSelectedShotId(id);
  };

  const handleRemoveShot = (shotId: string) => {
    const current = useGraphStore.getState().nodes.find((candidate) => candidate.id === cinemaNodeId)
      ?.data.params.scene as CinemaSceneSpec | undefined;
    const index = current?.shots.findIndex((shot) => shot.id === shotId) ?? -1;
    if (effectiveShotId === shotId && index >= 0) {
      setSelectedShotId(current?.shots[index + 1]?.id ?? current?.shots[index - 1]?.id ?? null);
    }
    removeShot(cinemaNodeId, shotId);
  };

  const viewInput = (input: CinemaConnectedInput) => {
    const graph = useGraphStore.getState();
    if (graph.isImportingGraph) return;
    const surviving = cinemaConnectedInputs(cinemaNodeId, graph.nodes, graph.edges)
      .some((candidate) => candidate.edgeId === input.edgeId && candidate.sourceId === input.sourceId && candidate.role === input.role);
    if (surviving) useUIStore.getState().requestCanvasNodeFocus(input.sourceId);
  };

  const handleReorder = (shots: CinemaShot[]) => {
    const orderedIds = shots.map((shot) => shot.id);
    updateScene(cinemaNodeId, (current) => {
      const byId = new Map(current.shots.map((shot) => [shot.id, shot]));
      const ordered = orderedIds.flatMap((id) => {
        const shot = byId.get(id);
        return shot ? [shot] : [];
      });
      return { ...current, shots: [...ordered, ...current.shots.filter((shot) => !orderedIds.includes(shot.id))] };
    });
  };

  const handleChangeShot = (update: (current: CinemaShot) => CinemaShot) => {
    if (!selectedShot) return;
    updateScene(cinemaNodeId, (current) => ({
      ...current,
      shots: current.shots.map((shot) => shot.id === selectedShot.id ? update(shot) : shot),
    }));
  };

  return (
    <div className="cinema-studio-view">
      <header className="cinema-studio-view__header">
        <CinemaStudioToolbar cinemaNodeId={cinemaNodeId} />
      </header>

      <div className="cinema-studio-view__body">
        <div className="cinema-studio-view__shared">
          <CinemaSharedControls
            key={cinemaNodeId}
            cinemaNodeId={cinemaNodeId}
            scene={scene}
            connectedRefs={connectedCharacterRefs}
            onChange={(update) => updateScene(cinemaNodeId, update)}
          />
          {connectedInputs.length > 0 && (
            <div className="cinema-connected-inputs" aria-label="Connected scene inputs">
              <span className="cinema-connected-inputs__label">From Canvas</span>
              {connectedInputs.map((input) => (
                <button type="button" key={input.edgeId} className="cinema-connected-inputs__source"
                  aria-label={`View ${input.roleLabel} on Canvas: ${input.sourceLabel}`}
                  title={`${input.roleLabel}: ${input.sourceLabel} · ${input.summary}`}
                  onClick={() => viewInput(input)}>
                  <span className="cinema-connected-inputs__role">{input.roleLabel}</span>
                  <span className="cinema-connected-inputs__name">{input.sourceLabel}</span>
                  <span className="cinema-connected-inputs__detail">{input.summary}</span>
                  <span className="cinema-connected-inputs__view" aria-hidden="true">↗</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="cinema-studio-view__rail">
          <CinemaShotsRail
            key={cinemaNodeId}
            cinemaNodeId={cinemaNodeId}
            scene={scene}
            selectedShotId={effectiveShotId}
            onSelect={setSelectedShotId}
            onAddShot={handleAddShot}
            onRemoveShot={handleRemoveShot}
            onReorder={handleReorder}
          />
        </div>

        <div ref={panelRef} className="cinema-studio-view__panel">
          {selectedShot ? (
            <CinemaShotPanel
              key={`${cinemaNodeId}:${selectedShot.id}`}
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
    </div>
  );
}
