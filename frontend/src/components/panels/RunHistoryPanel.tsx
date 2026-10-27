import { useEffect, useState } from 'react';
import { X, RotateCcw, ShieldCheck, Square, Trash2 } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { useDelayedUnmount } from '../../hooks/useDelayedUnmount';
import { PaperRunInspection } from './PaperRunInspection';
import { BatchRunInspection } from './BatchRunInspection';
import { ScrollFade } from '../ScrollFade';
import { ForgetRecoveryConfirm } from './ForgetRecoveryConfirm';
import { FORGET_LABEL, FORGET_TITLE, forgetAriaLabel, recordNodeName, recoveryIdLabel } from '../../lib/worldLabsWaiting';
import { FORGET_RECOVERY_HEADING } from '../../lib/api';
import { failureMessage } from '../../lib/errorCopy';
import { showNotice } from '../../lib/canvasNotice';
import type { PaperSourceRecord } from '../../lib/paperSource';
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
import { offlineMark, useBackendOffline } from '../../lib/useBackendOffline';

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
  const nodes = useGraphStore((s) => s.nodes);
  const clearRunHistory = useGraphStore((s) => s.clearRunHistory);
  const providerRecoveries = useGraphStore((s) => s.providerRecoveries);
  const providerStartAmbiguities = useGraphStore((s) => s.providerStartAmbiguities);
  const deleteProviderRecovery = useGraphStore((s) => s.deleteProviderRecovery);
  const rerunHistoryRecord = useGraphStore((s) => s.rerunHistoryRecord);
  const rerunHistoryWithLatestPaperSource = useGraphStore((s) => s.rerunHistoryWithLatestPaperSource);
  const retryFailedRun = useGraphStore((s) => s.retryFailedRun);
  const isExecuting = useGraphStore((s) => s.isExecuting);
  const isCancelling = useGraphStore((s) => s.isCancelling);
  const cancelExecution = useGraphStore((s) => s.cancelExecution);
  // Offline is read-only (round 15 of PR #114): Stop, Rerun, Retry, Recover
  // and Forget ID are disabled and look it.
  const offline = useBackendOffline();
  const off = offlineMark(offline);

  const [now, setNow] = useState(() => Date.now());
  const [clearingRecovery, setClearingRecovery] = useState<string | null>(null);
  // "Forget ID" asks first, in the app's own dialog (GM, round 13 of PR #114).
  const [confirmingForget, setConfirmingForget] = useState<{ runId: string; nodeId: string } | null>(null);

  const forgetRecovery = async (runId: string, nodeId: string) => {
    const key = `${runId}:${nodeId}`;
    setClearingRecovery(key);
    try {
      await deleteProviderRecovery(runId, nodeId);
    } catch (error) {
      // Round 3b: a request's line or the store's written one; any other
      // error says GM's general line, never its own message.
      showNotice(failureMessage(error, FORGET_RECOVERY_HEADING));
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

  // Closing Run History cancels a confirm that's open (review 13, L5: it
  // stayed open behind the closing panel and came back when it reopened).
  useEffect(() => {
    if (!visible) setConfirmingForget(null);
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
            disabled={!isExecuting || isCancelling || offline}
            {...off}
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

      <ScrollFade className="panel__body panel__body--history">
        {providerRecoveries.length > 0 && (
          <section className="run-history__safeguards" aria-label="World Labs recovery safeguards">
            <div className="run-history__safeguards-title">World Labs recovery safeguards</div>
            <p>
              These IDs prevent an accidental second World Labs run. Keep them unless you have
              checked Marble and intentionally want to forget recovery.
            </p>
            <ul>
              {providerRecoveries.map((checkpoint) => {
                const key = `${checkpoint.runId}:${checkpoint.nodeId}`;
                const recoveryId = checkpoint.existingWorldId ?? checkpoint.resumeOperationId;
                // GM, round 14 of PR #114: named by node, then "Operation ID"
                // or "World ID", the ID in mono (was "n2 · operation op-…").
                const name = recordNodeName(nodes, checkpoint.nodeId);
                const idLabel = recoveryIdLabel(checkpoint.existingWorldId);
                return (
                  <li key={key}>
                    <span id={`run-history-recovery-${key}`} title={`${name} · ${idLabel} ${recoveryId ?? ''}`}>
                      {name} · {idLabel}{' '}
                      <code>{recoveryId}</code>
                      {checkpoint.durable === false && ' · volatile; keep this tab open'}
                    </span>
                    {checkpoint.durable !== false && (
                      <button
                        type="button"
                        onClick={() => setConfirmingForget({ runId: checkpoint.runId, nodeId: checkpoint.nodeId })}
                        disabled={isExecuting || clearingRecovery === key || offline}
                        {...off}
                        // GM, round 14: its name says which ID it forgets;
                        // its row (node and ID) stays its description.
                        aria-label={forgetAriaLabel(recordNodeName(nodes, checkpoint.nodeId, true))}
                        aria-describedby={`run-history-recovery-${key}`}
                        // GM, round 15 of PR #114.
                        title={FORGET_TITLE}
                      >
                        <ShieldCheck size={11} aria-hidden="true" />
                        {clearingRecovery === key ? 'Clearing…' : FORGET_LABEL}
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
          <ScrollFade as="ul" className="run-history__list">
            {runHistory.map((r) => {
              // Fanout executes downstream nodes repeatedly. The engine count
              // measures execution steps, rather than distinct canvas nodes.
              const executedUnit = r.batchOutputs ? 'step' : 'node';
              const recoveryReplayBlocked = isWorldLabsRecoveryReplayBlocked(r);
              const recoveryReplayReady = isWorldLabsRecoveryReplayReady(r);
              const latestSourceReady = r.paperInputs?.every((input) => {
                const source = nodes.find((node) => node.id === input.nodeId)?.data.params._paperSource as PaperSourceRecord | undefined;
                return source?.state === 'current' && Boolean(source.snapshot);
              });
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
                      <> · {r.nodesExecuted} {executedUnit}{r.nodesExecuted === 1 ? '' : 's'}</>
                    )}
                    {r.skippedNodes && Object.keys(r.skippedNodes).length > 0 && (
                      <span
                        className="run-history__skipped"
                        title={Object.entries(r.skippedNodes).map(([id, reason]) => `${id} skipped: ${reason}`).join('\n')}
                      >
                        {' '}· {Object.keys(r.skippedNodes).length} skipped
                      </span>
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
                  {Boolean(r.outOfDateReasons?.length) && (
                    <span className="run-history__paper-stale" role="status">
                      <strong>Out of date</strong>
                      {r.outOfDateReasons?.map((reason) => <span key={reason}>{reason}</span>)}
                    </span>
                  )}
                  <PaperRunInspection record={r} />
                  <BatchRunInspection record={r} />
                  {r.status !== 'running' && !recoveryReplayBlocked && (
                    <span className="run-history__item-actions">
                      <button
                        type="button"
                        className="run-history__replay"
                        onClick={() => {
                          if (r.status === 'failed') void retryFailedRun(r.id);
                          else void rerunHistoryRecord(r.id);
                        }}
                        disabled={isExecuting || offline}
                        {...off}
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
                      {Boolean(r.paperInputs?.length) && !recoveryReplayReady && (
                        <button
                          type="button"
                          className="run-history__replay"
                          disabled={isExecuting || !latestSourceReady || offline}
                          {...off}
                          onClick={() => void rerunHistoryWithLatestPaperSource(r.id)}
                          aria-label={`Rerun ${runTriggerLabel(r.trigger)} with latest source`}
                          title={latestSourceReady
                            ? 'Reuse saved recipe settings and connections with the latest exported Paper input'
                            : 'Refresh or reconnect the Paper source before using its latest artwork'}
                        >Rerun with latest source</button>
                      )}
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
          </ScrollFade>
        )}
      </ScrollFade>
      {confirmingForget && visible && (
        <ForgetRecoveryConfirm
          name={recordNodeName(nodes, confirmingForget.nodeId, true)}
          onCancel={() => setConfirmingForget(null)}
          onConfirm={() => {
            const { runId, nodeId } = confirmingForget;
            setConfirmingForget(null);
            void forgetRecovery(runId, nodeId);
          }}
        />
      )}
    </div>
  );
}
