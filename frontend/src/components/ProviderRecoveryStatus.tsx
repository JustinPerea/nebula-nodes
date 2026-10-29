import { useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { useGraphStore } from '../store/graphStore';
import { UNLOCK_NODE_HEADING } from '../lib/api';
import { failureMessage } from '../lib/errorCopy';
import {
  UNLOCK_LABEL, UNLOCK_TITLE, WORLD_LABS_RUN_NEEDS_CHECK, WORLD_LABS_RUN_STATUS_UNKNOWN, moreNodesNeedCheck, recordNodeName, unlockAriaLabel, UNLOCK_RUN_ARIA,
} from '../lib/worldLabsWaiting';
import { useCanvasLock } from '../lib/canvasLock';

/** Persistent paid-provider safety status. Recovery-journal write warnings may
 * be dismissed; an ambiguous paid start remains until the user explicitly says
 * they checked Marble and the backend durably removes its fail-closed hold.
 * The person reads "World Labs run", never "paid start" (error copy round 3c). */
export function ProviderRecoveryStatus() {
  const warning = useGraphStore((state) => state.providerRecoveryWarning);
  const uncertainRunId = useGraphStore((state) => state.uncertainWorldLabsRunId);
  const ambiguities = useGraphStore((state) => state.providerStartAmbiguities);
  // The first held node's card title (a string, so a canvas edit elsewhere
  // doesn't re-render the bar).
  const heldTitle = useGraphStore((state) => {
    const held = state.providerStartAmbiguities[0];
    return held ? recordNodeName(state.nodes, held.nodeId, true) : null;
  });
  const acknowledge = useGraphStore((state) => state.acknowledgeProviderStartAmbiguity);
  const acknowledgeUncertainRun = useGraphStore(
    (state) => state.acknowledgeUncertainWorldLabsRun,
  );
  const dismiss = useGraphStore((state) => state.dismissProviderRecoveryWarning);
  // Offline is read-only (round 15 of PR #114): the unlock is disabled.
  // Round 23 (review 22, L-3): and while following an agent's switch, since
  // the store refuses both unlocks then too (EDIT_GATES); one lock for both.
  const lock = useCanvasLock();
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const ambiguity = ambiguities[0];

  if (!ambiguity && !warning) return null;

  const ambiguityKey = ambiguity ? `${ambiguity.kind}:${ambiguity.nodeId}` : null;
  const unlock = async () => {
    if (!ambiguity || !ambiguityKey || unlocking) return;
    setUnlocking(ambiguityKey);
    setUnlockError(null);
    try {
      await acknowledge(ambiguity.kind, ambiguity.nodeId);
    } catch (error) {
      // Never an error's own message (round 3b): a request's line, else GM's general line.
      setUnlockError(failureMessage(error, UNLOCK_NODE_HEADING));
    } finally {
      setUnlocking(null);
    }
  };

  return (
    <div className="provider-recovery-status" role="alert" aria-live="assertive">
      <span>
        <strong>{ambiguity
          ? WORLD_LABS_RUN_NEEDS_CHECK
          : uncertainRunId ? WORLD_LABS_RUN_STATUS_UNKNOWN : 'Recovery ID not saved.'}</strong>
        {' '}{ambiguity?.message ?? warning}
        {ambiguity && !ambiguity.durable && (
          // GM, round 3f.
          <> Nebula couldn't save the hold, so keep Nebula running until this run finishes.</>
        )}
        {ambiguities.length > 1 && (
          <> {moreNodesNeedCheck(ambiguities.length - 1)}</>
        )}
        {unlockError && <span className="provider-recovery-status__error"> {unlockError}</span>}
      </span>
      {ambiguity ? (
        <button
          type="button"
          className="provider-recovery-status__ack"
          onClick={() => void unlock()}
          {...lock.act({ disabled: unlocking === ambiguityKey, title: UNLOCK_TITLE, kept: 'unlock' })}
          // GM, round 13 of PR #114: the node by its card title. No confirm.
          aria-label={unlockAriaLabel(heldTitle ?? recordNodeName([], ambiguity.nodeId, true))}
        >
          <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
          {unlocking === ambiguityKey ? 'Unlocking…' : UNLOCK_LABEL}
        </button>
      ) : uncertainRunId ? (
        <button
          type="button"
          className="provider-recovery-status__ack"
          onClick={acknowledgeUncertainRun}
          {...lock.act({ title: UNLOCK_TITLE, kept: 'unlock' })}
          // No node to name: GM's line (round 14 of PR #114).
          aria-label={UNLOCK_RUN_ARIA}
        >
          <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
          {UNLOCK_LABEL}
        </button>
      ) : (
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss recovery warning"
          title="Dismiss"
        >
          <X size={15} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
