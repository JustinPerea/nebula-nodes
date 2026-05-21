import { useUIStore } from '../store/uiStore';
import { useGraphStore } from '../store/graphStore';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { Clapperboard, LayoutGrid } from 'lucide-react';
import './CanvasTabs.css';

/**
 * Two-button pill control at top center of canvas. Matches the Slava bottom
 * Toolbar aesthetic (glass + pill + 1px edge). Editor button is disabled
 * until an eligible video-producing node with a completed output is selected.
 */
export function CanvasTabs() {
  const viewMode = useUIStore((s) => s.viewMode);
  const enterEditor = useUIStore((s) => s.enterEditor);
  const exitEditor = useUIStore((s) => s.exitEditor);
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const nodes = useGraphStore((s) => s.nodes);

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : null;
  const def = selectedNode ? NODE_DEFINITIONS[selectedNode.data.definitionId] : null;
  const hasVideoOutput = def?.outputPorts.some((p) => p.dataType === 'Video') ?? false;
  const isComplete = selectedNode?.data.state === 'complete';
  const editorEnabled = (hasVideoOutput && isComplete) || viewMode === 'editor';

  let tooltip = '';
  if (!selectedNode) tooltip = 'Select a video node to edit';
  else if (!hasVideoOutput) tooltip = 'Selected node does not output video';
  else if (!isComplete) tooltip = 'Run the node first';

  return (
    <div className="canvas-tabs-wrap">
      <div className="canvas-tabs__wordmark">CANVAS(VIEW)</div>
      <div className="canvas-tabs">
        <button
          type="button"
          className={`canvas-tabs__btn ${viewMode === 'canvas' ? 'canvas-tabs__btn--active' : ''}`}
          onClick={() => { if (viewMode === 'editor') exitEditor(); }}
          aria-label="Canvas view"
        >
          <LayoutGrid className="canvas-tabs__icon" aria-hidden="true" focusable="false" />
          <span>Canvas</span>
        </button>
        <button
          type="button"
          className={`canvas-tabs__btn ${viewMode === 'editor' ? 'canvas-tabs__btn--active' : ''}`}
          onClick={() => {
            if (editorEnabled && selectedNodeId && viewMode === 'canvas') {
              enterEditor(selectedNodeId);
            }
          }}
          disabled={!editorEnabled}
          title={tooltip || undefined}
          aria-label="Editor view"
        >
          <Clapperboard className="canvas-tabs__icon" aria-hidden="true" focusable="false" />
          <span>Editor</span>
        </button>
      </div>
    </div>
  );
}
