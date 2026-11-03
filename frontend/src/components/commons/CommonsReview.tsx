import { useEffect, useId, useRef, useState } from 'react';
import { commonsReviewApi as api, commonsEvaluationApi } from '../../lib/commonsApi';
import type { EvaluationLabels } from '../../lib/commonsEvaluationTypes';
import type { ReviewBatch, ReviewItem } from '../../lib/commonsReviewTypes';
import { CommonsCloseBatch } from './CommonsCloseBatch';
import { CHANGE_REFERENCE_LINE_REVIEW, EDITS_LINE_REVIEW, GENERATE_LINE_REVIEW } from '../../lib/commonsEditLines';
import { saveFailure, type LabelingWork, type SaveResult } from './commonsLeave';
import { SectionEyebrow } from './CommonsSectionEyebrow';
import '../../styles/commons-evaluation.css';
import '../../styles/commons-review.css';
import { offlineMark, STUDIO_OFFLINE_LINE_ID, useBackendOffline, useOfflineRowShown } from '../../lib/useBackendOffline';
import { LineText } from '../LineText';
import { CommonsErrorLine } from './CommonsErrorLine';
import { useOfflineFirstBecause } from '../../hooks/useOfflineFirstBecause';
import { useCommonsLine, useReloadEpoch, useLoadLineQuietOnReconnect } from './useCommonsLine';
import { CommonsLoadingLine } from './CommonsLoadingLine';
import { isLoadLine } from '../../lib/errorCopy';
import { isBackendOffline, isOfflineRefusal } from '../../lib/backendConnection';

/**
 * Round 18o (GM r51 Q1): a failure while Nebula is offline. The poll is a GET, which the offline
 * gate never refuses, so going offline reaches it as no answer (or the dev proxy's 502) with the
 * app already marked offline by its health probe; a refused write is the gate's own refusal.
 * Online, a failed read still shows its line alone (GM r39 Fix B).
 */
const offlineFailure = (error: unknown) => isOfflineRefusal(error) || isBackendOffline();

const pretty = (text: string) => text === 'n_a' ? 'Not applicable' : text.replaceAll('_', ' ');

type DraftActions = { save: () => Promise<SaveResult>; discard: () => void };
/** Round 18o (GM r51 Q4): Save corrections & next, pressed from its button, hands focus on to the
 * next reference's heading once the save lands. */
type AcceptFrom = { focusNext?: boolean };

/**
 * Agent review. `onWork` is the panel contract (commons-leave): unsaved
 * corrections, a save in flight, the grading run, and their own save,
 * discard and stop. Grading asks the backend for one grade at a time
 * (commons/review.py runs nothing on its own), so it lasts only while the
 * Commons is open; the Commons keeps this panel mounted, hidden, in its other
 * sections (`active` false), where it skips the poll.
 */
