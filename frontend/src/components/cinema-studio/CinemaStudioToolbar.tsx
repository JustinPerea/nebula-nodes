import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';

interface CinemaStudioToolbarProps {
  cinemaNodeId: string;
}

/** Top toolbar: breadcrumb back to the canvas, plus generate-all and save.
 *  Mirrors RemotionEditorToolbar's role — a thin band of node-scoped actions
 *  that delegate to the graph store. "Save" is a no-op affordance because every
 *  edit already persists through graphStore.updateScene (optimistic store +
 *  cli_graph round-trip); we surface the button to match the storyboard mock
 *  and to give the user an explicit "flush" signal. */
export function CinemaStudioToolbar({ cinemaNodeId }: CinemaStudioToolbarProps) {
  const exitCinemaEditor = useUIStore((s) => s.exitCinemaEditor);
  const executeNode = useGraphStore((s) => s.executeNode);
  const isExecuting = useGraphStore((s) => s.isExecuting);

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
      <button
        type="button"
        className="cinema-studio-toolbar__action"
        onClick={() => executeNode(cinemaNodeId)}
        disabled={isExecuting}
        title="Run the cinema-scene node — generates every shot via the existing execution pipeline"
      >
        {isExecuting ? 'Generating…' : 'Generate all'}
      </button>
    </div>
  );
}
