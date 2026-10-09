import { Clapperboard } from 'lucide-react';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { currentMediaSource } from '../../lib/canvasNextSteps';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import type { DynamicNodeData, NodeData } from '../../types';
import '../../styles/canvas-next-steps.css';

function videoSource(data: NodeData, displayedOutputs: NodeData['outputs']) {
  const definition = NODE_DEFINITIONS[data.definitionId];
  const ports = (data as Partial<DynamicNodeData>).isDynamic === true
    ? (data as DynamicNodeData).dynamicOutputPorts
    : definition?.outputPorts;
  // The timeline's graph connection reads the canonical `video` port.
  // Auxiliary remote URIs and a batch preview's earlier result are not that source.
  return currentMediaSource({ outputPorts: (ports ?? []).filter((port) => port.id === 'video' && port.dataType === 'Video') },
    data, displayedOutputs);
}

/** Editing belongs to the video result, rather than the global workspace tabs. */
export function VideoEditAction({ id, data, displayedOutputs }: {
  id: string;
  data: NodeData;
  displayedOutputs: NodeData['outputs'];
}) {
  const isImportingGraph = useGraphStore((state) => state.isImportingGraph);
  const viewMode = useUIStore((state) => state.viewMode);
  const commonsEnabled = useUIStore((state) => state.commonsEnabled);
  const source = videoSource(data, displayedOutputs);
  if (!source) return null;
  const canvasActive = viewMode === 'canvas' || (viewMode === 'commons' && !commonsEnabled);

  return (
    <button type="button"
      className="model-node__next-step model-node__video-edit nodrag nopan"
      disabled={isImportingGraph || !canvasActive}
      title={isImportingGraph ? 'Wait for the graph import to finish' : 'Edit this video result'}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const ui = useUIStore.getState();
        const graph = useGraphStore.getState();
        const currentCanvas = ui.viewMode === 'canvas' || (ui.viewMode === 'commons' && !ui.commonsEnabled);
        if (!currentCanvas || graph.isImportingGraph) return;
        const current = graph.nodes.find((node) => node.id === id);
        // A removed/replaced node or refreshed output cannot inherit a stale
        // button activation before React commits its replacement.
        if (!current || current.data !== data) return;
        const currentSource = videoSource(current.data, displayedOutputs);
        if (!currentSource || currentSource.value !== source.value) return;
        ui.enterEditor(id);
      }}>
      <Clapperboard size={12} aria-hidden="true" focusable="false" />
      Edit video
    </button>
  );
}
