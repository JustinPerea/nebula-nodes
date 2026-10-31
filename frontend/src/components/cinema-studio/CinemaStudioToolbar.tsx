import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { getCinemaUploadIssue, useCinemaUploadStore } from '../../store/cinemaUploadStore';
import { WorkspaceHeader } from '../WorkspaceHeader';
import { lockedAction, useCanvasLock } from '../../lib/canvasLock';
import { OFFLINE_VERBS } from '../../lib/useBackendOffline';
import { RUN_LOCK_VERBS, lockLine, runFinishesLine } from '../../lib/runLock';

interface CinemaStudioToolbarProps {
  cinemaNodeId: string;
}

/** Scene-wide actions stay separate from the selected shot's controls. */
export function CinemaStudioToolbar({ cinemaNodeId }: CinemaStudioToolbarProps) {
  const exitCinemaEditor = useUIStore((s) => s.exitCinemaEditor);
  const executeNode = useGraphStore((s) => s.executeNode);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  // A run waiting for its inputs counts as starting (review 15, M-B).
  const runStarting = useGraphStore((s) => s.runStarting);
  const isImportingGraph = useGraphStore((s) => s.isImportingGraph);
  const activeRuns = useGraphStore((s) => s.activeRuns);
  const cancelRun = useGraphStore((s) => s.cancelRun);
  // Round 23 (review 22, L-3): Generate all acts, so it takes the canvas
  // lock (following, offline); offline it reads GM's verb line and drops
  // its accent (PR #198). Run history only looks and Stop scene stops a run
  // already going (a stop is never refused), so both stay enabled.
  const lock = useCanvasLock();
  useCinemaUploadStore((state) => state.uploads);
  const referenceIssue = getCinemaUploadIssue(cinemaNodeId, undefined, true);
  const sceneRuns = activeRuns.filter((run) => run.nodeIds.includes(cinemaNodeId));
  const stopping = sceneRuns.length > 0 && sceneRuns.every((run) => run.status === 'cancelling');
  const openHistory = () => {
    exitCinemaEditor();
    useUIStore.getState().setLeftDock('history');
  };

  return (
    <WorkspaceHeader title="Cinema" onBack={exitCinemaEditor} className="cinema-studio-toolbar cinema-studio-view__header">
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
          if (!getCinemaUploadIssue(cinemaNodeId, undefined, true)) executeNode(cinemaNodeId, { verb: 'Generate' });
        }}
        // M2: this tab's run says its line first (lib/canvasLock's order).
        {...lockedAction(lock, {
          disabled: isImportingGraph || Boolean(referenceIssue),
          // GM PR #205 r1: an import's lock says what unlocks it too.
          title: isImportingGraph ? lockLine(RUN_LOCK_VERBS.generateShots, 'import')
            : referenceIssue ?? 'Generate every shot using the current scene settings',
          offline: 'generate',
        }, { verb: OFFLINE_VERBS.generate, neutral: true, run: isExecuting || runStarting,
          runTitle: runFinishesLine(RUN_LOCK_VERBS.generateShots) })}
      >
        {sceneRuns.length > 0 ? 'Generating…' : 'Generate all'}
      </button>
    </WorkspaceHeader>
  );
}
