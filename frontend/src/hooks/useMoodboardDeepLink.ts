import { useEffect } from 'react';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { NEW_MOODBOARD_SENTINEL } from '../lib/studioSentinels';
import { isPersonLinkHash } from '../lib/personSession';

// A board id, as the backend allows it (services/moodboard_store.py).
const MOODBOARD_HASH = /^#moodboard\/([A-Za-z0-9_-]{1,64})$/;

/** The board id in a `#moodboard/<id>` link, or null. */
export function moodboardIdFromHash(hash: string): string | null {
  return MOODBOARD_HASH.exec(hash)?.[1] ?? null;
}

export function moodboardHash(id: string): string {
  return `#moodboard/${id}`;
}

/**
 * The board the Studio shows, kept in this tab's own storage (GM,
 * 2026-10-30: a promote never moves the person). The address can lose its
 * `#moodboard/<id>` without the person leaving: the person link takes the
 * hash, then is stripped from it. A same-tab reload or reconnect then
 * restores the Studio from here, the way the hash would. Per tab
 * (sessionStorage), cleared when the person leaves the Studio.
 */
export const STUDIO_BOARD_KEY = 'nebula.studioBoard';
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

function keepStudioBoard(id: string | null): void {
  try {
    if (id) window.sessionStorage.setItem(STUDIO_BOARD_KEY, id);
    else window.sessionStorage.removeItem(STUDIO_BOARD_KEY);
  } catch {
    /* No storage in this tab: the hash alone carries it. */
  }
}

function keptStudioBoard(): string | null {
  try {
    const id = window.sessionStorage.getItem(STUDIO_BOARD_KEY);
    return id && BOARD_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

/**
 * How this document was reached (PerformanceNavigationTiming.type): 'reload',
 * 'navigate' (a typed address, a bookmark, a fresh link), 'back_forward' or
 * 'prerender'. 'navigate' when the browser doesn't say.
 */
export function navigationType(): string {
  try {
    const entry = performance.getEntriesByType?.('navigation')?.[0] as PerformanceNavigationTiming | undefined;
    if (entry && typeof entry.type === 'string') return entry.type;
  } catch {
    /* no Navigation Timing: treat it as a fresh navigation */
  }
  return 'navigate';
}

/** A hash that says nothing about where the person is: none, or a person link. */
function neutralHash(hash: string): boolean {
  return !hash || hash === '#' || isPersonLinkHash(hash);
}

function replaceHash(hash: string): void {
  const { pathname, search } = window.location;
  // replaceState: following the open board adds no history entries.
  window.history.replaceState(window.history.state, '', `${pathname}${search}${hash}`);
}

/**
 * `#moodboard/<id>` opens Moodboard Studio on that board, like `#brand` opens
 * the brand page. The scope it opens with is only a hint: the Studio reads the
 * board's own projectId and moves to its scope. An unknown id gets the
 * Studio's not-found message.
 *
 * It's a real link both ways: while the Studio shows a saved board the hash
 * names it, and leaving the Studio clears it. A link waits until the open
 * project has loaded (loading one resets the view to the canvas), then goes
 * past the Projects screen into it; with no open project it waits for the
 * person to open one.
 */
export function useMoodboardDeepLink(): void {
  useEffect(() => {
    let pending = moodboardIdFromHash(window.location.hash);
    // No board in the address: the tab's own record of the Studio it showed
    // (a reload after the person link took the hash). It opens the way the
    // hash would: a board deleted meanwhile gets the Studio's own "Moodboard
    // not found", the same as a #moodboard/<id> link to it (GM, PR #204
    // round 1: one behaviour for a missing board however reached). Only on a
    // reload (GM, PR #204 round 3): a typed address, a bookmark or a fresh
    // link lands where it points, and the tab forgets the board. A reconnect
    // that doesn't navigate never remounts this, so the Studio just stays.
    let restoring = false;
    if (!pending && neutralHash(window.location.hash) && navigationType() === 'reload') {
      pending = keptStudioBoard();
      restoring = pending !== null;
    }
    // The view when the restore was armed: if the person moves before it
    // opens (another board, the canvas, any other view), their move wins
    // (review 1 LOW-1). Opened at once once the project is ready, no request first.
    const armedView = { mode: useUIStore.getState().viewMode, board: useUIStore.getState().moodboardEditorId };

    const openPending = () => {
      const project = useProjectStore.getState();
      if (!pending || !project.initialized || project.busy) return;
      if (project.screen !== 'workspace') {
        // The app starts on Projects with the open project already loaded:
        // the link goes into it, as clicking its card would (open() only
        // shows a project that's loaded). With no open project the link
        // waits for the person to open one.
        if (project.activeProject) void project.open(project.activeProject.id);
        return;
      }
      const id = pending;
      pending = null;
      restoring = false;
      const ui = useUIStore.getState();
      if (ui.viewMode !== 'moodboard-editor' || ui.moodboardEditorId !== id) ui.enterMoodboardEditor(id);
    };

    const followStudio = () => {
      if (pending && restoring) {
        const ui = useUIStore.getState();
        if (ui.viewMode !== armedView.mode || ui.moodboardEditorId !== armedView.board) {
          pending = null;
          restoring = false;
        }
      }
      if (pending) return; // a link not opened yet keeps its hash
      const ui = useUIStore.getState();
      const open = ui.viewMode === 'moodboard-editor' && ui.moodboardEditorId
        && ui.moodboardEditorId !== NEW_MOODBOARD_SENTINEL ? ui.moodboardEditorId : null;
      const current = window.location.hash;
      keepStudioBoard(open);
      if (open) {
        // A person link still in the address is personSession's to take in first.
        if (current !== moodboardHash(open) && !isPersonLinkHash(current)) replaceHash(moodboardHash(open));
      } else if (moodboardIdFromHash(current)) {
        replaceHash('');
      }
    };

    const onHashChange = (event: HashChangeEvent) => {
      const id = moodboardIdFromHash(window.location.hash);
      if (id) {
        pending = id;
        restoring = false;
        openPending();
        return;
      }
      // The person link (GM, 2026-10-30): a promote never moves the person.
      // personSession takes it in and strips it, which leaves the address
      // without the board; the Studio stays and its link comes back.
      let arrived = window.location.hash;
      try {
        arrived = new URL(event.newURL).hash;
      } catch {
        /* no newURL (a synthetic event): what the address says now */
      }
      if (isPersonLinkHash(arrived) || isPersonLinkHash(window.location.hash)) {
        followStudio();
        return;
      }
      // The link was taken away (edited, or Back): leave the Studio, as
      // clearing #brand leaves the brand page.
      const ui = useUIStore.getState();
      if (ui.viewMode === 'moodboard-editor') ui.exitMoodboardEditor();
    };

    // Subscribed first: opening the project below can show it at once.
    const stopUI = useUIStore.subscribe(followStudio);
    const stopProject = useProjectStore.subscribe(() => { openPending(); followStudio(); });
    window.addEventListener('hashchange', onHashChange);
    openPending();
    followStudio();
    return () => {
      stopUI();
      stopProject();
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);
}
