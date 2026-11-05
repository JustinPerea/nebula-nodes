import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { commonsEvaluationApi, commonsReviewApi } from '../../lib/commonsApi';
import type { EvaluationBatch } from '../../lib/commonsEvaluationTypes';
import { isOfflineRefusal } from '../../lib/backendConnection';
import { offlineMark, STUDIO_OFFLINE_LINE_ID, useBackendOffline, useOfflineRowShown } from '../../lib/useBackendOffline';
import { CLOSE_GRADE_RUNNING, CLOSE_NO_RESPONSE, closeBatchFailedLine, closeLineRetries } from '../../lib/errorCopy';
import { CommonsErrorLine } from './CommonsErrorLine';
import { LineText } from '../LineText';
import { useCommonsLine } from './useCommonsLine';

/** While a grade runs, how often a dialog with no pane poll checks whether it has finished. */
export const GRADE_WAIT_MS = 5000;
/** GM r43 Q1: the close's label reads "Closing…" only once the request has been out this long. */
export const CLOSING_LABEL_MS = 300;
/** GM r43 Q1: how long the close may take before the dialog reads the batch to see what happened. */
export const CLOSE_TIMEOUT_MS = 30_000;
/**
 * GM r44 1: the lock line while edits are unsaved, one per pane (lib/commonsEditLines). It locks
 * the opener (aria-disabled, focusable, the line under it); inside the dialog it is tested-only,
 * since the opener can't open the dialog while edits are unsaved.
 */
export { EDITS_LINE_LABELING, EDITS_LINE_REVIEW } from '../../lib/commonsEditLines';
/**
 * Round 18o (GM r51 Q2): the opener's line while Agent review sees a grade running. A lock line,
 * neutral, under the opener as its reason; it goes when the pane's poll sees the grade finish. Inside
 * the dialog the close keeps CLOSE_GRADE_RUNNING, its because line.
 */
export const OPENER_GRADE_LINE = 'You can close this batch when the grade finishes.';

/**
 * The parent's busy state while the dialog is open (round 18l, review 17 MEDIUM-2): it locks the
 * close the same way a line does (aria-disabled, focusable, its reason the line), never natively.
 * `grade`: Agent review sees a grade running; `edits`: unsaved or saving label edits.
 */
export type CloseLock = 'grade' | 'edits' | null;

/**
 * Ends the held-out batch without sealing it. Irreversible, so it always asks
 * first: the batch becomes an assisted-review record (or an abandoned blind
 * batch) and library analysis may start. Quarantine stays in force.
 *
 * The opener: unsaved edits or a running grade lock it in place (aria-disabled, focusable, presses
 * ignored) with its line under it; natively disabled only while a save is in flight, or offline
 * with no lock. Offline, a locked opener keeps its lock line and aria lock, its reasons the lock
 * line first and then the offline row (GM r43, r51 Q5), as Blind labeling's Review batch toggle
 * does: a later sweep must not turn it natively disabled offline.
 */
