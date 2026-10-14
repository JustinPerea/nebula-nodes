import { skippedLabel } from '../../lib/gating';
import '../../styles/gating.css';

/** The "Skipped" chip on a node a gate skipped; the reason shows on hover.
 * Rendered as its own card child so the rest of the card can dim around it. */
export function SkippedBadge({ reason }: { reason?: string }) {
  const label = skippedLabel(reason);
  return (
    <div className="node-skip" role="status" title={label} aria-label={label}>
      <span className="node-skip__dot" aria-hidden="true" />
      <span className="node-skip__text">Skipped</span>
    </div>
  );
}
