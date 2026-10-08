import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import type { ResultContext } from '../../lib/resultContext';

export function ResultMetadata({ context }: { context: ResultContext }) {
  const date = context.timestamp !== undefined ? new Date(context.timestamp) : null;
  return (
    <div className="result-metadata">
      <span>{context.modelName}</span>
      {date && Number.isFinite(date.getTime()) && (
        <time dateTime={date.toISOString()} title={date.toLocaleString()}>
          {date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </time>
      )}
    </div>
  );
}

function settingValue(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value || 'Empty';
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

export function ResultDetails({ context }: { context: ResultContext }) {
  const definition = NODE_DEFINITIONS[context.definitionId];
  const parameterDefinitions = definition ? [...definition.params, ...(definition.sharedParams ?? []),
    ...(definition.directParams ?? []), ...(definition.falParams ?? [])] : [];
  const saved = context.provenance === 'saved-run';
  return (
    <details className="result-recipe">
      <summary>{saved ? 'Saved recipe' : 'Current settings · recipe not recorded'}</summary>
      <div className="result-recipe__body">
        {!saved && <p>The original recipe is not recorded for this output. These are the node’s current settings.</p>}
        {context.prompt && <><strong>Prompt</strong><p className="result-recipe__prompt">{context.prompt}</p></>}
        <dl>
          {Object.entries(context.params).map(([key, value]) => (
            <div key={key}>
              <dt>{key === '_kreaAuth' ? 'Krea access' : parameterDefinitions.find((param) => param.key === key)?.label ?? key}</dt>
              <dd>{settingValue(value)}</dd>
            </div>
          ))}
        </dl>
        {saved && <p>{context.refs.length} recorded reference{context.refs.length === 1 ? '' : 's'} from image inputs</p>}
        {context.inputs?.length ? <>
          <strong>Connected inputs</strong>
          <dl>{context.inputs.map((input, index) => <div key={`${index}-${input.label}`}>
            <dt>{input.label}</dt>
            <dd>{input.resolved ? settingValue(input.value) : 'Unavailable in this saved run'}</dd>
          </div>)}</dl>
        </> : context.refs.length > 0 && <ol>{context.refs.map((ref, index) => <li key={`${index}-${ref}`}>{ref}</li>)}</ol>}
        {context.reuseUnavailableReason && <p className="result-recipe__note">{context.reuseUnavailableReason}</p>}
        {saved && definition?.sharedParams && <p className="result-recipe__note">Generation uses your current configured provider connection.</p>}
        {context.runId && <small>Run {context.runId}</small>}
      </div>
    </details>
  );
}
