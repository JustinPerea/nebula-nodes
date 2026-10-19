import { useCallback, useEffect, useRef } from 'react';
import { useUIStore, type LeftDock } from '../../store/uiStore';

/**
 * Home shares the workspace's Settings drawer (it's one of the left docks).
 * Arriving home closes whatever drawer was open, so a workspace's open Settings
 * doesn't greet you on the project list. Leaving home puts that drawer back,
 * unless the person picked a different one in the meantime: Settings opened from
 * home doesn't follow them into the project they open. Opening, creating or
 * deleting a project from home resets the panels for that canvas, and that
 * reset decides the drawer (a project with nodes opens with none).
 */
export function useHomeSettingsDock(isHome: boolean) {
  const open = useUIStore((s) => isHome && s.leftDock === 'settings');
  const dockBeforeHome = useRef<LeftDock | null>(null);

  useEffect(() => {
    if (!isHome) return;
    const { leftDock, setLeftDock, panelsResetRevision } = useUIStore.getState();
    dockBeforeHome.current = leftDock;
    if (leftDock === 'settings') setLeftDock(null);
    return () => {
      const ui = useUIStore.getState();
      if (ui.panelsResetRevision !== panelsResetRevision) return;
      if (ui.leftDock === 'settings' || ui.leftDock === null) ui.setLeftDock(dockBeforeHome.current);
    };
  }, [isHome]);

  const toggle = useCallback(() => {
    const { leftDock, setLeftDock } = useUIStore.getState();
    setLeftDock(leftDock === 'settings' ? null : 'settings');
  }, []);

  return { open, toggle };
}
