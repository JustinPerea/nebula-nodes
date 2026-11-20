import { useEffect } from 'react';
import { isBackendOffline, subscribeBackendConnection } from '../../lib/backendConnection';
import { stopFirstLoadRetry, subscribeProjectAutosave, useProjectStore, wakeFirstLoad } from '../../store/projectStore';

export function ProjectCoordinator() {
  useEffect(() => {
    const unsubscribe = subscribeProjectAutosave();
    void useProjectStore.getState().initialize();
    // Design: a first load that found no server loads again when the server may be back: the
    // health probe answers, the window comes online, or the tab comes into view.
    const stopProbe = subscribeBackendConnection(() => { if (!isBackendOffline()) wakeFirstLoad(); });
    const onVisible = () => { if (document.visibilityState === 'visible') wakeFirstLoad(); };
    window.addEventListener('online', wakeFirstLoad);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopFirstLoadRetry();
      stopProbe();
      window.removeEventListener('online', wakeFirstLoad);
      document.removeEventListener('visibilitychange', onVisible);
      unsubscribe();
    };
  }, []);
  return null;
}
