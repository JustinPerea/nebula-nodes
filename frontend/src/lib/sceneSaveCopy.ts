/**
 * What a Cinema scene says when the backend doesn't take its save (GM -
 * Design, PR #198 r6 item 1 and r7 item 1). Each refusal gets the line for
 * what clears it, never one shared suffix, and a specific line replaces the
 * generic one, never both.
 */

/** "Couldn't save your changes to “Opening”." The heading of every line below
 * but the 413's, which is GM's own (r6 item 1). */
export function sceneSaveHeading(scene: string): string {
  return `Couldn't save your changes to “${scene}”.`;
}

/** 413, the whole save (GM r6 item 1, verbatim): "Couldn't save “Scene”. The
 * project is too big to save. Remove something and Nebula will save your changes." */
export const SCENE_TOO_BIG = 'The project is too big to save. Remove something and Nebula will save your changes.';
export function sceneTooBigLine(scene: string): string {
  return `Couldn't save “${scene}”. ${SCENE_TOO_BIG}`;
}

/** Clears by itself (a paid start, an approved run's inputs, any run lock; GM r7). */
export const KEPT_UNTIL_RUN_ENDS = 'Your changes are kept and will save when the run finishes.';

/** A server error, with the automatic retry the canvas makes (GM r7). */
export const KEPT_AND_RETRYING = 'Your changes are kept. Nebula will try again.';

/** 404, the node was deleted elsewhere (GM r7, verbatim): no promise. */
export const DELETED_ELSEWHERE = 'It was deleted in another window.';

/** The workspace moved (GM r7): "Codex switched to “Y” first.", with no agent
 * "Nebula switched to “Y” first." */
export function switchedFirst(project: string, agent: string | null): string {
  return `${agent ?? 'Nebula'} switched to “${project}” first.`;
}
/** The workspace moved and the backend named no project (an unfiled
 * canvas; GM r8, verbatim). */
export const SWITCHED_UNNAMED = 'The canvas switched to another project first.';

/** 400, a bad save, which is Nebula's bug (GM r7, verbatim). The detail goes
 * in the Agent log. */
export const BAD_SAVE = "Nebula ran into a problem saving them, so they're kept on screen but not saved.";

/** The scene card's mark while its edits aren't saved (GM r8): a small label
 * in the card's header, its tooltip the same sentence as its cause's toast. */
export const UNSAVED_MARK = 'Not saved';

/** Edits kept unsaved here, then the scene changed somewhere else first (an
 * agent, another window; GM r8, verbatim). The person's edits stay on screen,
 * marked "Not saved"; nothing sends them by itself (graphStore
 * reconcileSceneEntries). */
export const CHANGED_ELSEWHERE = 'It was changed in another window first, so your changes are kept on screen but not saved.';
