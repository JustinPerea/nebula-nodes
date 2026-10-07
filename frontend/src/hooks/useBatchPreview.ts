import { useState } from 'react';
import type { NodeData } from '../types';

/** Selection belongs to the rendered preview, never the graph or execution
 * inputs. A new owning run/node displays its first result immediately. */
export function useBatchPreview(nodeId: string, data: NodeData) {
  const results = data.batchOutputs ?? [];
  const key = `${nodeId}:${data.batchRunId ?? ''}`;
  const [selection, setSelection] = useState({ key, index: 0 });
  const index = selection.key === key ? Math.max(0, Math.min(selection.index, results.length - 1)) : 0;
  const running = data.state === 'queued' || data.state === 'executing';
  const browsing = !running && results.length > 0;
  const scope = browsing ? data.batchVariants?.[index] : undefined;
  const label = browsing ? scope?.label || `Result ${index + 1}` : undefined;
  const lineage = scope?.lineage.map((item) => `${item.source_label}: ${item.item_label}`).join(' → ');

  return {
    outputs: browsing ? results[index] : data.outputs,
    count: results.length,
    index,
    label,
    lineage,
    running,
    browsing,
    select: (nextIndex: number) => {
      if (!running && results.length) {
        setSelection({ key, index: Math.max(0, Math.min(nextIndex, results.length - 1)) });
      }
    },
  };
}

export type BatchPreview = ReturnType<typeof useBatchPreview>;
