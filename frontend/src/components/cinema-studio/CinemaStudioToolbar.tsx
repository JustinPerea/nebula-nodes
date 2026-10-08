import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { getCinemaUploadIssue, useCinemaUploadStore } from '../../store/cinemaUploadStore';

interface CinemaStudioToolbarProps {
  cinemaNodeId: string;
}

/** Scene-wide actions stay separate from the selected shot's controls. */
export function CinemaStudioToolbar({ cinemaNodeId }: CinemaStudioToolbarProps) {
  const exitCinemaEditor = useUIStore((s) => s.exitCinemaEditor);
  const executeNode = useGraphStore((s) => s.executeNode);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const isImportingGraph = useGraphStore((s) => s.isImportingGraph);
  const activeRuns = useGraphStore((s) => s.activeRuns);
  const cancelRun = useGraphStore((s) => s.cancelRun);
  useCinemaUploadStore((state) => state.uploads);
  const referenceIssue = getCinemaUploadIssue(cinemaNodeId, undefined, true);
  const sceneRuns = activeRuns.filter((run) => run.nodeIds.includes(cinemaNodeId));
  const stopping = sceneRuns.length > 0 && sceneRuns.every((run) => run.status === 'cancelling');
  const openHistory = () => {
    exitCinemaEditor();
    useUIStore.getState().setLeftDock('history');
  };

  return (
    <div className="cinema-studio-toolbar">
      <button
        type="button"
        className="cinema-studio-toolbar__back"
        onClick={exitCinemaEditor}
      >
        ← Canvas
      </button>
      <span className="cinema-studio-toolbar__crumb">Cinema Studio</span>
      <div className="cinema-studio-toolbar__spacer" />
      <button type="button" className="cinema-studio-toolbar__action" onClick={openHistory}>
        Run history
      </button>
      {sceneRuns.length > 0 && (
        <button
          type="button"
          className="cinema-studio-toolbar__action"
          onClick={() => void Promise.all(sceneRuns.map((run) => cancelRun(run.id)))}
          disabled={stopping}
          aria-busy={stopping}
        >
          {stopping ? 'Stopping…' : 'Stop scene'}
        </button>
      )}
      <button
        type="button"
        className="cinema-studio-toolbar__action"
        onClick={() => {
          if (!getCinemaUploadIssue(cinemaNodeId, undefined, true)) executeNode(cinemaNodeId);
        }}
        disabled={isExecuting || isImportingGraph || Boolean(referenceIssue)}
        title={referenceIssue ?? 'Generate every shot using the current scene settings'}
      >
        {sceneRuns.length > 0 ? 'Generating…' : 'Generate all'}
      </button>
    </div>
  );
}
