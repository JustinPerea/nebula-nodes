import { useEffect } from 'react';
import { subscribeProjectAutosave, useProjectStore } from '../../store/projectStore';

export function ProjectCoordinator() {
  useEffect(() => {
    const unsubscribe = subscribeProjectAutosave();
    void useProjectStore.getState().initialize();
    return unsubscribe;
  }, []);
  return null;
}
