import { useEffect, useId, useRef, useState } from 'react';
import { commonsEvaluationApi, commonsReviewApi } from '../../lib/commonsApi';
import type { EvaluationBatch } from '../../lib/commonsEvaluationTypes';
import { isOfflineRefusal } from '../../lib/backendConnection';
import { offlineMark, STUDIO_OFFLINE_LINE_ID, useBackendOffline } from '../../lib/useBackendOffline';
import { CLOSE_GRADE_RUNNING, closeBatchFailedLine, closeLineRetries } from '../../lib/errorCopy';
import { CommonsErrorLine } from './CommonsErrorLine';
import { useCommonsLine } from './useCommonsLine';

/** While a grade runs, how often the dialog checks whether it has finished (round 18k). */
export const GRADE_WAIT_MS = 5000;

/**
 * Ends the held-out batch without sealing it. Irreversible, so it always asks
 * first: the batch becomes an assisted-review record (or an abandoned blind
 * batch) and library analysis may start. Quarantine stays in force.
 */
export function CommonsCloseBatch({ revision, assisted, reviewed, total, disabled, onClosed }: {
  revision: number; assisted: boolean; reviewed?: number; total?: number; disabled: boolean;
  /** Called once the close has committed. The parent owns any refresh and its errors. */
  onClosed: (batch: EvaluationBatch) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState('');
  // PR #204 round 9: a not-connected line clears on the promote (closing isn't done again).
  const line = useCommonsLine(setError, '');
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const lineId = useId();
  // Round 16 (L4): closing the batch is a write, so offline it's off.
  const readOnly = useBackendOffline();
  useEffect(() => { if (confirming) cancel.current?.focus(); }, [confirming]);
  // Round 18k (GM r41): a line whose step isn't "Try again." or "Try again in a moment." (Reload,
  // open the link, wait, restart) locks the close button: aria-disabled, focusable, its reason the
  // line. Offline there is no line; the offline row is its reason. Cancel stays live.
  const lineLocks = Boolean(error) && !closeLineRetries(error);
  const locked = lineLocks || readOnly;
  // A grade still running: the close waits for it, then the line clears itself and the button is
  // live again. It asks while that line shows, every GRADE_WAIT_MS, and never otherwise.
  const waitingForGrade = confirming && error === CLOSE_GRADE_RUNNING;
  useEffect(() => {
    if (!waitingForGrade) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      commonsReviewApi.get().then((review) => {
        if (cancelled || review?.items.some((item) => item.status === 'running')) return;
        // Any other line since would have ended this wait (cancelled), so this is still the grade's.
        setError('');
      }, () => undefined);
    }, GRADE_WAIT_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [waitingForGrade]);
  const label = assisted ? 'Close review & resume library analysis' : 'Close without sealing';
  async function close() {
    if (locked) return;
    setClosing(true); setError('');
    let closed: EvaluationBatch;
    try { closed = await commonsEvaluationApi.close(revision); }
    catch (e) {
      // Round 18j/18k (GM r40, r41): nothing was lost, so the because form, neutral, in either
      // pane: "Nebula couldn’t close the batch because the server didn’t respond. Try again."
      // A refusal for this tab registers to clear on the promote. Offline, the offline row says it.
      if (!isOfflineRefusal(e)) line.keep(e, closeBatchFailedLine(e));
      setClosing(false); return;
    }
    setClosing(false); setConfirming(false);
    onClosed(closed);
  }
  if (!confirming) {
    return <button type="button" className="commons-button" disabled={disabled || readOnly} {...offlineMark(readOnly)} onClick={() => setConfirming(true)}>{label}…</button>;
  }
  const reason = lineLocks ? lineId : readOnly ? STUDIO_OFFLINE_LINE_ID : undefined;
  return <div className="evaluation-close" role="alertdialog" aria-labelledby={titleId}>
    <h3 id={titleId}>{assisted ? 'Close these references as assisted review?' : 'Close this batch without sealing?'}</h3>
    <ul>
      <li>These references become {assisted ? 'an assisted review record' : 'an abandoned blind batch'}, not blind ground truth. They can never be sealed as blind labels.</li>
      <li>Held-out images stay quarantined and never enter library analysis or few-shot examples.</li>
      {assisted && <li>You can keep agreeing with or correcting grades after closing.{total ? ` You’ve reviewed ${reviewed ?? 0} of ${total} so far.` : ''} No new grades will be requested.</li>}
      <li>Library analysis of imported references can start. This can’t be undone.</li>
    </ul>
    <CommonsErrorLine line={error} id={lineId} />
    {/* GM r40 1: one row, Cancel then the close, which keeps its look. */}
    <div className="review-actions">
      <button type="button" ref={cancel} className="commons-button" disabled={closing} onClick={() => { setConfirming(false); setError(''); }}>Cancel</button>
      <button type="button" className="commons-button commons-button--primary" disabled={closing || disabled}
        aria-disabled={locked || undefined} aria-describedby={reason} {...offlineMark(readOnly)} onClick={() => void close()}>
        {closing ? 'Closing…' : assisted ? 'Close as assisted review' : 'Close without sealing'}</button>
    </div>
  </div>;
}
