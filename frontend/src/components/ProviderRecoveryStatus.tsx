import { useCallback, useRef, useState } from 'react';
import { ShieldCheck, X } from 'lucide-react';
import { useGraphStore } from '../store/graphStore';
import { UNLOCK_NODE_HEADING } from '../lib/api';
import { failureMessage, curlApostrophes } from '../lib/errorCopy';
import {
  UNLOCK_LABEL, UNLOCK_TITLE, WORLD_LABS_RUN_NEEDS_CHECK, WORLD_LABS_RUN_STATUS_UNKNOWN, moreNodesNeedCheck, recordNodeName, unlockAriaLabel, UNLOCK_RUN_ARIA,
} from '../lib/worldLabsWaiting';
import { useCanvasLock } from '../lib/canvasLock';
import { useAnnounced } from '../lib/useAnnounced';
import { watchTopNotice } from '../lib/bottomBar';
import { LineText } from './LineText';

/** Persistent paid-provider safety status. Recovery-journal write warnings may
 * be dismissed; an ambiguous paid start remains until the user explicitly says
 * they checked Marble and the backend durably removes its fail-closed hold.
 * The person reads "World Labs run", never "paid start" (error copy). */
export function ProviderRecoveryStatus({ reopenLine = null }: {
  /** The person's held reopen, when the World Labs notice's press is what
   * clears it (PR #199): the box's second line, in the notice's own alert
   * region, so it is announced once, when it appears.
   * With nothing else to say (a `params` hold), the box holds only it. */
  reopenLine?: { line: string; onDismiss: () => void } | null;
} = {}) {
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
  // Offline is read-only (PR #114): the unlock is disabled. So is it while
  // following an agent's switch, since the store refuses both unlocks then
  // too (EDIT_GATES); one lock for both.
  const lock = useCanvasLock();
  const [unlocking, setUnlocking] = useState<string | null>(null);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const ambiguity = ambiguities[0];
  // Set once the line's box is in the page, so a box that arrives with it
  // (the params-only box) is announced too.
  const reopenText = useAnnounced(reopenLine?.line);
  // The selection toolbar moves below the box while it shows.
  const stopWatch = useRef<(() => void) | null>(null);
  const boxRef = useCallback((box: HTMLDivElement | null) => {
    stopWatch.current?.();
    stopWatch.current = box ? watchTopNotice(box) : null;
  }, []);

  if (!ambiguity && !warning && !reopenLine) return null;
  const reopen = reopenLine && (
    <div className="provider-recovery-status__reopen" data-reopen-hold-line>
      <span>{reopenText}</span>
      <button type="button" onClick={reopenLine.onDismiss} aria-label="Dismiss" title="Dismiss">
        <X size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  );
  if (!ambiguity && !warning) {
    return <div ref={boxRef} data-top-stack="" className="provider-recovery-status provider-recovery-status--reopen-only" role="alert" aria-live="assertive">{reopen}</div>;
  }

  const ambiguityKey = ambiguity ? `${ambiguity.kind}:${ambiguity.nodeId}` : null;
  const unlock = async () => {
    if (!ambiguity || !ambiguityKey || unlocking) return;
    setUnlocking(ambiguityKey);
    setUnlockError(null);
    try {
      await acknowledge(ambiguity.kind, ambiguity.nodeId);
    } catch (error) {
      // Never an error's own message: a request's line, else the general line (design).
      setUnlockError(failureMessage(error, UNLOCK_NODE_HEADING));
    } finally {
      setUnlocking(null);
    }
  };

  return (
    <div ref={boxRef} data-top-stack="" className="provider-recovery-status" role="alert" aria-live="assertive" data-line-box="">
      <span>
        <strong>{ambiguity
          ? WORLD_LABS_RUN_NEEDS_CHECK
          : uncertainRunId ? WORLD_LABS_RUN_STATUS_UNKNOWN : 'Recovery ID not saved.'}</strong>
        {' '}{curlApostrophes(ambiguity?.message ?? warning ?? '')}
        {ambiguity && !ambiguity.durable && (
          // The hold was not saved to disk, so the line says to keep Nebula running.
          <> Nebula couldn’t save the hold, so keep Nebula running until this run finishes.</>
        )}
        {ambiguities.length > 1 && (
          <> {moreNodesNeedCheck(ambiguities.length - 1)}</>
        )}
        {unlockError && <span className="provider-recovery-status__error"> <LineText text={unlockError} code /></span>}
      </span>
      {ambiguity ? (
        <button
          type="button"
          className="provider-recovery-status__ack"
          onClick={() => void unlock()}
          {...lock.act({ disabled: unlocking === ambiguityKey, title: UNLOCK_TITLE, kept: 'unlock' })}
          // Design, PR #114: the node by its card title. No confirm.
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
          // No node to name: the general line (design, PR #114).
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
      {reopen}
    </div>
  );
}