export function CommonsReview({ onWork, active = true }: { onWork?: (work: LabelingWork | null) => void; active?: boolean }) {
  // Round 16 (L4): offline grading and saves are disabled; corrections stay
  // editable and unsaved until Nebula answers.
  const readOnly = useBackendOffline();
  const rowShown = useOfflineRowShown();
  const [batch, setBatch] = useState<ReviewBatch | null>(null);
  /** A read has answered (GM r24 b, r27 1): until one has, `batch` null means
   * nothing was read, so neither the counts nor the "prepare first" line show. */
  const [answered, setAnswered] = useState(false);
  const answeredRef = useRef(false);
  useEffect(() => { answeredRef.current = answered; }, [answered]);
  const headingId = useId();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // PR #204 round 9: a not-connected line clears on the promote, and the review loads again.
  const [loadEpoch, loadAgain] = useReloadEpoch();
  const line = useCommonsLine(setError, '', 'commons.review-load', loadAgain);
  // Round 18h (GM r38 3c): its load line reads again quietly on reconnect.
  useLoadLineQuietOnReconnect(error, () => setError(''), loadAgain);
  /** Round 18l (GM r43 Q7): how many of the poll's reads have answered (the close dialog's grade wait). */
  const [pollReads, setPollReads] = useState(0);
  const [index, setIndex] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<Promise<SaveResult> | null>(null);
  const [generating, setGenerating] = useState(false);
  const alive = useRef(false);
  /** Stop and leave: ask for no further grade. */
  const stopped = useRef(false);
  const draft = useRef<DraftActions | null>(null);
  const shown = useRef(active);
  useEffect(() => { shown.current = active; }, [active]);
  const editingDraft = useRef(false);
  const requestVersion = useRef(0);
  const pendingWrites = useRef(0);
  const markDirty = (value: boolean) => { editingDraft.current = value; setDirty(value); };
  // Round 18o (GM r51 Q4): after Discard, focus goes to the current reference's heading; after Save
  // corrections & next, to the next reference's. The heading has tabindex -1 and draws no ring
  // (slava-restraint's code-focus rule); the effect runs once the remounted heading is in the page.
  const referenceHeading = useRef<HTMLHeadingElement>(null);
  const headingFocus = useRef(false);
  useEffect(() => {
    if (!headingFocus.current || !referenceHeading.current) return;
    headingFocus.current = false;
    referenceHeading.current.focus();
  });
  const statusLineId = useId();
  const generateLineId = useId();
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const refresh = () => {
      if (pendingWrites.current || editingDraft.current || !shown.current) return;
      const version = ++requestVersion.current;
      return api.get().then((value) => {
        if (!cancelled && !pendingWrites.current && !editingDraft.current && version === requestVersion.current) {
          setBatch(value); setAnswered(true); setError(''); setPollReads((n) => n + 1);
        }
      }, (e: unknown) => {
        // Round 18o (GM r51 Q1): once a read has answered, an offline refusal (no answer, see
        // offlineFailure) is never a failed read. The last read stays on screen, read-only (as
        // Blind labeling and Settings keep theirs), with any open dialog, and the poll reads again
        // on reconnect. The offline row says why. Before any answer, the load line shows as before.
        if (answeredRef.current && offlineFailure(e)) return;
        if (!cancelled && !pendingWrites.current && !editingDraft.current && version === requestVersion.current) {
          line.show(e, "Couldn’t load Agent review.", { reload: true });
        }
      }).finally(() => { if (!cancelled) setLoading(false); });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { cancelled = true; alive.current = false; window.clearInterval(timer); };
  }, [loadEpoch, line]);
  useEffect(() => {
    onWork?.({ unsaved: dirty, saving, running: generating,
      save: () => draft.current?.save() ?? Promise.resolve({ ok: true }),
      discard: () => draft.current?.discard(),
      stop: () => { stopped.current = true; setGenerating(false); } });
  }, [dirty, saving, generating, onWork]);
  useEffect(() => () => onWork?.(null), [onWork]);
  // Back from another section: the poll picks up at once.
  const wasActive = useRef(active);
  useEffect(() => {
    const returned = active && !wasActive.current;
    wasActive.current = active;
    if (!returned || pendingWrites.current || editingDraft.current) return;
    let cancelled = false;
    const version = ++requestVersion.current;
    api.get().then((value) => {
      if (!cancelled && !pendingWrites.current && !editingDraft.current && version === requestVersion.current) {
        // Round 18i: a read that answers clears the line, as the poll's does (a failed load's line
        // would otherwise keep the pane to that line alone).
        setBatch(value); setAnswered(true); setError('');
      }
    }, () => undefined);
    return () => { cancelled = true; };
  }, [active]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || generating) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, generating]);
  async function generate() {
    if (!batch || pendingWrites.current || editingDraft.current) return;
    pendingWrites.current++;
    requestVersion.current++;
    stopped.current = false;
    setGenerating(true); setError('');
    try {
      for (const item of batch.items.filter((i) => i.status === 'pending')) {
        if (!alive.current || stopped.current) break;
        const value = await api.propose(item.position);
        requestVersion.current++;
        if (alive.current && !editingDraft.current) setBatch(value);
        if (value.items.find((i) => i.position === item.position)?.status === 'failed') break;
      }
    } catch (e) { if (alive.current) line.show(e, "Couldn’t propose labels."); }
    finally {
      pendingWrites.current--;
      if (alive.current) setGenerating(false);
    }
  }
  function accept(item: ReviewItem, labels: EvaluationLabels, from: AcceptFrom = {}): Promise<SaveResult> {
    if (pendingWrites.current) return Promise.resolve({ ok: false, reason: 'Wait for the grade in progress to finish.',
      message: 'Wait for the grade in progress to finish.', retry: true });
    pendingWrites.current++;
    requestVersion.current++;
    setError('');
    const attempt = (async (): Promise<SaveResult> => {
      try {
        const value = await api.accept(item.position, item.revision, labels);
        requestVersion.current++;
        // GM r51 Q4: the heading the form moves to (the next reference's, or this one's when none is left).
        if (from.focusNext) headingFocus.current = true;
        setBatch(value); markDirty(false);
        const next = value.items.findIndex((i, n) => n > index && !i.reviewed_at);
        const first = value.items.findIndex((i) => !i.reviewed_at);
        if (next >= 0 || first >= 0) setIndex(next >= 0 ? next : first);
        return { ok: true };
      } catch (e) { const failure = saveFailure(e); line.keep(e, failure.message); return failure; }
      finally { pendingWrites.current--; setSaving((current) => (current === attempt ? null : current)); }
    })();
    setSaving(attempt);
    return attempt;
  }
  // The section's name is its h2, set as the eyebrow line like Blind
  // labeling's (GM review of PR #157, round 2). The display line below it is
  // a styled p, no longer a second h1 on the page.
  const eyebrow = <SectionEyebrow id={headingId} name="Agent review" detail="agent grades · your judgment" />;
  if (loading) return <section className="commons-evaluation commons-review" aria-labelledby={headingId}>
    <header className="evaluation-heading"><div>{eyebrow}</div></header>
    <CommonsLoadingLine text="Loading agent reviews…" />
  </section>;
  const intro = <div>
    {eyebrow}<p className="evaluation-title">Does this read right?</p>
    <p>See the agent’s take. Agree, or change the parts you see differently.</p>
  </div>;
  // GM r27 1: after a failed load, only the eyebrow, the heading and the failure line.
  // Round 18i (GM r39 Fix B, r32): and whenever the latest read failed, until one succeeds:
  // "Prepare the reference set…" and "0 / 15 reviewed · 0 grades ready" would be stale. The 5 s
  // poll never reads while a draft is being edited, so this never hides one.
  // Round 18o (GM r51 Q1): offline, a load line from a read that failed just before the app knew it
  // was offline never hides the last read either; the offline row says why, and the line clears
  // and reads again on reconnect (useLoadLineQuietOnReconnect).
  if (!answered || (isLoadLine(error) && !readOnly)) return <section className="commons-evaluation commons-review" aria-labelledby={headingId}>
    <header className="evaluation-heading">{intro}</header>
    {/* Round 18f (GM r35 4): its "Try again" reads it again. */}
    <CommonsErrorLine line={error} onRetry={loadAgain} />
  </section>;
  const reviewed = batch?.items.filter((i) => i.reviewed_at).length ?? 0;
  const ready = batch?.items.filter((i) => i.status === 'ready').length ?? 0;
  const running = generating || batch?.items.some((i) => i.status === 'running');
  const generateLocked = dirty && !saving;
  const referencesLocked = dirty && !saving && !generating;
  const item = batch?.items[index];
  return <section className="commons-evaluation commons-review" aria-labelledby={headingId}>
    <header className="evaluation-heading">{intro}<div className="review-progress"><strong>{reviewed} / {batch?.items.length ?? 15} reviewed</strong>
      <p>{ready} grades ready{running ? ' · Grading in progress…' : ''}</p>
      {/* Round 18o (GM r51 Q3): unsaved corrections lock it in place with its own line under it (it
          isn't in the opener's row); natively disabled only while a save runs, or offline with no
          lock. Offline, the lock keeps its line, the offline row a second reason (GM r43, r51 Q5). */}
      {batch?.state === 'open' && !running && batch.attempts < batch.call_budget && batch.items.some((i) => i.status === 'pending') && <>
        <button className="commons-button" disabled={!!saving || (readOnly && !generateLocked)} {...offlineMark(readOnly && !generateLocked)}
          aria-disabled={generateLocked || undefined}
          aria-describedby={generateLocked ? [generateLineId, readOnly && rowShown ? STUDIO_OFFLINE_LINE_ID : ''].filter(Boolean).join(' ') : undefined}
          onClick={() => { if (!generateLocked) void generate(); }}>Generate remaining grades</button>
        {generateLocked && <p id={generateLineId} className="person-lock-line" data-lock-place="control"><LineText text={GENERATE_LINE_REVIEW} /></p>}
      </>}
    </div></header>
    <CommonsErrorLine line={error} onRetry={loadAgain} />
    {!batch && <p>Prepare the reference set in Blind labeling first.</p>}
    {batch && item && <div className="evaluation-workspace">
      {/* Round 18o (GM r51 Q3): unsaved corrections lock the reference buttons in place, the form's
          status line ("…to change the reference.") their reason; native only while a save or the
          pane's own grading runs. */}
      <nav aria-label="References to review">{batch.items.map((ref, n) => <button key={ref.position} disabled={!!saving || generating}
        aria-disabled={referencesLocked || undefined} aria-describedby={referencesLocked ? statusLineId : undefined}
        aria-current={index === n ? 'true' : undefined} onClick={() => { if (!referencesLocked) setIndex(n); }}>
        Reference {String(n + 1).padStart(2, '0')} <span>{ref.reviewed_at ? '✓' : ref.status === 'ready' ? '•' : ref.status === 'failed' ? '!' : ref.status === 'running' ? '…' : ''}</span>
      </button>)}</nav>
      <ReferenceImage key={item.position} item={item} headingRef={referenceHeading} />
      <ReviewForm key={`${item.position}:${item.revision}`} batch={batch} item={item} dirty={dirty} saving={!!saving} generating={generating}
        onDirty={markDirty} onAccept={(labels, from) => accept(item, labels, from)} draftRef={draft} statusLineId={statusLineId}
        onDiscarded={() => { headingFocus.current = true; }} />
    </div>}
    <footer className="review-footer"><p>Agent proposals and your decisions are saved separately. This is assisted review, not an independent blind accuracy score.</p>
      {batch?.state === 'closed' && <p className="evaluation-hash" role="status">Closed as assisted review · {batch.closed_at ? new Date(batch.closed_at).toLocaleString() : ''} · SHA-256: {batch.close_hash}</p>}
      {/* Round 18l (review 17 MEDIUM-2, GM r43 Q7): inside the dialog the parent's state is an aria
          lock with its line, and the grade wait follows this pane's 5 s poll. Round 18m (GM r44 1):
          unsaved corrections lock the opener in place with their line; it is natively disabled
          only while a save runs. Round 18o (GM r51 Q2): a running grade locks it the same way, with
          its own line, which goes when this pane's poll sees the grade finish. */}
      {batch?.state === 'open' && <CommonsCloseBatch revision={batch.batch_revision} assisted reviewed={reviewed} total={batch.items.length}
        disabled={!!saving} lock={running ? 'grade' : dirty ? 'edits' : null} editsLine={EDITS_LINE_REVIEW}
        gradePoll={{ running: !!batch.items.some((i) => i.status === 'running'), reads: pollReads }} onClosed={(closed) => {
          // The close has committed: show it now, then reload. A failed reload is left to the poll.
          const version = ++requestVersion.current;
          setBatch((b) => b && { ...b, state: closed.state, batch_revision: closed.revision, close_hash: closed.close_hash,
            closed_at: typeof closed.closed?.closed_at === 'string' ? closed.closed.closed_at : b.closed_at });
          api.get().then((value) => {
            if (alive.current && !editingDraft.current && version === requestVersion.current) setBatch(value);
          }, () => undefined);
        }} />}
      {/* Round 18o (GM r51 Q3): a read of the saved record, so it stays live. */}
      {batch && <button className="commons-button" onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(batch, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'commons-assisted-review.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>Download review record</button>}
    </footer>
  </section>;
}

function ReferenceImage({ item, headingRef }: { item: ReviewItem; headingRef: { current: HTMLHeadingElement | null } }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [loadEpoch, loadAgain] = useReloadEpoch();
  const line = useCommonsLine(setError, '', `commons.review-image-${item.position}`, loadAgain);
  // Round 18o (GM r51 Q1): the pane keeps its last read offline, so this image stays mounted through
  // an outage; a load that failed meanwhile reads again quietly on reconnect (GM r38 3c), as the
  // pane's own load line does, instead of leaving "isn’t answering" behind.
  useLoadLineQuietOnReconnect(error, () => setError(''), loadAgain);
  // Offline comes first (GM r23 3): a because line hides while offline.
  const shownError = useOfflineFirstBecause(error);
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = '';
    commonsEvaluationApi.image(item.position, controller.signal).then((blob) => {
      if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); setError(''); }
    }, (e: unknown) => { if (!controller.signal.aborted) line.show(e, "Couldn’t load this reference.", { reload: true }); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item.position, loadEpoch, line]);
  return <div className="evaluation-image"><h3 className="evaluation-step" ref={headingRef} tabIndex={-1}>Reference {String(item.position + 1).padStart(2, '0')}</h3>
    {/* Round 18 (GM r28 1): its load's line in the one Commons line style. */}
    {shownError ? <CommonsErrorLine line={shownError} onRetry={loadAgain} /> : url ? <img className="review-reference" src={url} alt={`Reference ${item.position + 1}`} /> : !error && <p>Loading image…</p>}
    {item.proposal && <p>{item.proposal.model} · {item.proposal.prompt_version}</p>}
  </div>;
}

