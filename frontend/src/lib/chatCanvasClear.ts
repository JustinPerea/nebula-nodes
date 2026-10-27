import { apiFetch } from './backend';
import { CHAT_CLEAR_ANSWER_MS } from './chatClear';
import { readDetail, warnFailure } from './errorCopy';
import { adoptCanvasRevisionFrom } from './projectContext';
import type { ChatClearOutcome } from './failureLines';
import { useGraphStore } from '../store/graphStore';

/**
 * Chat's /clear: wipe Nebula's graph too, so the agent starts with a clean
 * canvas, not whatever nodes accumulated from prior sessions. Nodes only this
 * tab has (library drags) stay. One undo step, so the person can bring the
 * canvas back. `force`: typing /clear is the person's confirmation (the
 * backend refuses a clear of a project with nodes without it). The canvas side
 * lands with the answer, under its step (its graphSync can come later), so an
 * undo pressed meanwhile brings the nodes back here and on the backend
 * (review 10, L-2). Its step is a clear's (review 13, L-2): a Cmd+Z held from
 * before it is dropped rather than undone beneath it.
 *
 * The outcome is what the chat's line says (lib/chatClear.ts, GM round 12 of
 * PR #114, the merge of round 21). A refusal (4xx: a run going, another tab's
 * project, a stale revision) comes before anything is cleared: its step goes
 * and `onRefused` gets the answer, for the chat's notice under Clear's
 * heading. A server error or no answer within CHAT_CLEAR_ANSWER_MS may have
 * cleared (clear_graph empties the live graph in one step, then saves), so
 * the step stays (round 13 of PR #114, review 12 item 4): if it happened,
 * Undo brings the canvas back; if not, Undo changes nothing and sends nothing.
 */
export async function clearCanvasFromChat(options: {
  onRefused?: (response: Response) => Promise<void> | void;
} = {}): Promise<ChatClearOutcome> {
  const graph = useGraphStore.getState();
  const undoStep = graph.beginUndoStep({ clear: true });
  try {
    const bound = AbortSignal.timeout(CHAT_CLEAR_ANSWER_MS);
    const unanswered = new Promise<null>((resolve) => {
      bound.addEventListener('abort', () => resolve(null), { once: true });
    });
    let response: Response | null;
    try {
      response = await Promise.race([
        apiFetch('/api/graph?force=true', { method: 'DELETE', signal: bound }), unanswered]);
    } catch {
      response = null;
    }
    if (response?.ok) {
      // The canvas Nebula holds now (round 19): writes to it carry it.
      await adoptCanvasRevisionFrom(response);
      useGraphStore.getState().clearBackendNodes({ undoStep });
      return 'cleared';
    }
    if (response && response.status >= 400 && response.status < 500) {
      // Refused: the clear surely didn't happen.
      useGraphStore.getState().cancelUndoStep(undoStep);
      await options.onRefused?.(response);
      return 'refused';
    }
    if (response) warnFailure("Couldn't clear the canvas.", response.status, await readDetail(response));
    return 'unconfirmed';
  } finally {
    useGraphStore.getState().endUndoStep(undoStep);
  }
}