export function CommonsCloseBatch({ revision, assisted, reviewed, total, disabled, lock = null, editsLine, gradePoll, onClosed }: {
  revision: number; assisted: boolean; reviewed?: number; total?: number;
  /** The parent is busy (a save in flight): the opener is natively disabled for that moment; inside
   * the dialog it is an aria lock. */
  disabled: boolean;
  /** The parent's state that locks the close, with its line: inside the dialog, and the opener too
   * (GM r44 1; a grade, GM r51 Q2, with OPENER_GRADE_LINE). */
  lock?: CloseLock;
  /** The pane's unsaved-edits line (EDITS_LINE_LABELING or EDITS_LINE_REVIEW). */
  editsLine: string;
  /** GM r43 Q7: the pane's own poll (Agent review): whether it sees a grade running, and how many
   * reads it has made. The grade wait follows it; without it the dialog checks by itself. */
  gradePoll?: { running: boolean; reads: number };
  /** Called once the close has committed. The parent owns any refresh and its errors. */
  onClosed: (batch: EvaluationBatch) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState('');
  // PR #204 round 9: a not-connected line clears on the promote (closing isn't done again).
  const line = useCommonsLine(setError, '');
  const opener = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const backToOpener = useRef(false);
  const titleId = useId();
  const openerLineId = useId();
  const lineId = useId();
  const closeId = useId();
  // Round 16 (L4): closing the batch is a write, so offline it's off.
  const readOnly = useBackendOffline();
  const rowShown = useOfflineRowShown();
  useEffect(() => { if (confirming) cancel.current?.focus(); }, [confirming]);
  // GM r43 Q6, review 17 LOW-4: Cancel or Escape hands focus back to the opener.
  useEffect(() => {
    if (confirming || !backToOpener.current) return;
    backToOpener.current = false;
    opener.current?.focus();
  }, [confirming]);
  // GM r43 Q4: a retry line is about an attempt that is now old: it goes offline and doesn't come
  // back on reconnect. A lock line is still true, so it stays.
  useEffect(() => {
    if (readOnly && error && closeLineRetries(error)) setError('');
  }, [readOnly, error]);
  // GM r43 Q1: the label stays for CLOSING_LABEL_MS, then reads "Closing…".
  useEffect(() => {
    if (!closing) { setSlow(false); return undefined; }
    const timer = window.setTimeout(() => setSlow(true), CLOSING_LABEL_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  // A grade still running: the close waits for it, then the line clears itself and the button is
  // live again. Never offline (review 17 LOW-2).
  const waitingForGrade = confirming && !readOnly && error === CLOSE_GRADE_RUNNING;
  // GM r43 Q7: Agent review's own 5 s poll decides; the first read after the line counts.
  const pollAtLine = useRef<number | null>(null);
  useEffect(() => {
    if (!waitingForGrade || !gradePoll) { pollAtLine.current = null; return; }
    if (pollAtLine.current === null) { pollAtLine.current = gradePoll.reads; return; }
    if (gradePoll.reads > pollAtLine.current && !gradePoll.running) setError('');
  }, [waitingForGrade, gradePoll]);
  // Blind labeling has no pane poll: the dialog asks every GRADE_WAIT_MS while the line shows.
  const ownWait = waitingForGrade && !gradePoll;
  useEffect(() => {
    if (!ownWait) return undefined;
    let cancelled = false;
    const timer = window.setInterval(() => {
      commonsReviewApi.get().then((review) => {
        if (cancelled || review?.items.some((item) => item.status === 'running')) return;
        // Any other line since would have ended this wait (cancelled), so this is still the grade's.
        setError('');
      }, () => undefined);
    }, GRADE_WAIT_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [ownWait]);

  // Round 18k (GM r41): a line whose step isn't "Try again." or "Try again in a moment." (Reload,
  // open the link, wait, restart) locks the close: aria-disabled, focusable, its reason the line.
  // Round 18l (review 17 MEDIUM-2): the parent's busy state locks it the same way, with its line.
  const parentLine = lock === 'grade' ? CLOSE_GRADE_RUNNING : lock === 'edits' ? editsLine : null;
  const errorLocks = Boolean(error) && !closeLineRetries(error);
  const lockLine = errorLocks ? error : parentLine;
  // A parent lock hides an older retry line: the close can't retry (`disabled` locks with no line).
  const shownLine = lockLine ?? (lock || disabled ? '' : error);
  // The opener's `disabled` still holds inside the dialog, as an aria lock (a parent that passes no
  // `lock` never leaves a live close behind a disabled opener).
  const locked = errorLocks || lock !== null || disabled || readOnly;
  // GM r43 Q3: the lock line first (still true after the reconnect), then the offline row, and
  // that only once the row shows its line (review 17 LOW-1).
  const reasons = [lockLine ? lineId : undefined, readOnly && rowShown ? STUDIO_OFFLINE_LINE_ID : undefined].filter(Boolean).join(' ');

  const label = assisted ? 'Close review & resume library analysis' : 'Close without sealing';
  function dismiss() {
    if (closing) return;
    backToOpener.current = true;
    setConfirming(false); setError('');
  }
  async function close() {
    // GM r43 Q1: while the close is out it ignores presses (and Enter, Space).
    if (locked || closing) return;
    setClosing(true); setError('');
    const controller = new AbortController();
    let timedOut = false;
    const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, CLOSE_TIMEOUT_MS);
    let closed: EvaluationBatch | null = null;
    try {
      closed = await commonsEvaluationApi.close(revision, controller.signal);
    } catch (e) {
      if (timedOut) {
        // GM r43 Q1: no answer in 30 s: read the batch before saying anything. Closed means the
        // close landed (the backend's close is idempotent, so a retry would get it too).
        const now = await commonsEvaluationApi.get().catch(() => null);
        if (now?.state === 'closed') closed = now;
        else line.keep(e, CLOSE_NO_RESPONSE);
      } else if (!isOfflineRefusal(e)) {
        // Round 18j/18k (GM r40, r41): nothing was lost, so the because form, neutral, in either
        // pane. A refusal for this tab registers to clear on the promote. Offline, the row says it.
        line.keep(e, closeBatchFailedLine(e));
      }
    } finally {
      window.clearTimeout(timer);
    }
    setClosing(false);
    if (!closed) return;
    setConfirming(false);
    onClosed(closed);
  }
  if (!confirming) {
    // GM r44 1: unsaved edits lock the opener in place (aria-disabled, focusable, presses ignored)
    // with the pane's line under it; it says what unlocks it. GM r51 Q2: so does a running grade,
    // with its own line, so focus on the opener stays when the grade starts and when it finishes.
    // Natively disabled only while the parent is busy (a save in flight), or offline with no lock.
    // GM r51 Q5: offline, a lock keeps its line and aria lock, the offline row a second reason.
    const openerLine = lock === 'grade' ? OPENER_GRADE_LINE : lock === 'edits' ? editsLine : null;
    const openerLocked = openerLine !== null && !disabled;
    const openerReasons = [openerLineId, readOnly && rowShown ? STUDIO_OFFLINE_LINE_ID : undefined].filter(Boolean).join(' ');
    return <>
      <button type="button" ref={opener} className="commons-button" disabled={disabled || (readOnly && !openerLocked)}
        {...offlineMark(readOnly && !openerLocked)}
        aria-disabled={openerLocked || undefined} aria-describedby={openerLocked ? openerReasons : undefined}
        onClick={() => { if (!openerLocked) setConfirming(true); }}>{label}…</button>
      {openerLocked && <p id={openerLineId} className="person-lock-line" data-lock-place="control"><LineText text={openerLine} /></p>}
    </>;
  }
  const onKeyDown = (event: KeyboardEvent) => {
    // GM r43 Q6: Escape is Cancel, and inactive while a close is out.
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    dismiss();
  };
  return <div className="evaluation-close" role="alertdialog" aria-labelledby={titleId} onKeyDown={onKeyDown}>
    <h3 id={titleId}>{assisted ? 'Close these references as assisted review?' : 'Close this batch without sealing?'}</h3>
    <ul>
      <li>These references become {assisted ? 'an assisted review record' : 'an abandoned blind batch'}, not blind ground truth. They can never be sealed as blind labels.</li>
      <li>Held-out images stay quarantined and never enter library analysis or few-shot examples.</li>
      {assisted && <li>You can keep agreeing with or correcting grades after closing.{total ? ` You’ve reviewed ${reviewed ?? 0} of ${total} so far.` : ''} No new grades will be requested.</li>}
      <li>Library analysis of imported references can start. This can’t be undone.</li>
    </ul>
    <CommonsErrorLine line={shownLine} id={lineId} neutral={lock === 'edits' && shownLine === editsLine} />
    {/* GM r40 1: one row, Cancel then the close, which keeps its look. GM r43 Q1: while the close
        is out, neither is natively disabled (Chrome would drop focus to the page). */}
    <div className="review-actions">
      <button type="button" ref={cancel} className="commons-button" aria-disabled={closing || undefined}
        aria-describedby={closing ? closeId : undefined} onClick={dismiss}>Cancel</button>
      <button type="button" id={closeId} className="commons-button commons-button--primary"
        aria-disabled={locked || closing || undefined} aria-busy={closing || undefined} aria-describedby={reasons || undefined}
        {...offlineMark(readOnly)} onClick={() => void close()}>
        {closing && slow ? 'Closing…' : assisted ? 'Close as assisted review' : 'Close without sealing'}</button>
    </div>
  </div>;
}
