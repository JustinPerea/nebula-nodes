import { useEffect } from 'react';
import { fetchCommonsCapability } from '../lib/commonsCapability';
import { noteCommonsAnswered, noteCommonsOff } from '../lib/commonsOff';
import { commonsRouteWanted } from '../lib/commonsRoute';
import { useUIStore } from '../store/uiStore';

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
