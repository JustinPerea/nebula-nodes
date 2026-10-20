import { Suspense } from 'react';
import type { Edge, Node } from '@xyflow/react';
import type { ModelNodeDefinition, NodeData } from '../../types';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { DeferredMoodboardAdapterLine } from '../../lib/deferredChunks';
import { useGraphStore } from '../../store/graphStore';
import { DeferredBoundary } from '../DeferredBoundary';

interface MoodboardAdapterRowProps {
  data: NodeData;
  definition: ModelNodeDefinition;
  nodeId: string;
}

// The line's own empty box, so the card doesn't change height when the
// deferred chunk arrives (or if it can't).
const placeholder = <div className="model-node__board-line" aria-hidden="true" />;

// Nodes that pass their one input straight through (engine.py
// _PASSTHROUGH_NODE_IDS), followed back to where the value comes from.
const PASS_THROUGH: Readonly<Record<string, string>> = { reroute: 'input', router: 'input' };

/** Whether the wire into ``nodeId``'s Moodboard port carries a Nebula board:
 * its origin, through reroutes, is an output declared ``Moodboard``. Krea 2's
 * port also takes Krea's own Moodboard nodes (an ``Any`` output carrying a
 * Krea moodboard id, which the handler sends as one), and a saved project may
 * still hold a Text wire from before the port was retyped; neither is a
 * board, so the card says nothing about board images there. */
function wiredNebulaBoard(nodeId: string, nodes: readonly Node[], edges: readonly Edge[]): boolean {
  let edge = edges.find((candidate) => candidate.target === nodeId && candidate.targetHandle === 'moodboard');
  for (let hop = 0; edge && hop < 32; hop += 1) {
    const source = nodes.find((candidate) => candidate.id === edge?.source);
    const data = source?.data as (NodeData & { dynamicOutputPorts?: { id: string; dataType: string }[] }) | undefined;
    if (!data) return false;
    const through = PASS_THROUGH[data.definitionId];
    if (through) {
      const sourceId = source?.id;
      edge = edges.find((candidate) => candidate.target === sourceId && candidate.targetHandle === through);
      continue;
    }
    const ports = data.dynamicOutputPorts ?? NODE_DEFINITIONS[data.definitionId]?.outputPorts ?? [];
    return ports.find((port) => port.id === edge?.sourceHandle)?.dataType === 'Moodboard';
  }
  return false;
}

/** The Moodboard line under a card's ports, once a Nebula board is wired into
 * its Moodboard port (plan section 5.7.8). */
export function MoodboardAdapterRow({ data, definition, nodeId }: MoodboardAdapterRowProps) {
  const hasPort = definition.inputPorts.some((port) => port.id === 'moodboard');
  const wired = useGraphStore((state) => hasPort && wiredNebulaBoard(nodeId, state.nodes, state.edges));
  if (!wired) return null;
  return (
    <DeferredBoundary chunk={DeferredMoodboardAdapterLine} failed={placeholder}>
      <Suspense fallback={placeholder}>
        <DeferredMoodboardAdapterLine data={data} definition={definition} nodeId={nodeId} />
      </Suspense>
    </DeferredBoundary>
  );
}
