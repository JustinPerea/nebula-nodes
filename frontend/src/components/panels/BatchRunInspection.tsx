import { backendAssetUrlSync } from '../../lib/backend';
import { sanitizeVariantScopes, type RunRecord } from '../../lib/runHistory';
import { openOutputLabel } from '../../lib/openOutputLabel';
import { runNodeTitle, type LiveNodeName } from '../../lib/runNodeTitle';
import { useShallow } from 'zustand/react/shallow';
import { useGraphStore } from '../../store/graphStore';

function mediaUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const url = backendAssetUrlSync(value);
  // Saved history can be imported from storage. Only expose web asset URLs.
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Every successful iterator item remains accessible, even in a failed run. */
export function BatchRunInspection({ record }: { record: RunRecord }) {
  const batches = Object.entries(record.batchOutputs ?? {}).filter(([, batch]) => batch.length > 0);
  // Only the shown nodes' definitions and names, so dragging or editing params elsewhere does not re-render this.
  const liveKey = useGraphStore(useShallow((state) => batches.flatMap(([nodeId]) => {
    const data = state.nodes.find((node) => node.id === nodeId)?.data;
    return [data?.definitionId ?? '', typeof data?.label === 'string' ? data.label : ''];
  })));
  if (!batches.length) return null;
  const liveNames = new Map(batches.map(([nodeId], i): [string, LiveNodeName | undefined] => [nodeId,
    liveKey[i * 2] ? { definitionId: liveKey[i * 2], label: liveKey[i * 2 + 1] || undefined } : undefined]));
  const count = batches.reduce((total, [, batch]) => total + batch.length, 0);
  return (
    <details className="run-history__batch-details">
      <summary>Batch results · {count}</summary>
      {batches.flatMap(([nodeId, batch]) => {
        const variants = sanitizeVariantScopes(record.batchVariants?.[nodeId], batch.length);
        return batch.map((outputs, index) => {
          const scope = variants?.[index];
          const label = `${runNodeTitle(record.snapshot, liveNames.get(nodeId), nodeId)} · ${scope?.label || `Result ${index + 1}`}`;
          const lineage = scope?.lineage
            .map((item) => `${item.source_label}: ${item.item_label}`).join(' → ');
          return (
            <div className="run-history__batch-result" key={`${nodeId}:${index}`}>
              <span>{label}</span>
              {lineage && <span>{lineage}</span>}
              {Object.entries(outputs).map(([portId, output]) => {
                if (output.type === 'Text' && typeof output.value === 'string') {
                  return <p className="run-history__batch-text" key={portId}>{output.value}</p>;
                }
                const url = ['Image', 'Video', 'Audio', 'SVG', 'Mesh', 'Mask', 'DepthMap'].includes(output.type)
                  ? mediaUrl(output.value) : null;
                return url ? <a key={portId} href={url} target="_blank" rel="noopener noreferrer"
                  aria-label={`${openOutputLabel(output.type, portId)}, ${label}`}>
                  {openOutputLabel(output.type, portId)}
                </a> : null;
              })}
            </div>
          );
        });
      })}
    </details>
  );
}
