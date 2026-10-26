import { apiFetch } from './backend';
import { CLEAR_FAILED_TEXT, CLEAR_REFUSED_TEXT } from './failureLines';
import { useGraphStore } from '../store/graphStore';

/**
 * Chat's /clear: wipe Nebula's graph too, so the agent starts with a clean
 * canvas, not whatever nodes accumulated from prior sessions. Nodes only this
 * tab has (library drags) stay. One undo step, so the person can bring the
 * canvas back. `force`: typing /clear is the person's confirmation (the
 * backend refuses a clear of a project with nodes without it). The canvas side
 * lands with the answer, under its step (its graphSync can come later), so an
 * undo pressed meanwhile brings the nodes back here and on the backend
 * (review 10, L-2).
 *
 * A clear that fails says so (review 12, L-4; GM - Design, round 13): a Cmd+Z
 * held for it goes to nothing, and nothing else would say why. Every refusal
 * of DELETE /api/graph (a 4xx: a run going, another tab's project, a stale
 * revision) comes before it clears anything: "Couldn't clear the canvas.
 * Nothing was removed." A server error can come after the graph was cleared
 * (it clears, then saves), and no answer says nothing either way, so those
 * read just "Couldn't clear the canvas." (GM: "Use the second sentence only
 * if it is true.") Its own graphSync, if it cleared after all, then shows it.
 */
export async function clearCanvasFromChat(): Promise<void> {
  const graph = useGraphStore.getState();
  const undoStep = graph.beginUndoStep();
  try {
    const response = await apiFetch('/api/graph?force=true', { method: 'DELETE' });
    if (response.ok) {
      useGraphStore.getState().clearBackendNodes({ undoStep });
    } else {
      useGraphStore.getState().cancelUndoStep(undoStep);
      const refused = response.status >= 400 && response.status < 500;
      useGraphStore.getState().notify(refused ? CLEAR_REFUSED_TEXT : CLEAR_FAILED_TEXT);
    }
  } catch {
    useGraphStore.getState().cancelUndoStep(undoStep);
    useGraphStore.getState().notify(CLEAR_FAILED_TEXT);
  } finally {
    useGraphStore.getState().endUndoStep(undoStep);
  }
}
