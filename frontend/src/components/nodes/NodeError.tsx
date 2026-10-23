import { FailureLines } from '../failure/FailureLines';
import { ErrorDetails } from '../failure/ErrorDetails';
import { nodeErrorCopy } from '../../lib/nodeErrorCopy';
import type { NodeData } from '../../types';

interface NodeErrorProps {
  category?: string;
  friendly?: string;
  /** The handler's line for the person (error copy round 3c). */
  person?: string;
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
export function NodeError({ category, friendly, person, raw, className = 'model-node__error' }: NodeErrorProps) {
  const copy = nodeErrorCopy({ raw, category, friendly, person });
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

/**
 * A card's run error, from its node data (error copy round 3e): the same
 * NodeError every card shows while the node's state is "error", nothing
 * otherwise, so it clears when the node runs again and reads the same after
 * a reload (a graph sync carries the same fields). `className` fits it to
 * the card ("<card>__run-error"); the shared look comes from
 * model-node__error, kept last so a block gets its calmer modifier.
 */
export function NodeRunError({ data, className }: {
  data: Pick<NodeData, 'state' | 'error' | 'errorCategory' | 'errorFriendly' | 'errorPerson'>;
  className: string;
}) {
  if (data.state !== 'error' || !data.error) return null;
  return (
    <NodeError className={`${className} model-node__error`} raw={data.error} category={data.errorCategory}
      friendly={data.errorFriendly} person={data.errorPerson} />
  );
}
