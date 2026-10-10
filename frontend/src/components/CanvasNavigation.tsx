import { ControlButton, Controls, MiniMap, Panel, useReactFlow } from '@xyflow/react';
import { Maximize } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { computeCanvasFitPadding } from '../lib/canvasFit';

/** One home for viewport controls, clear of the workspace rail and toolbar. */
export function CanvasNavigation({ nodeCount }: { nodeCount: number }) {
  const showMinimap = useUIStore((s) => s.canvasMinimapEnabled);
  const { fitView } = useReactFlow();

  return (
    <Panel position="bottom-right" className="canvas-navigation">
      <div className="canvas-navigation__header">
        <span className="canvas-node-count">{nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}</span>
        <Controls orientation="horizontal" showInteractive={false} showFitView={false}
          className="canvas-navigation__controls">
          <ControlButton type="button" title="Fit view" aria-label="Fit view"
            onClick={() => void fitView({ padding: computeCanvasFitPadding() })}>
            <Maximize size={14} aria-hidden="true" />
          </ControlButton>
        </Controls>
      </div>
      {showMinimap && (
        <div className="canvas-minimap-panel">
          <MiniMap className="canvas-minimap" pannable zoomable nodeStrokeWidth={2}
            nodeColor="var(--sr-minimap-node, #c9c4ba)"
            maskColor="rgba(0, 0, 0, 0.65)" bgColor="var(--sr-canvas, #090909)" />
        </div>
      )}
    </Panel>
  );
}
