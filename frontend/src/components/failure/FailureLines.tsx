import { becauseLine, failedWhat, type FailureCopy } from '../../lib/errorCopy';
import { LineText, type LineTone } from '../LineText';

/**
 * A failure on a surface (copy design, because form): one sentence, "Nebula couldn’t save the board
 * because the server didn’t respond. Try again." (lib/errorCopy becauseLine; failureCopy makes the
 * line). `retry` is for a surface whose own Try again button shows with the line, so the line ends
 * "Try again." (failureCopy's `button`). A plain string (a line the screen wrote itself) shows as it
 * is. A notice that is not a failure (a node's "Waiting for you to run it") keeps its heading line over the sentence. `tone="failure"` keeps the warning colour for a line that reports a failure to run or a loss
 * (a node card's run failure); every other because line draws neutral (LineText).
 */
export function FailureLines({ failure, retry = false, tone }: { failure: FailureCopy | string; retry?: boolean; tone?: LineTone }) {
  // Through <LineText>, so a not-connected line registers (lib/notConnectedLine).
  if (typeof failure === 'string') return <LineText text={failure} tone={tone} />;
  // A heading of the form "Couldn’t ‹x›." over a reason (a failure built by hand, not by failureCopy) is one sentence too.
  const made = failure.heading !== '' && failedWhat(failure.heading) !== null;
  const line = made ? becauseLine(failure, retry ? 'button' : 'alone')
    : (retry ? failure.button ?? failure.reason : failure.reason) || failure.reason;
  return (
    <span className="failure-lines">
      {failure.heading && !made && <LineText className="failure-lines__heading" text={failure.heading} tone={tone} />}
      {failure.heading && !made && ' '}
      <LineText className="failure-lines__reason" text={line} tone={tone} />
    </span>
  );
}
