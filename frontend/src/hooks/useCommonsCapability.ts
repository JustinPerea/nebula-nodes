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
        routed = false;
        useUIStore.getState().exitCommons();
      }
    };
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, [enabled]);
}
