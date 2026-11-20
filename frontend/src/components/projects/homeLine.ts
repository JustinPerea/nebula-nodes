import type { ProjectState } from '../../store/projectStore';

/** Design: whether Projects draws its error line. ProjectHome draws it with this, and the
 * offline banner's hiding below reads it too, so the banner stays away only while the line it
 * defers to is really on screen (a held-edits screen replaces the line and keeps the banner). */
export const homeLineDrawn = (error: string | null | undefined, unsavedEdits: unknown): boolean => !unsavedEdits && Boolean(error);

/** The first load found no server (trying again, or out of tries). */
export const firstLoadWaiting = (state: Pick<ProjectState, 'initialized' | 'errorRetry'>): boolean =>
  !state.initialized && state.errorRetry?.action === 'load' && Boolean(state.errorRetry.unreachable);

/** The first-load line is what Projects shows now. */
export const firstLoadLineShown = (state: Pick<ProjectState, 'initialized' | 'errorRetry' | 'error' | 'unsavedEdits'>): boolean =>
  firstLoadWaiting(state) && homeLineDrawn(state.error, state.unsavedEdits);
