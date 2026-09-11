import { useEffect, useState } from 'react';
import { X, RotateCcw, ShieldCheck, Square, Trash2 } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import {
  formatRunAge,
  formatRunDuration,
  isWorldLabsRecoveryReplayBlocked,
  isWorldLabsRecoveryReplayReady,
  runTriggerLabel,
  type RunRecord,
} from '../../lib/runHistory';
import '../../styles/panels.css';
import '../../styles/run-history.css';

const STATUS_LABEL: Record<RunRecord['status'], string> = {
  running: 'Running',
  complete: 'Complete',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/**
 * Run History panel — a persistent, newest-first record of graph / single-node /
 * selection runs. Terminal records replay their frozen request snapshot, while
 * failed records use the more explicit Retry failed action. Cancel propagates
 * to the backend execution task; Clear removes both UI and persisted history.
 */
export function RunHistoryPanel() {
  const visible = useUIStore((s) => s.panels.history.visible);
  const togglePanel = useUIStore((s) => s.togglePanel);

  const runHistory = useGraphStore((s) => s.runHistory);
  const clearRunHistory = useGraphStore((s) => s.clearRunHistory);
  const providerRecoveries = useGraphStore((s) => s.providerRecoveries);
  const providerStartAmbiguities = useGraphStore((s) => s.providerStartAmbiguities);
  const deleteProviderRecovery = useGraphStore((s) => s.deleteProviderRecovery);
  const rerunHistoryRecord = useGraphStore((s) => s.rerunHistoryRecord);
  const retryFailedRun = useGraphStore((s) => s.retryFailedRun);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const isCancelling = useGraphStore((s) => s.isCancelling);
  const cancelExecution = useGraphStore((s) => s.cancelExecution);

  const [now, setNow] = useState(() => Date.now());
  const [clearingRecovery, setClearingRecovery] = useState<string | null>(null);

  const forgetRecovery = async (runId: string, nodeId: string) => {
    const confirmed = window.confirm(
      `Forget the World Labs recovery safeguard for ${nodeId}?\n\n`
      + 'Only continue after checking Marble. This removes the saved recovery ID '
      + 'and allows a future fresh paid request for this node.',
    );
    if (!confirmed) return;
    const key = `${runId}:${nodeId}`;
    setClearingRecovery(key);
    try {
      await deleteProviderRecovery(runId, nodeId);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not clear the recovery safeguard.');
    } finally {
      setClearingRecovery(null);
    }
  };

  // Keep relative ages fresh while the panel is open (1s tick). Cheap; only the
  // age labels re-derive. Skips entirely while hidden.
  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [visible]);

  const { shouldRender, exiting } = useDelayedUnmount(visible, 500);
  if (!shouldRender) return null;

  return (
    <div
      className={`panel panel--history workspace-dock-panel${exiting ? ' panel--exiting' : ''}`}
    >
      <div className="panel__header">
        <span className="panel__title">Run History</span>
        <div className="run-history__header-actions">
          <button
            type="button"
            className="panel__header-action run-history__action"
            onClick={() => void cancelExecution()}
            disabled={!isExecuting || isCancelling}
            aria-busy={isCancelling}
            aria-label="Cancel running execution"
            title={isCancelling
              ? 'Waiting for execution to stop safely'
              : isExecuting ? 'Cancel running execution' : 'Nothing running'}
          >
            <Square size={13} strokeWidth={2} aria-hidden="true" focusable="false" />
          </button>
          <button
            type="button"
            className="panel__header-action run-history__action"
            onClick={clearRunHistory}
            disabled={runHistory.length === 0
              || isExecuting
              || providerRecoveries.length > 0
              || providerStartAmbiguities.length > 0}
            aria-label="Clear run history"
            title={isExecuting
              ? 'Wait for the active run to finish'
              : providerRecoveries.length > 0 || providerStartAmbiguities.length > 0
                ? 'Resolve World Labs safety records before clearing history'
                : 'Clear run history'}
          >
            <Trash2 size={13} strokeWidth={1.85} aria-hidden="true" focusable="false" />
          </button>
          <button
            type="button"
            className="panel__header-action panel__close"
            onClick={() => togglePanel('history')}
            aria-label="Close run history panel"
            title="Close"
          >
            <X className="panel__close-icon" size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" />
          </button>
        </div>
      </div>

      <div className="panel__body panel__body--history">
        {providerRecoveries.length > 0 && (
          <section className="run-history__safeguards" aria-label="World Labs recovery safeguards">
            <div className="run-history__safeguards-title">World Labs recovery safeguards</div>
            <p>
              These IDs prevent an accidental second paid start. Keep them unless you have
              checked Marble and intentionally want to forget recovery.
            </p>
            <ul>
              {providerRecoveries.map((checkpoint) => {
                const key = `${checkpoint.runId}:${checkpoint.nodeId}`;
                const recoveryId = checkpoint.existingWorldId ?? checkpoint.resumeOperationId;
                return (
                  <li key={key}>
                    <span title={`${checkpoint.nodeId} · ${recoveryId ?? ''}`}>
                      {checkpoint.nodeId} · {checkpoint.existingWorldId ? 'world' : 'operation'}{' '}
                      <code>{recoveryId}</code>
                      {checkpoint.durable === false && ' · volatile; keep this tab open'}
                    </span>
                    {checkpoint.durable !== false && (
                      <button
                        type="button"
                        onClick={() => void forgetRecovery(checkpoint.runId, checkpoint.nodeId)}
                        disabled={isExecuting || clearingRecovery === key}
                        aria-label={`Checked Marble; forget recovery for ${checkpoint.nodeId}`}
                        title="Check Marble first; forgetting permits a future fresh paid request"
                      >
                        <ShieldCheck size={11} aria-hidden="true" />
                        {clearingRecovery === key ? 'Clearing…' : 'Checked Marble — forget'}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {runHistory.length === 0 ? (
          <div className="run-history__empty">No saved runs yet.</div>
        ) : (
          <ul className="run-history__list">
            {runHistory.map((r) => {
              const recoveryReplayBlocked = isWorldLabsRecoveryReplayBlocked(r);
              const recoveryReplayReady = isWorldLabsRecoveryReplayReady(r);
              return (
              <li key={r.id} className="run-history__item">
                <span
                  className={`run-history__dot run-history__dot--${r.status}`}
                  aria-hidden="true"
                />
                <span className="run-history__meta">
                  <span className="run-history__row">
                    <span className="run-history__trigger">{runTriggerLabel(r.trigger)}</span>
                    <span className={`run-history__status run-history__status--${r.status}`}>
                      {STATUS_LABEL[r.status]}
                    </span>
                  </span>
                  <span className="run-history__sub">
                    {formatRunAge(now, r.startedAt)}
                    {r.status !== 'running' && r.durationSec != null && (
                      <> · {formatRunDuration(r.durationSec)}</>
                    )}
                    {r.nodesExecuted != null && (
                      <> · {r.nodesExecuted} node{r.nodesExecuted === 1 ? '' : 's'}</>
                    )}
                    {r.targetNodeId && (
                      <span className="run-history__target" title={r.targetNodeId}>
                        {' '}· target {r.targetNodeId}
                      </span>
                    )}
                  </span>
                  {r.statusNote && (
                    <span className="run-history__status-note">{r.statusNote}</span>
                  )}
                  {r.status !== 'running' && !recoveryReplayBlocked && (
                    <span className="run-history__item-actions">
                      <button
                        type="button"
                        className="run-history__replay"
                        onClick={() => {
                          if (r.status === 'failed') void retryFailedRun(r.id);
                          else void rerunHistoryRecord(r.id);
                        }}
                        disabled={isExecuting}
                        aria-label={recoveryReplayReady
                          ? `Recover ${runTriggerLabel(r.trigger)} run`
                          : r.status === 'failed'
                          ? `Retry failed ${runTriggerLabel(r.trigger)} run`
                          : `Rerun ${runTriggerLabel(r.trigger)}`}
                        title={isExecuting
                          ? 'Wait for the active run to finish'
                          : recoveryReplayReady
                            ? 'Resume the exact saved provider checkpoint'
                            : 'Run the exact saved graph snapshot'}
                      >
                        <RotateCcw size={11} strokeWidth={2} aria-hidden="true" focusable="false" />
                        {recoveryReplayReady ? 'Recover' : r.status === 'failed' ? 'Retry failed' : 'Rerun'}
                      </button>
                    </span>
                  )}
                  {recoveryReplayBlocked && (
                    <span className="run-history__replay-blocked">
                      Recovery ID unavailable — check Marble and the live World node
                    </span>
                  )}
                </span>
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
