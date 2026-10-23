import { useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { useGraphStore } from '../store/graphStore';
import { UNLOCK_NODE_HEADING } from '../lib/api';
import { failureMessage } from '../lib/errorCopy';
import { WORLD_LABS_RUN_NEEDS_CHECK, WORLD_LABS_RUN_STATUS_UNKNOWN, moreNodesNeedCheck } from '../lib/worldLabsWaiting';

/** Persistent paid-provider safety status. Recovery-journal write warnings may
 * be dismissed; an ambiguous paid start remains until the user explicitly says
 * they checked Marble and the backend durably removes its fail-closed hold.
 * The person reads "World Labs run", never "paid start" (error copy round 3c). */
export function ProviderRecoveryStatus() {
  const warning = useGraphStore((state) => state.providerRecoveryWarning);
  const uncertainRunId = useGraphStore((state) => state.uncertainWorldLabsRunId);
  const ambiguities = useGraphStore((state) => state.providerStartAmbiguities);
  const acknowledge = useGraphStore((state) => state.acknowledgeProviderStartAmbiguity);
  const acknowledgeUncertainRun = useGraphStore(
    (state) => state.acknowledgeUncertainWorldLabsRun,
  );
  const dismiss = useGraphStore((state) => state.dismissProviderRecoveryWarning);
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
          <> The hold could not be saved durably; do not restart the backend.</>
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
          disabled={unlocking === ambiguityKey}
          aria-label={`I checked Marble; unlock node ${ambiguity.nodeId}`}
          title="Only unlock after checking Marble for an accepted operation"
        >
          <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
          {unlocking === ambiguityKey ? 'Unlocking…' : 'Checked Marble — unlock'}
        </button>
      ) : uncertainRunId ? (
        <button
          type="button"
          className="provider-recovery-status__ack"
          onClick={acknowledgeUncertainRun}
          aria-label="I checked Marble; unlock the unconfirmed run"
          title="Only unlock after checking Marble for an accepted operation"
        >
          <ShieldCheck size={15} strokeWidth={1.8} aria-hidden="true" />
          Checked Marble — unlock
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