function ReviewForm({ batch, item, dirty, saving, generating, onDirty, onAccept, draftRef, statusLineId, onDiscarded }: {
  batch: ReviewBatch; item: ReviewItem; dirty: boolean; saving: boolean; generating: boolean;
  onDirty: (dirty: boolean) => void; onAccept: (labels: EvaluationLabels, from?: AcceptFrom) => Promise<SaveResult>;
  draftRef: { current: DraftActions | null };
  /** The status line's id: the reference buttons' reason while corrections are unsaved. */
  statusLineId: string;
  /** Discard was pressed (not the leave popover's discard): focus goes to the reference's heading. */
  onDiscarded: () => void;
}) {
  const baseline = item.reviewed_labels ?? item.proposal?.labels;
  const [labels, setLabels] = useState(() => baseline ? structuredClone(baseline) : null);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const disabled = saving || generating;
  const offline = useBackendOffline();
  const discard = () => { if (baseline) setLabels(structuredClone(baseline)); onDirty(false); };
  // The corrections' own save and discard, for the Commons' leave popover.
  useEffect(() => { draftRef.current = labels ? { save: () => onAccept(labels), discard } : null; });
  useEffect(() => () => { draftRef.current = null; }, [draftRef]);
  if (!item.proposal || !labels) return <div className="evaluation-form"><h3 className="evaluation-step">{item.status === 'failed' ? 'Grade unavailable' : item.status === 'running' ? 'The agent is looking…' : 'Waiting for a grade'}</h3>
    <p><LineText text={item.error ?? 'The complete grade will appear here. There is nothing to fill out first.'} /></p></div>;
  const change = (patch: Partial<EvaluationLabels>) => { setLabels({ ...labels, ...patch }); onDirty(true); };
  const fields = item.proposal.fields;
  const reason = (key: string) => (fields[key] as { why?: string } | undefined)?.why;
  // Round 18o (GM r51 Q4): while it saves it is aria-busy and aria-disabled, never natively disabled
  // (Chrome would drop its focus to the page); native only while the pane grades, or offline.
  const agreement = <><button className="commons-button commons-button--primary" disabled={generating || offline} {...offlineMark(offline)}
    aria-busy={saving || undefined} aria-disabled={saving || undefined}
    onClick={() => { if (!saving) void onAccept(labels, { focusNext: true }); }}>{saving ? 'Saving…' : dirty ? 'Save corrections & next' : item.reviewed_at ? 'Keep this review & next' : 'Agree & next'}</button>
    {dirty && !saving && <span className="commons-unsaved">Unsaved</span>}</>;
  return <div className="evaluation-form">
    <small>{item.reviewed_at ? 'YOUR SAVED REVIEW' : 'PROPOSED BY THE AGENT'}</small>
    <h3 className="evaluation-step">{fields.summary.value}</h3><p>{fields.composition_notes.value}</p>
    <div className="review-actions">{agreement}<button className="commons-button" disabled={disabled} onClick={() => setEditing(!editing)}>{editing ? 'Hide editing controls' : 'Edit grades'}</button></div>
    <fieldset disabled={disabled}>
      <h4 className="evaluation-subhead">Structure</h4>{Object.entries(batch.fields).map(([key, values]) => <div className="review-grade" key={key}>
        <label>{pretty(key)}{editing ? <select value={labels.tags[key]} onChange={(e) => change({ tags: { ...labels.tags, [key]: e.target.value } })}>
          {values.map((value) => <option key={value} value={value}>{pretty(value)}</option>)}
        </select> : <strong>{pretty(labels.tags[key])}</strong>}</label><p className="review-reason">Agent: {reason(key)}</p>
      </div>)}
      <h4 className="evaluation-subhead">Character</h4>{batch.axes.map((key) => <div className="review-grade" key={key}>
        <label>{pretty(key)} <strong>{labels.axes[key].toFixed(2)}</strong>
          {editing ? <input aria-label={pretty(key)} type="range" min={-1} max={1} step={0.05} value={labels.axes[key]}
            onChange={(e) => change({ axes: { ...labels.axes, [key]: Number(e.target.value) } })} />
            : <meter aria-label={pretty(key)} min={-1} max={1} value={labels.axes[key]} />}
        </label><div className="review-axis-ends"><span>−1 {key.split('_')[0]}</span><span>+1 {key.split('_')[1]}</span></div>
        <p className="review-reason">Agent: {fields.axes[key].why}</p>
      </div>)}
      <h4 className="evaluation-subhead">Color roles</h4>{item.palette?.map((p) => <label key={p.index} className="evaluation-role"><span style={{ background: p.hex }} title={p.hex} />
        <span className="review-swatch-label">P{p.index} · {p.share * 100 < 0.1 ? '<0.1' : (p.share * 100).toFixed(1)}%</span>
        {editing ? <select aria-label={`Role for P${p.index}`} value={labels.palette_roles[p.index]} onChange={(e) => change({ palette_roles: { ...labels.palette_roles, [p.index]: e.target.value } })}>
          {batch.roles.map((role) => <option key={role}>{role}</option>)}</select> : <strong>{labels.palette_roles[p.index]}</strong>}
      </label>)}
      <h4 className="evaluation-subhead">Keywords</h4><div className="evaluation-keywords">{labels.keywords.map((word) => editing ?
        <button className="commons-button commons-button--remove" key={word} aria-label={`Remove ${pretty(word)}`} onClick={() => { const words = labels.keywords.filter((w) => w !== word); change({ keywords: words, no_keywords: !words.length }); }}>{pretty(word)} ×</button>
        : <span className="review-keyword" key={word}>{pretty(word)}</span>)}{!labels.keywords.length && <span>No applicable keywords</span>}</div>
      {editing && <><input aria-label="Search keywords" value={query} placeholder="Add a keyword…" onChange={(e) => setQuery(e.target.value)} />
        <div className="evaluation-keywords">{query.trim() && batch.keywords.filter((word) => word.includes(query.trim().toLowerCase().replaceAll(' ', '_')) && !labels.keywords.includes(word)).slice(0, 20).map((word) =>
          <button className="commons-button" key={word} disabled={labels.keywords.length >= 12} onClick={() => { change({ keywords: [...labels.keywords, word], no_keywords: false }); setQuery(''); }}>{pretty(word)}</button>)}</div></>}
    </fieldset>
    <div className="evaluation-save">{agreement}</div>
    {dirty && <button className="commons-button commons-button--danger" disabled={disabled} onClick={() => { onDiscarded(); discard(); }}>Discard changes</button>}
    <p role="status" id={statusLineId}>{dirty ? CHANGE_REFERENCE_LINE_REVIEW : item.reviewed_at ? 'Reviewed by you · saved on this computer' : 'Awaiting your review · nothing accepted yet'}</p>
    <details><summary>Original agent grade</summary><dl>
      {Object.entries(item.proposal.labels.tags).map(([key, value]) => <div key={key}><dt>{pretty(key)}</dt><dd>{pretty(value)}</dd></div>)}
      {Object.entries(item.proposal.labels.axes).map(([key, value]) => <div key={key}><dt>{pretty(key)}</dt><dd>{value.toFixed(2)}</dd></div>)}
      {Object.entries(item.proposal.labels.palette_roles).map(([key, value]) => <div key={key}><dt>Color P{key}</dt><dd>{value}</dd></div>)}
      <dt>Keywords</dt><dd>{item.proposal.labels.keywords.map(pretty).join(', ') || 'No applicable keywords'}</dd>
    </dl></details>
  </div>;
}
