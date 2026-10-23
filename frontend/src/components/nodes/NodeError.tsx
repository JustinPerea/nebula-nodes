import { FailureLines } from '../failure/FailureLines';
import { ErrorDetails } from '../failure/ErrorDetails';
import { nodeErrorCopy } from '../../lib/nodeErrorCopy';

interface NodeErrorProps {
  category?: string;
  friendly?: string;
  /** The handler's line for the person (error copy round 3c). */
  person?: string;
  /** That line was written for a provider's answer: its words go behind
   * Details (round 3d). */
  providerText?: boolean;
  raw?: string;
  /** Classes for the outer block (Create Studio's result card has its own). */
  className?: string;
}

/**
 * A node's run error on its card (error copy round 3c, GM - Design): the
 * heading "Couldn't run the node." over the person's line, the classifier's
 * line, or GM's general line, with the raw provider text behind a collapsed
 * Details toggle when the line isn't it (lib/nodeErrorCopy.ts). A line the
 * handler wrote for the person never shows the specific text: that is for
 * agents. A line Nebula wrote itself (a refused start, a pre-run check) has
 * no category and shows as it is. Safety/moderation blocks keep their calmer
 * treatment.
 */
export function NodeError({ category, friendly, person, providerText, raw, className = 'model-node__error' }: NodeErrorProps) {
  const copy = nodeErrorCopy({ raw, category, friendly, person, providerText });
  const blocked = category === 'blocked' && !person;
  const modifier = `${className.split(' ').at(-1)}--blocked`;
  return (
    <div className={blocked ? `${className} ${modifier}` : className}>
      <span className="model-node__error-message">
        {copy.heading ? <FailureLines failure={copy} /> : copy.reason}
      </span>
      {copy.details && <ErrorDetails raw={copy.details} className="model-node__error-details nodrag nowheel" />}
    </div>
  );
}
