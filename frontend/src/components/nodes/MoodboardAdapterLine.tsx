import { useEffect } from 'react';
import type { ModelNodeDefinition, NodeData } from '../../types';
import { adapterLine, adapterRoute, nodeAdapterEntry } from '../../lib/moodboardAdapters';
import { nodeWiredPorts } from '../../lib/runScope';
import { useGraphStore } from '../../store/graphStore';
import { useMoodboardAdapterStore } from '../../store/moodboardAdapterStore';
import { useUIStore } from '../../store/uiStore';

export interface MoodboardAdapterLineProps {
  data: NodeData;
  definition: ModelNodeDefinition;
  nodeId: string;
}

/** What a wired moodboard does on this node, from its adapter entry for the
 * node's model and the route its next run takes (lib/moodboardAdapters.ts).
 * Deferred (lib/deferredChunks.ts); MoodboardAdapterRow draws the same empty
 * line while this chunk or the table loads, so the card keeps its height. */
export function MoodboardAdapterLine({ data, definition, nodeId }: MoodboardAdapterLineProps) {
  const entries = useMoodboardAdapterStore((state) => state.entries);
  const failed = useMoodboardAdapterStore((state) => state.failed);
  const load = useMoodboardAdapterStore((state) => state.load);
  const apiKeys = useUIStore((state) => state.settingsCache.apiKeys);
  // A joined string, so edge changes elsewhere on the canvas don't re-render this card.
  const wired = useGraphStore((state) => nodeWiredPorts(nodeId, state.edges).join('\n'));

  useEffect(() => { void load(); }, [load]);

  if (!entries) return failed ? null : <div className="model-node__board-line" aria-hidden="true" />;
  const route = adapterRoute(definition, data.params, wired ? wired.split('\n') : [], apiKeys);
  const line = adapterLine(nodeAdapterEntry(entries, definition, data.params, route), definition);
  return (
    <div className="model-node__board-line" role="note" aria-label={`Moodboard: ${line}`}>
      <span className="model-node__board-line-text">{line}</span>
    </div>
  );
}
