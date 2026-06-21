interface NodeErrorProps {
  category?: string;
  friendly?: string;
  raw?: string;
}

/**
 * Renders a node execution error. For classified errors — especially `blocked`
 * safety/moderation rejections — it shows a calm, actionable friendly message
 * with the raw provider string preserved in an expandable <details> so nothing
 * is lost for debugging. Falls back to the raw error verbatim when no
 * classification is present (backward compatible with pre-classifier events).
 */
export function NodeError({ category, friendly, raw }: NodeErrorProps) {
  const message = friendly || raw || 'Something went wrong.';
  const showRaw = !!raw && raw !== message;
  const blocked = category === 'blocked';
  return (
    <div className={`model-node__error${blocked ? ' model-node__error--blocked' : ''}`}>
      <span className="model-node__error-message">{message}</span>
      {showRaw && (
        <details className="model-node__error-details">
          <summary>Details</summary>
          <span className="model-node__error-raw">{raw}</span>
        </details>
      )}
    </div>
  );
}
