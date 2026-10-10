import { MiniMap, Panel } from '@xyflow/react';
import { useUIStore } from '../store/uiStore';

/** The optional minimap. Zoom and fit live in the bottom toolbar. */
export function CanvasNavigation() {
  const showMinimap = useUIStore((s) => s.canvasMinimapEnabled);
  if (!showMinimap) return null;

  return (
    <Panel position="bottom-right" className="canvas-navigation">
      <div className="canvas-minimap-panel">
        <MiniMap className="canvas-minimap" pannable zoomable nodeStrokeWidth={2}
          nodeColor="var(--sr-minimap-node, #c9c4ba)"
          maskColor="rgba(0, 0, 0, 0.65)" bgColor="var(--sr-canvas, #090909)" />
      </div>
    </Panel>
  );
}
