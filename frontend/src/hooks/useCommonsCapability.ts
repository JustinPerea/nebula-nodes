import { useEffect } from 'react';
import { isBackendOffline, subscribeBackendConnection } from '../lib/backendConnection';
import { fetchCommonsCapability } from '../lib/commonsCapability';
import { markCommonsOpening } from '../lib/commonsOpening';
import { noteCommonsAnswered, noteCommonsOff } from '../lib/commonsOff';
import { clearCommonsHash, commonsRouteWanted } from '../lib/commonsRoute';
import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';

/** The off view's way back has focus (WorkspaceHeader's back button inside it). */
function offBackFocused(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && active.matches('[data-commons-off] .workspace-header__back');
}

/**
 * PR #204 round 18f (GM r35 5): the backend says the Commons is on again, under the off view.
 * It opens into the Commons with no reload: the project this tab has loaded shows (the Commons
 * shows only over a project, as a reload on #commons would have it), and the view takes focus
 * to the heading, or to its way back when the person was on it. With no project to show it over,
 * the Projects home, as "← Projects" would.
 */
async function openCommonsFromOff(): Promise<void> {
  const focus = offBackFocused() ? 'back' : 'heading';
  noteCommonsAnswered();
  const projects = useProjectStore.getState();
  const project = projects.activeProject;
  if (projects.screen !== 'workspace' && project) await projects.open(project.id);
  const ui = useUIStore.getState();
  if (!ui.commonsOffShown || !commonsRouteWanted()) return;
  if (useProjectStore.getState().screen !== 'workspace') {
    ui.exitCommons();
    clearCommonsHash();
    return;
  }
  markCommonsOpening(focus);
  // One update: the off view goes and the Commons shows in the same render.
  ui.setCommonsEnabled(true);
  ui.setCommonsOffShown(false);
  useUIStore.getState().enterCommons();
}

/** Keep Commons unavailable until this backend explicitly opts in. */
export function useCommonsCapability(): void {
  const enabled = useUIStore((state) => state.commonsEnabled);
  const offShown = useUIStore((state) => state.commonsOffShown);
  useEffect(() => {
    let cancelled = false;
    useUIStore.getState().setCommonsEnabled(false);
    void fetchCommonsCapability().then((answer) => {
      if (cancelled) return;
      useUIStore.getState().setCommonsEnabled(answer === 'on');
      // The backend says the Commons is on: whatever this window heard before (lib/commonsOff).
      if (answer === 'on') noteCommonsAnswered();
      // PR #204 round 18d (GM r32 1): a tab opened on the Commons while the backend says it runs
      // without it opens to the Commons-off view, as the Commons turned off mid-visit does. Only
      // the backend's own "off": no answer says nothing about the Commons.
      if (answer === 'off' && commonsRouteWanted()) {
        noteCommonsOff();
        useUIStore.getState().setCommonsOffShown(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Round 18f (GM r35 5): a tab that opened with the Commons off asks again on reconnect (the
  // backend may have restarted with it on). No polling: only when Nebula comes back.
  useEffect(() => {
    if (!offShown) return undefined;
    let cancelled = false;
    let wasOffline = isBackendOffline();
    const stop = subscribeBackendConnection(() => {
      const now = isBackendOffline();
      const back = wasOffline && !now;
      wasOffline = now;
      if (!back) return;
      void fetchCommonsCapability().then((answer) => {
        if (!cancelled && answer === 'on') void openCommonsFromOff();
      });
    });
    return () => { cancelled = true; stop(); };
  }, [offShown]);

  // The off view goes with its route: a hash edit or Back away from #commons leaves it.
  useEffect(() => {
    if (!offShown) return;
    const sync = () => { if (!commonsRouteWanted()) useUIStore.getState().setCommonsOffShown(false); };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [offShown]);

  useEffect(() => {
    if (!enabled) return;
    let routed = false;
    const sync = () => {
      const wanted = commonsRouteWanted();
      if (wanted) {
        routed = true;
        useUIStore.getState().enterCommons();
      } else if (routed) {
        useUIStore.getState().exitCommons();
        // Still routed when the Commons kept the person (unsaved labels): it
        // pushes #commons back on top of the entry they went back to, so
        // Back after a save reaches that entry and leaves as usual.
        routed = useUIStore.getState().viewMode === 'commons';
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [enabled]);
}
