import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { refuseWhileCommonsUnsaved } from './commonsUnsaved';

/**
 * Back to the open project's canvas from any screen, the way each screen's
 * own Back goes (Q107 a: the Updates corner is on every screen, and its
 * "Show on canvas" works from there). Projects opens the open project's
 * workspace first. Only the Updates corner, a deferred chunk, imports this.
 * Refuses while the Commons holds unsaved labels (leaving would unmount
 * them): the corner asks first (askBeforeLeavingCommons, commons-leave), so
 * this is the net under a caller that didn't.
 */
export async function goToCanvas(): Promise<void> {
  refuseWhileCommonsUnsaved();
  await openWorkspace();
  const ui = useUIStore.getState();
  switch (ui.viewMode) {
    case 'editor': ui.exitEditor(); break;
    case 'remotion-editor': ui.exitRemotionEditor(); break;
    case 'cinema-editor': ui.exitCinemaEditor(); break;
    case 'character-editor': ui.exitCharacterEditor(); break;
    case 'moodboard-editor': ui.exitMoodboardEditor(); break;
    case 'create': ui.exitCreateView(); break;
    case 'brand-showcase': ui.exitBrandShowcase(); break;
    // Not exitCommons: that goes back to wherever the Commons was opened from.
    case 'commons': useUIStore.setState({ viewMode: 'canvas' }); break;
    default: break;
  }
}

/**
 * From Projects, the open project's workspace (the screen the person left);
 * anywhere else, nothing. Refuses when no project is open.
 */
export async function openWorkspace(): Promise<void> {
  const projects = useProjectStore.getState();
  if (projects.screen !== 'home') return;
  const id = projects.activeProject?.id;
  if (!id) throw new Error('Open a project first: Updates are kept with a project.');
  await projects.open(id);
  if (useProjectStore.getState().screen !== 'workspace') throw new Error("The project didn't open. Try again.");
}

/** Whether the canvas is the screen showing now. */
export function onCanvas(): boolean {
  const ui = useUIStore.getState();
  return useProjectStore.getState().screen === 'workspace'
    && (ui.viewMode === 'canvas' || (ui.viewMode === 'commons' && !ui.commonsEnabled));
}

/**
 * Resolve true once `ready()` has held for two frames in a row (the canvas
 * mounted and placed its camera), or false after `timeoutMs`.
 */
export function whenReady(ready: () => boolean, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const start = Date.now();
    let held = 0;
    const step = () => {
      held = ready() ? held + 1 : 0;
      if (held >= 2) { resolve(true); return; }
      if (Date.now() - start > timeoutMs) { resolve(false); return; }
      window.setTimeout(step, 16);
    };
    step();
  });
}
