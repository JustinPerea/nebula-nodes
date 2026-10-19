import { useEffect } from 'react';
import { useUIStore } from '../store/uiStore';
import { useProjectStore } from '../store/projectStore';
import { NEW_MOODBOARD_SENTINEL } from '../lib/studioSentinels';

// A board id, as the backend allows it (services/moodboard_store.py).
const MOODBOARD_HASH = /^#moodboard\/([A-Za-z0-9_-]{1,64})$/;

/** The board id in a `#moodboard/<id>` link, or null. */
export function moodboardIdFromHash(hash: string): string | null {
  return MOODBOARD_HASH.exec(hash)?.[1] ?? null;
}

export function moodboardHash(id: string): string {
  return `#moodboard/${id}`;
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
      const ui = useUIStore.getState();
      if (ui.viewMode !== 'moodboard-editor' || ui.moodboardEditorId !== id) ui.enterMoodboardEditor(id);
    };

    const followStudio = () => {
      if (pending) return; // a link not opened yet keeps its hash
      const ui = useUIStore.getState();
      const open = ui.viewMode === 'moodboard-editor' && ui.moodboardEditorId
        && ui.moodboardEditorId !== NEW_MOODBOARD_SENTINEL ? ui.moodboardEditorId : null;
      const current = window.location.hash;
      if (open) {
        if (current !== moodboardHash(open)) replaceHash(moodboardHash(open));
      } else if (moodboardIdFromHash(current)) {
        replaceHash('');
      }
    };

    const onHashChange = () => {
      const id = moodboardIdFromHash(window.location.hash);
      if (id) {
        pending = id;
        openPending();
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
