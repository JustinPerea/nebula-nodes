import { backendAssetUrlSync } from '../../lib/backend';
import type { RunRecord } from '../../lib/runHistory';

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
  if (!batches.length) return null;
  const count = batches.reduce((total, [, batch]) => total + batch.length, 0);
  return (
    <details className="run-history__batch-details">
      <summary>Batch results · {count}</summary>
      {batches.flatMap(([nodeId, batch]) => batch.map((outputs, index) => (
        <div className="run-history__batch-result" key={`${nodeId}:${index}`}>
          <span>{nodeId} · Result {index + 1}</span>
          {Object.entries(outputs).map(([portId, output]) => {
            if (output.type === 'Text' && typeof output.value === 'string') {
              return <pre key={portId}>{output.value}</pre>;
            }
            const url = ['Image', 'Video', 'Audio', 'SVG', 'Mesh'].includes(output.type)
              ? mediaUrl(output.value) : null;
            return url ? <a key={portId} href={url} target="_blank" rel="noopener noreferrer">
              Open {output.type.toLowerCase()} · {portId}
            </a> : null;
          })}
        </div>
      )))}
    </details>
  );
}
