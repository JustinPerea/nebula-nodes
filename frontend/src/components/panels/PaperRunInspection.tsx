import { backendAssetUrlSync } from '../../lib/backend';
import type { RunRecord } from '../../lib/runHistory';

/** Inputs and outputs belong to this historical run, never the current canvas. */
export function PaperRunInspection({ record }: { record: RunRecord }) {
  if (!record.paperInputs?.length) return null;
  const outputs = Object.entries(record.resultOutputs ?? {}).flatMap(([nodeId, ports]) =>
    Object.entries(ports).flatMap(([portId, output]) =>
      typeof output.value === 'string' && ['Image', 'Video', 'Audio', 'SVG'].includes(output.type)
        ? [{ nodeId, portId, output }]
        : [],
    ),
  );
  return (
    <details className="run-history__paper-details">
      <summary>Inspect saved input and output snapshots</summary>
      <span className="run-history__paper-recipe" title={record.recipeRevision}>Recipe revision: <code>{record.recipeRevision ?? 'Unavailable'}</code></span>
      <span className="run-history__paper-recipe">Run: <code>{record.id}</code></span>
      {record.sourceRunId && <span className="run-history__paper-recipe">Recipe reused from: <code>{record.sourceRunId}</code></span>}
      {record.paperInputs.map((input) => {
        const snapshot = input.snapshot;
        return (
          <div key={`${input.nodeId}:${snapshot.id}`} className="run-history__paper-snapshot">
            <span>Input · {snapshot.identity.objectName} · {input.nodeId}</span>
            <a href={backendAssetUrlSync(snapshot.previewUrl)} target="_blank" rel="noopener noreferrer">
              <img src={backendAssetUrlSync(snapshot.previewUrl)} alt={`Saved Paper input ${snapshot.identity.objectName} for run ${record.id}`} />
            </a>
            <code title={snapshot.hash}>SHA-256: {snapshot.hash}</code>
            <span>{snapshot.capturedAt} · {snapshot.width} × {snapshot.height} · {snapshot.exportSettings.scale} PNG</span>
          </div>
        );
      })}
      {outputs.length > 0 ? outputs.map(({ nodeId, portId, output }) => {
        const pinnedSource = record.paperInputs?.find((input) => input.snapshot.filePath === output.value);
        const url = backendAssetUrlSync(pinnedSource?.snapshot.previewUrl ?? output.value as string);
        return <div key={`${nodeId}:${portId}`} className="run-history__paper-snapshot">
          <span>Output · {nodeId} / {portId}</span>
          {output.type === 'Image' || output.type === 'SVG' ? <img src={url} alt={`Saved output ${nodeId} for run ${record.id}`} />
            : output.type === 'Video' ? <video src={url} controls preload="metadata" />
            : <audio src={url} controls preload="metadata" />}
          <a href={url} target="_blank" rel="noopener noreferrer">Open saved {output.type.toLowerCase()}</a>
        </div>;
      }) : <span className="run-history__paper-recipe">No saved media outputs for this run yet.</span>}
    </details>
  );
}
