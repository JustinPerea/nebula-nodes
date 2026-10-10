import { useUIStore } from '../store/uiStore';
import { PanelsTopLeft, Sparkles } from 'lucide-react';
import { WorkspaceHeader } from './WorkspaceHeader';
import './CanvasTabs.css';

/** Shared workspace navigation. Editing a video is an action on its source node. */
export function WorkspaceModeNavigation() {
  const viewMode = useUIStore((s) => s.viewMode);
  const commonsEnabled = useUIStore((s) => s.commonsEnabled);
  const canvasActive = viewMode === 'canvas' || (viewMode === 'commons' && !commonsEnabled);
  const createActive = viewMode === 'create';

  if (!canvasActive && !createActive) return null;

  const navigate = (destination: 'canvas' | 'create') => {
    // A pending activation must not navigate from an editor or a newer workspace.
    const ui = useUIStore.getState();
    const currentCanvas = ui.viewMode === 'canvas' || (ui.viewMode === 'commons' && !ui.commonsEnabled);
    if (destination === 'create' && currentCanvas) ui.enterCreateView();
    else if (destination === 'canvas' && ui.viewMode === 'create') ui.exitCreateView();
  };

  return (
    <nav className="canvas-tabs__views" aria-label="Workspace views">
      <button
        type="button"
        className={`canvas-tabs__btn${canvasActive ? ' canvas-tabs__btn--active' : ''}`}
        aria-current={canvasActive ? 'page' : undefined}
        onClick={() => navigate('canvas')}
      >
        <PanelsTopLeft className="canvas-tabs__icon" aria-hidden="true" focusable="false" />
        <span>Canvas</span>
      </button>
      <button
        type="button"
        className={`canvas-tabs__btn${createActive ? ' canvas-tabs__btn--active' : ''}`}
        aria-current={createActive ? 'page' : undefined}
        data-onboarding-target="create"
        onClick={() => navigate('create')}
      >
        <Sparkles className="canvas-tabs__icon" aria-hidden="true" focusable="false" />
        <span>Creator Studio</span>
      </button>
    </nav>
  );
}

/** Canvas chrome; Creator Studio embeds the same navigation in its own header. */
export function CanvasTabs() {
  const viewMode = useUIStore((s) => s.viewMode);
  const commonsEnabled = useUIStore((s) => s.commonsEnabled);
  if (viewMode !== 'canvas' && !(viewMode === 'commons' && !commonsEnabled)) return null;

  return (
    <div className="canvas-tabs-wrap">
      <WorkspaceHeader title="Canvas" className="workspace-header--canvas"
        navigation={<WorkspaceModeNavigation />} />
    </div>
  );
}
