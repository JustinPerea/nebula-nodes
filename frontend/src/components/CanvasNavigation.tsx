import { Controls, MiniMap, Panel } from '@xyflow/react';
import { Map, Minimize2 } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { computeCanvasFitPadding } from '../lib/canvasFit';

/** One home for viewport controls, clear of the workspace rail and toolbar. */
export function CanvasNavigation({ nodeCount }: { nodeCount: number }) {
  const showMinimap = useUIStore((s) => s.canvasPerfMode);
  const collapsed = useUIStore((s) => s.minimapCollapsed);
  const setCollapsed = useUIStore((s) => s.setMinimapCollapsed);

  return (
    <Panel position="bottom-right" className="canvas-navigation">
      <div className="canvas-navigation__header">
        <span className="canvas-node-count">{nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}</span>
        <Controls orientation="horizontal" showInteractive={false}
          className="canvas-navigation__controls" fitViewOptions={{ padding: computeCanvasFitPadding() }} />
      </div>
      {showMinimap && (
        <div className={`canvas-minimap-panel${collapsed ? ' canvas-minimap-panel--collapsed' : ''}`}>
          {collapsed ? (
            <button type="button" className="canvas-minimap-toggle canvas-minimap-toggle--restore"
              aria-label="Show canvas minimap" title="Show canvas minimap" onClick={() => setCollapsed(false)}>
              <Map size={18} aria-hidden="true" />
            </button>
          ) : (
            <>
              <MiniMap className="canvas-minimap" pannable zoomable nodeStrokeWidth={2}
                nodeColor="var(--sr-minimap-node, #c9c4ba)"
                maskColor="rgba(0, 0, 0, 0.65)" bgColor="var(--sr-canvas, #090909)" />
              <button type="button" className="canvas-minimap-toggle canvas-minimap-toggle--collapse"
                aria-label="Minimize canvas minimap" title="Minimize canvas minimap" onClick={() => setCollapsed(true)}>
                <Minimize2 size={16} aria-hidden="true" />
              </button>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
