import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { commonsEvaluationApi as api } from '../../lib/commonsApi';
import { evaluationComplete } from '../../lib/commonsEvaluationTypes';
import type { AccentPoint, EvaluationBatch, EvaluationItem, EvaluationLabels } from '../../lib/commonsEvaluationTypes';
import { CommonsCloseBatch } from './CommonsCloseBatch';
import { saveFailure, type LabelingWork, type SaveResult } from './commonsLeave';
import { SectionEyebrow } from './CommonsSectionEyebrow';
import '../../styles/commons-evaluation.css';

const pretty = (value: string) => value === 'n_a' ? 'Not applicable' : value.replaceAll('_', ' ');
const emptyLabels = (): EvaluationLabels => ({ tags: {}, axes: {}, palette_roles: {}, keywords: [], no_keywords: false, flagged: false });

/** The open reference's draft: its own save and discard, for the Commons' leave popover. */
type DraftActions = { save: () => Promise<SaveResult>; discard: () => void };

/**
 * Preparing the held-out set, a folder scan that can take minutes, outlives
 * the panel (commons-leave review). It isn't a label save, so a leave doesn't
 * wait for it, and the backend's scan doesn't stop when the person leaves.
 * A Blind labeling mounted meanwhile takes it up still running (so no second
 * scan starts) and shows its batch or its error; until a panel has shown
 * the outcome, the scan stays here for the next one.
 */
interface Scan { path: string; result: Promise<EvaluationBatch> }
let scan: Scan | null = null;
type ScanOutcome = { batch: EvaluationBatch } | { error: string };

function followScan(pending: Scan, live: () => boolean, show: (outcome: ScanOutcome) => void): void {
  const settle = (outcome: ScanOutcome) => {
    if (!live()) return;
    if (scan === pending) scan = null;
    show(outcome);
  };
  pending.result.then((batch) => settle({ batch }), (e: Error) => settle({ error: e.message }));
}

/**
 * Blind labeling. `onWork` is the panel contract (commons-leave): an unsaved
 * draft, a label write in flight, and the draft's own save and discard.
 * `active`: shown now; the Commons keeps it mounted, hidden, in its other
 * sections, and it reloads the batch on coming back unless a draft is open.
 */
