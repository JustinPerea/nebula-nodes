import { FailureLines } from '../failure/FailureLines';
import { ErrorDetails } from '../failure/ErrorDetails';
import { nodeErrorCopy, type NodeErrorSurface } from '../../lib/nodeErrorCopy';
import type { NodeData } from '../../types';
import { LineText } from '../LineText';

interface NodeErrorProps {
  category?: string;
  friendly?: string;
  /** The handler's line for the person (error copy round 3c). */
  person?: string;
  /** That line was written for a provider's answer: its words go behind
   * Details (round 3d). */
  providerText?: boolean;
  /** The provider the run called (round 3f): GM's general line names it. */
  provider?: string;
  /** Where it shows: "shot" on the Cinema shot panel, whose heading and
   * general line say "the shot" (rounds 3f and 3g). */
  surface?: NodeErrorSurface;
  /** A heading other than the surface's own. */
  heading?: string;
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
export function NodeError({ category, friendly, person, providerText, provider, surface, heading, raw, className = 'model-node__error' }: NodeErrorProps) {
  const copy = nodeErrorCopy({ raw, category, friendly, person, providerText, provider, surface, heading });
  const blocked = category === 'blocked' && !person;
  const modifier = `${className.split(' ').at(-1)}--blocked`;
  return (
    <div className={blocked ? `${className} ${modifier}` : className} data-line-box="">
      <span className="model-node__error-message">
        {copy.heading ? <FailureLines failure={copy} /> : <LineText text={copy.reason} />}
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
  data: Pick<NodeData, 'state' | 'error' | 'errorCategory' | 'errorFriendly' | 'errorPerson' | 'errorProviderText' | 'errorProvider'>;
  className: string;
}) {
  if (data.state !== 'error' || !data.error) return null;
  return (
    <NodeError className={`${className} model-node__error`} raw={data.error} category={data.errorCategory}
      friendly={data.errorFriendly} person={data.errorPerson} providerText={data.errorProviderText}
      provider={data.errorProvider} />
  );
}
