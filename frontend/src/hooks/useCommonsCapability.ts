import { useEffect } from 'react';
import { fetchCommonsEnabled } from '../lib/commonsCapability';
import { useUIStore } from '../store/uiStore';

/** Keep Commons unavailable until this backend explicitly opts in. */
export function useCommonsCapability(): void {
  const enabled = useUIStore((state) => state.commonsEnabled);
  useEffect(() => {
    let cancelled = false;
    useUIStore.getState().setCommonsEnabled(false);
    void fetchCommonsEnabled().then((enabled) => {
      if (!cancelled) useUIStore.getState().setCommonsEnabled(enabled);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let routed = false;
    const sync = () => {
      const wanted = window.location.hash === '#commons'
        || new URLSearchParams(window.location.hash.slice(1)).get('view') === 'commons';
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