export function CommonsEvaluation({ onWork, active = true }: { onWork?: (work: LabelingWork | null) => void; active?: boolean }) {
  const [batch, setBatch] = useState<EvaluationBatch | null>(null);
  const headingId = useId();
  /** A scan still running (or settled unseen) when this panel mounted. */
  const [resumed] = useState(() => scan);
  const [loading, setLoading] = useState(resumed === null);
  const [busy, setBusy] = useState(resumed !== null);
  /** A label write (accents, labels, seal) in flight; preparing the set isn't one. */
  const [saving, setSaving] = useState<Promise<SaveResult> | null>(null);
  const draft = useRef<DraftActions | null>(null);
  const [error, setError] = useState('');
  const [path, setPath] = useState(resumed?.path ?? '');
  const [index, setIndex] = useState(0);
  const [review, setReview] = useState(false);
  const [dirty, setDirty] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const showScan = useCallback((outcome: ScanOutcome) => {
    setBusy(false);
    if ('batch' in outcome) setBatch(outcome.batch); else setError(outcome.error);
  }, []);
  useEffect(() => {
    let cancelled = false;
    if (resumed) {
      followScan(resumed, () => !cancelled, showScan);
      return () => { cancelled = true; };
    }
    api.get().then((value) => { if (!cancelled) setBatch(value); }, (e: Error) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [resumed, showScan]);
  useEffect(() => {
    onWork?.({ unsaved: dirty, saving, running: false,
      save: () => draft.current?.save() ?? Promise.resolve({ ok: true }),
      discard: () => draft.current?.discard(), stop: () => {} });
  }, [dirty, saving, onWork]);
  useEffect(() => () => onWork?.(null), [onWork]);
  // Back from another section: what changed meanwhile (an agent grade turns
  // sealing into an assisted close), unless the person has a draft open.
  const idle = useRef(true);
  useEffect(() => { idle.current = !dirty && !busy; });
  const wasActive = useRef(active);
  useEffect(() => {
    const returned = active && !wasActive.current;
    wasActive.current = active;
    if (!returned || !idle.current) return;
    let cancelled = false;
    api.get().then((value) => { if (!cancelled && idle.current) setBatch(value); }, () => undefined);
    return () => { cancelled = true; };
  }, [active]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  /** A label write, which a leave waits for (preparing the set isn't one: see Scan). */
  function run(action: () => Promise<EvaluationBatch>): Promise<SaveResult> {
    setBusy(true); setError('');
    const attempt = (async (): Promise<SaveResult> => {
      try { setBatch(await action()); setDirty(false); return { ok: true }; }
      catch (e) { const failure = saveFailure(e); setError(failure.reason); return failure; }
      finally { setBusy(false); }
    })();
    setSaving(attempt);
    void attempt.then(() => setSaving((current) => (current === attempt ? null : current)));
    return attempt;
  }
  // The section's name is its h2, set as the eyebrow line and merged with
  // the old eyebrow (GM review of PR #157, round 2), at every width. Under
  // the page's h1, "Commons"; the display line is a styled p, and the steps
  // are h3 under the h2.
  const eyebrow = <SectionEyebrow id={headingId} name="Blind labeling" detail="C1 / C2 human ground truth" />;
  if (loading) return <section className="commons-evaluation" aria-labelledby={headingId}>
    <header className="evaluation-heading"><div>{eyebrow}</div></header>
    <p className="commons-notice">Loading held-out references…</p>
  </section>;
  const count = batch?.items.filter((item) => evaluationComplete(item, batch)).length ?? 0;
  return <section className="commons-evaluation" aria-labelledby={headingId}>
    <header className="evaluation-heading">
      <div>{eyebrow}<p className="evaluation-title">A fresh pair of eyes.</p>
        <p>Describe what you see. Accent observations come before palette swatches.</p></div>
      {batch && <button className="commons-button" disabled={busy || dirty} onClick={() => setReview(!review)}>
        {review ? 'Keep labeling' : `Review batch · ${count} / 15`}</button>}
    </header>
    {error && <p role="alert" className="commons-notice commons-notice--error">{error}</p>}
    {!batch ? <form className="evaluation-setup" onSubmit={(e) => {
      e.preventDefault();
      const started: Scan = { path, result: api.prepare(path) };
      scan = started;
      setBusy(true); setError('');
      followScan(started, () => mounted.current, showScan);
    }}>
      <h3 className="evaluation-step">Prepare the held-out set</h3>
      <p>Scan a local folder before importing it. Choose 15 references and 30 tuning references from distinct near-duplicate clusters, spread across subfolders. The held-out clusters stay quarantined.</p>
      <p>Files in iCloud download before they are read. This scans and snapshots media; it does not import references or run the model. The set cannot be regenerated here.</p>
      <label>Folder path<input value={path} onChange={(e) => setPath(e.target.value)} placeholder="Absolute path to the reference folder" required disabled={busy} /></label>
      <button className="commons-button commons-button--primary" disabled={busy || !path.trim()}>{busy ? 'Downloading and scanning…' : 'Prepare 15 held-out references'}</button>
    </form> : <>
      {batch.sealed && <p className="commons-notice" role="status">Human labels sealed. The fixed denominator is 150 fields.</p>}
      {batch.state === 'closed' && <p className="commons-notice" role="status">Closed without sealing: an assisted review record, not blind ground truth. Blind drafts are read only. SHA-256: {batch.close_hash}</p>}
      {review ? <div className="evaluation-review">
        <h3 className="evaluation-step">One last look.</h3><p>{count} of 15 complete. Every reference stays in the denominator. Keywords are scored separately.</p>
        {batch.items.map((item, n) => <div key={item.position}>
          <span>Reference {String(n + 1).padStart(2, '0')} · {evaluationComplete(item, batch) ? 'Ready' : item.labels?.flagged ? 'Needs review' : 'Incomplete'}</span>
          <button className="commons-button" onClick={() => { setIndex(n); setReview(false); }}>Review reference</button>
        </div>)}
        <p>{batch.tuning_count} separate tuning references reserved. {batch.excluded_count} unsupported non-media files excluded from the scan.</p>
        {batch.state === 'open' ? <>{batch.assisted_reviews > 0
          ? <p className="commons-notice" role="status">The agent graded these references before blind labels were sealed, so they can no longer be sealed as blind labels. Close them as assisted review to resume library analysis.</p>
          : <button className="commons-button commons-button--primary" disabled={busy || count !== 15} onClick={() => void run(() => api.seal(batch.revision))}>Seal all 15 labels</button>}
          <CommonsCloseBatch revision={batch.revision} assisted={batch.assisted_reviews > 0} disabled={busy || dirty} onClosed={(value) => { setBatch(value); setDirty(false); }} /></>
          : batch.state === 'closed' ? <p className="evaluation-hash">Closed · SHA-256: {batch.close_hash}</p>
          : <><p className="evaluation-hash">SHA-256: {batch.seal_hash}</p><button className="commons-button" onClick={() => {
            const url = URL.createObjectURL(new Blob([JSON.stringify({ payload: batch.sealed, sha256: batch.seal_hash }, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a'); link.href = url; link.download = 'commons-heldout-labels.json'; link.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}>Download sealed labels</button></>}
      </div> : <div className="evaluation-workspace">
        <nav aria-label="Held-out references">{batch.items.map((item, n) => <button key={item.position} disabled={busy || dirty} aria-current={index === n ? 'true' : undefined}
          onClick={() => setIndex(n)}>Reference {String(n + 1).padStart(2, '0')} <span>{evaluationComplete(item, batch) ? '✓' : item.labels?.flagged ? '⚑' : ''}</span></button>)}</nav>
        <ReferenceForm key={`${index}:${batch.revision}`} batch={batch} item={batch.items[index]} busy={busy} dirty={dirty} onDirty={setDirty} run={run} draftRef={draft} />
      </div>}
    </>}
  </section>;
}

function ReferenceForm({ batch, item, busy, dirty, onDirty, run, draftRef }: {
  batch: EvaluationBatch; item: EvaluationItem; busy: boolean; dirty: boolean;
  onDirty: (value: boolean) => void; run: (action: () => Promise<EvaluationBatch>) => Promise<SaveResult>;
  draftRef: { current: DraftActions | null };
}) {
  const [points, setPoints] = useState<AccentPoint[]>(item.accents ?? []);
  const [noAccents, setNoAccents] = useState(item.no_accents ?? false);
  const [labels, setLabels] = useState<EvaluationLabels>(() => structuredClone(item.labels ?? emptyLabels()));
  const [query, setQuery] = useState('');
  const [url, setUrl] = useState('');
  const [imageError, setImageError] = useState('');
  const [crosshair, setCrosshair] = useState<AccentPoint>({ x: 0.5, y: 0.5 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const readonly = batch.state !== 'open' || busy;
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = '';
    api.image(item.position, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => { if (!controller.signal.aborted && canvas.current) {
        canvas.current.getContext('2d')?.drawImage(image, 0, 0); setUrl(objectUrl);
      } };
      image.onerror = () => { if (!controller.signal.aborted) setImageError('Could not decode this reference. Reload to try again.'); };
      image.src = objectUrl;
    }, (e: Error) => { if (!controller.signal.aborted) setImageError(e.message); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item.position]);
  const change = (patch: Partial<EvaluationLabels>) => { setLabels((current) => ({ ...current, ...patch })); onDirty(true); };
  const saveAccents = () => run(() => api.accents(item.position, batch.revision, points.map(({ x, y }) => ({ x, y })), noAccents));
  const saveLabels = () => run(() => api.labels(item.position, batch.revision, labels));
  const discard = () => {
    setLabels(structuredClone(item.labels ?? emptyLabels())); setPoints(item.accents ?? []);
    setNoAccents(item.no_accents ?? false); onDirty(false);
  };
  // This step's own save and discard, for the Commons' leave popover.
  useEffect(() => { draftRef.current = { save: item.accent_locked ? saveLabels : saveAccents, discard }; });
  useEffect(() => () => { draftRef.current = null; }, [draftRef]);
  const unsavedMark = dirty && !busy && <span className="commons-unsaved">Unsaved</span>;
  const mark = (point: AccentPoint) => {
    if (readonly || item.accent_locked || !url || points.length >= 100) return;
    setPoints([...points, point]); setNoAccents(false); onDirty(true);
  };
  return <>
    <div className="evaluation-image">
      <h3 className="evaluation-step">Reference {String(item.position + 1).padStart(2, '0')}</h3>
      {imageError && <p role="alert">{imageError}</p>}
      {!url && !imageError && <p>Loading original image…</p>}
      <div className="evaluation-canvas" style={{ width: `min(100%, ${item.width / item.height * 64}vh)` }}>
        <canvas ref={canvas} width={item.width} height={item.height} tabIndex={0}
          aria-label="Original reference. Click to mark accents, or use arrow keys and Enter."
          onClick={(e) => { const box = e.currentTarget.getBoundingClientRect(); mark({ x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height }); }}
          onKeyDown={(e) => {
            if (readonly || item.accent_locked) return;
            const directions: Record<string, number[]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            if (directions[e.key]) {
              e.preventDefault(); const [dx, dy] = directions[e.key]; const step = e.shiftKey ? 0.05 : 0.01;
              setCrosshair({ x: Math.max(0, Math.min(1, crosshair.x + dx * step)), y: Math.max(0, Math.min(1, crosshair.y + dy * step)) });
            } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); mark(crosshair); }
          }} />
        {points.map((point, n) => <span className="evaluation-marker" key={n} style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>{n + 1}</span>)}
        {!item.accent_locked && <span className="evaluation-crosshair" style={{ left: `${crosshair.x * 100}%`, top: `${crosshair.y * 100}%` }}>+</span>}
      </div>
      <p>{item.accent_locked ? 'Accent observations locked before palette reveal.' : 'Click each accent color you see. The palette stays hidden until you save.'}</p>
    </div>
    <div className="evaluation-form">
      {!item.accent_locked ? <>
        <small>C2 · ACCENT OBSERVATIONS</small><h3 className="evaluation-step">What catches your eye?</h3><p>Choose the colors that stand out, even when they occupy very little space.</p>
        {points.map((point, n) => <div className="evaluation-point" key={n}>Accent {n + 1} · {Math.round(point.x * 100)}%, {Math.round(point.y * 100)}%
          <button className="commons-button" disabled={readonly} onClick={() => { setPoints(points.filter((_, i) => i !== n)); onDirty(true); }}>Remove accent {n + 1}</button></div>)}
        <label><input type="checkbox" checked={noAccents} disabled={readonly || !url} onChange={(e) => { setNoAccents(e.target.checked); setPoints([]); onDirty(true); }} /> I don’t see any accent colors</label>
        <div className="evaluation-save"><button className="commons-button commons-button--primary" disabled={readonly || !url || (!points.length && !noAccents)}
          onClick={() => void saveAccents()}>Save accents & reveal labels</button>{unsavedMark}</div>
      </> : <fieldset disabled={readonly}>
        <small>C1 · STRUCTURE & CHARACTER</small><h3 className="evaluation-step">Describe the visual language.</h3>
        {Object.entries(batch.fields).map(([key, values]) => <label key={key}>{pretty(key)}<select value={labels.tags[key] ?? ''}
          onChange={(e) => { const tags = { ...labels.tags }; if (e.target.value) tags[key] = e.target.value; else delete tags[key]; change({ tags }); }}>
          <option value="">Choose one…</option>{values.map((value) => <option key={value} value={value}>{pretty(value)}</option>)}
        </select></label>)}
        <h4 className="evaluation-subhead">Character</h4>
        {batch.axes.map((key) => <div className="evaluation-axis" key={key}><label>{pretty(key)} · {labels.axes[key]?.toFixed(2) ?? 'Unanswered'}
          <input aria-label={pretty(key)} aria-valuetext={labels.axes[key] === undefined ? 'Unanswered' : String(labels.axes[key])} type="range" min={-1} max={1} step={0.05} value={labels.axes[key] ?? 0}
            onChange={(e) => change({ axes: { ...labels.axes, [key]: Number(e.target.value) } })} /></label>
          <div><span>−1 {key.split('_')[0]}</span><button className="commons-button" onClick={() => change({ axes: { ...labels.axes, [key]: 0 } })}>Set neutral</button><span>+1 {key.split('_')[1]}</span></div>
        </div>)}
        <h4 className="evaluation-subhead">Assign color roles</h4><p>Measured palette · accent observations are already locked.</p>
        {item.palette?.map((p) => <label key={p.index} className="evaluation-role"><span style={{ background: p.hex }} />P{p.index}
          <select aria-label={`Role for P${p.index}`} value={labels.palette_roles[p.index] ?? ''} onChange={(e) => {
            const roles = { ...labels.palette_roles }; if (e.target.value) roles[p.index] = e.target.value; else delete roles[p.index]; change({ palette_roles: roles });
          }}><option value="">Choose a role…</option>{batch.roles.map((role) => <option key={role}>{role}</option>)}</select></label>)}
        <h4 className="evaluation-subhead">Keywords · {labels.keywords.length} / 12</h4>
        <div className="evaluation-keywords">{labels.keywords.map((word) => <button className="commons-button" key={word} onClick={() => change({ keywords: labels.keywords.filter((w) => w !== word) })}>{pretty(word)} ×</button>)}</div>
        <input aria-label="Search keywords" placeholder="Search the shared vocabulary…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="evaluation-keywords">{query.trim() && batch.keywords.filter((word) => word.includes(query.trim().toLowerCase().replaceAll(' ', '_')) && !labels.keywords.includes(word)).slice(0, 20).map((word) =>
          <button className="commons-button" key={word} disabled={labels.keywords.length >= 12} onClick={() => { change({ keywords: [...labels.keywords, word], no_keywords: false }); setQuery(''); }}>{pretty(word)}</button>)}</div>
        <label><input type="checkbox" checked={labels.no_keywords} onChange={(e) => change({ no_keywords: e.target.checked, keywords: [] })} /> No applicable keywords</label>
        <label><input type="checkbox" checked={labels.flagged} onChange={(e) => change({ flagged: e.target.checked })} /> I need to revisit this reference</label>
        <div className="evaluation-save"><button className="commons-button commons-button--primary" disabled={!dirty} onClick={() => void saveLabels()}>Save labels</button>{unsavedMark}</div>
      </fieldset>}
      {dirty && !busy && <button className="commons-button" onClick={discard}>Discard unsaved changes</button>}
      <p role="status">{batch.sealed ? 'Sealed · read only' : batch.state === 'closed' ? 'Closed · read only' : busy ? 'Saving…' : dirty ? 'Save before changing reference' : 'Saved on this computer'}</p>
    </div>
  </>;
}
