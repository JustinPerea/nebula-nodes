import { useUIStore } from '../store/uiStore';
import { useGraphStore } from '../store/graphStore';
import { NODE_DEFINITIONS } from '../constants/nodeDefinitions';
import { Clapperboard } from 'lucide-react';
import { WorkspaceHeader } from './WorkspaceHeader';
import type { NodeData } from '../types';
import './CanvasTabs.css';

function hasReadyVideo(data: NodeData): boolean {
  const definition = NODE_DEFINITIONS[data.definitionId];
  return data.state === 'complete' && !!definition?.outputPorts.some((port) => {
    if (port.dataType !== 'Video') return false;
    const output = data.outputs?.[port.id];
    return output?.type === 'Video' && typeof output.value === 'string' && output.value.trim().length > 0;
  });
}

/** Canvas identity and the contextual video-editing action; Canvas-only chrome. */
export function CanvasTabs() {
  const viewMode = useUIStore((s) => s.viewMode);
  const enterEditor = useUIStore((s) => s.enterEditor);
  const selectedNodeId = useUIStore((s) => s.selectedNodeId);
  const commonsEnabled = useUIStore((s) => s.commonsEnabled);
  const nodes = useGraphStore((s) => s.nodes);
  const isImportingGraph = useGraphStore((s) => s.isImportingGraph);

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) : null;
  const def = selectedNode ? NODE_DEFINITIONS[selectedNode.data.definitionId] : null;
  const hasVideoOutput = def?.outputPorts.some((p) => p.dataType === 'Video') ?? false;
  const isComplete = selectedNode?.data.state === 'complete';
  const editorEnabled = !!selectedNode && hasReadyVideo(selectedNode.data) && !isImportingGraph;

  let tooltip = '';
  if (!selectedNode) tooltip = 'Select a video node to edit';
  else if (!hasVideoOutput) tooltip = 'Selected node does not output video';
  else if (!isComplete) tooltip = 'Run the node first';
  else if (!hasReadyVideo(selectedNode.data)) tooltip = 'The selected node has no video result to edit';
  else if (isImportingGraph) tooltip = 'Wait for the graph import to finish';

  if (viewMode !== 'canvas' && !(viewMode === 'commons' && !commonsEnabled)) return null;

  return (
    <div className="canvas-tabs-wrap">
      <WorkspaceHeader title="Canvas" className="workspace-header--canvas">
        <button
          type="button"
          className="canvas-tabs__btn"
          onClick={() => {
            // Selection, output and graph ownership can change before React
            // commits a refreshed header. Only the current source can open.
            const ui = useUIStore.getState();
            const graph = useGraphStore.getState();
            const canvasActive = ui.viewMode === 'canvas' || (ui.viewMode === 'commons' && !ui.commonsEnabled);
            if (!canvasActive || graph.isImportingGraph || !selectedNodeId || ui.selectedNodeId !== selectedNodeId) return;
            const current = graph.nodes.find((node) => node.id === selectedNodeId);
            if (current && hasReadyVideo(current.data)) enterEditor(current.id);
          }}
          disabled={!editorEnabled}
          title={tooltip || undefined}
          aria-label="Edit selected video"
        >
          <Clapperboard className="canvas-tabs__icon" aria-hidden="true" focusable="false" />
          <span>Edit video</span>
        </button>
      </WorkspaceHeader>
    </div>
  );
}
