import { useEffect, useId, useRef, useState } from 'react';
import { commonsEvaluationApi } from '../../lib/commonsApi';
import type { EvaluationBatch } from '../../lib/commonsEvaluationTypes';

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
  const cancel = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useEffect(() => { if (confirming) cancel.current?.focus(); }, [confirming]);
  const label = assisted ? 'Close review & resume library analysis' : 'Close without sealing';
  async function close() {
    setClosing(true); setError('');
    let closed: EvaluationBatch;
    try { closed = await commonsEvaluationApi.close(revision); }
    catch (e) { setError((e as Error).message); setClosing(false); return; }
    setClosing(false); setConfirming(false);
    onClosed(closed);
  }
  if (!confirming) {
    return <button type="button" className="commons-button" disabled={disabled} onClick={() => setConfirming(true)}>{label}…</button>;
  }
  return <div className="evaluation-close" role="alertdialog" aria-labelledby={titleId}>
    <h3 id={titleId}>{assisted ? 'Close these references as assisted review?' : 'Close this batch without sealing?'}</h3>
    <ul>
      <li>These references become {assisted ? 'an assisted review record' : 'an abandoned blind batch'}, not blind ground truth. They can never be sealed as blind labels.</li>
      <li>Held-out images stay quarantined and never enter library analysis or few-shot examples.</li>
      {assisted && <li>You can keep agreeing with or correcting grades after closing{total ? ` (${reviewed ?? 0} / ${total} reviewed)` : ''}. No new grades will be requested.</li>}
      <li>Library analysis of imported references can start. This cannot be undone.</li>
    </ul>
    {error && <p role="alert" className="commons-notice commons-notice--error">{error}</p>}
    <div className="review-actions">
      <button type="button" className="commons-button commons-button--primary" disabled={closing || disabled} onClick={() => void close()}>
        {closing ? 'Closing…' : assisted ? 'Close as assisted review' : 'Close without sealing'}</button>
      <button type="button" ref={cancel} className="commons-button" disabled={closing} onClick={() => { setConfirming(false); setError(''); }}>Cancel</button>
    </div>
  </div>;
}
