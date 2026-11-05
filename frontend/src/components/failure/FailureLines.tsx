import { shortReason, type FailureCopy } from '../../lib/errorCopy';
import { LineText } from '../LineText';

/**
 * A failure on a two-line surface (GM - Design, error-copy round 2):
 * "heading on line 1, reason on line 2" — "Couldn't save the board." over
 * "Nebula didn't respond. Try again." `retry` is for a surface whose own
 * retry button shows with the line (GM's WRAP rule: "the reason line drops
 * its 'try again'. The button is the retry."). A plain string (a line the
 * screen wrote itself) shows as it is. Its text reads as one line to a
 * screen reader and in textContent: "<heading> <reason>".
 */
export function FailureLines({ failure, retry = false }: { failure: FailureCopy | string; retry?: boolean }) {
  // Round 9: through <LineText>, so a not-connected line registers (lib/notConnectedLine).
  if (typeof failure === 'string') return <LineText text={failure} />;
  const reason = retry ? shortReason(failure.reason) : failure.reason;
  return (
    <span className="failure-lines">
      {failure.heading && <LineText className="failure-lines__heading" text={failure.heading} />}
      {failure.heading && ' '}
      <LineText className="failure-lines__reason" text={reason} />
    </span>
  );
}
