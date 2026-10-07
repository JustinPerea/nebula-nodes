import { useEffect, useRef, useState } from 'react';
import { commonsReviewApi as api, commonsEvaluationApi } from '../../lib/commonsApi';
import type { EvaluationLabels } from '../../lib/commonsEvaluationTypes';
import type { ReviewBatch, ReviewItem } from '../../lib/commonsReviewTypes';
import { CommonsCloseBatch } from './CommonsCloseBatch';
import '../../styles/commons-evaluation.css';
import '../../styles/commons-review.css';

const pretty = (text: string) => text === 'n_a' ? 'Not applicable' : text.replaceAll('_', ' ');

export function CommonsReview({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [batch, setBatch] = useState<ReviewBatch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const alive = useRef(false);
  const editingDraft = useRef(false);
  const requestVersion = useRef(0);
  const pendingWrites = useRef(0);
  const markDirty = (value: boolean) => { editingDraft.current = value; setDirty(value); };
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    const refresh = () => {
      if (pendingWrites.current || editingDraft.current) return;
      const version = ++requestVersion.current;
      return api.get().then((value) => {
        if (!cancelled && !pendingWrites.current && !editingDraft.current && version === requestVersion.current) {
          setBatch(value); setError('');
        }
      }, (e: Error) => {
        if (!cancelled && !pendingWrites.current && !editingDraft.current && version === requestVersion.current) setError(e.message);
      }).finally(() => { if (!cancelled) setLoading(false); });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { cancelled = true; alive.current = false; window.clearInterval(timer); };
  }, []);
  useEffect(() => {
    onDirtyChange?.(dirty || saving || generating);
    return () => onDirtyChange?.(false);
  }, [dirty, saving, generating, onDirtyChange]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty || generating) event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, generating]);
  async function generate() {
    if (!batch || pendingWrites.current || editingDraft.current) return;
    pendingWrites.current++;
    requestVersion.current++;
    setGenerating(true); setError('');
    try {
      for (const item of batch.items.filter((i) => i.status === 'pending')) {
        if (!alive.current) break;
        const value = await api.propose(item.position);
        requestVersion.current++;
        if (alive.current && !editingDraft.current) setBatch(value);
        if (value.items.find((i) => i.position === item.position)?.status === 'failed') break;
      }
    } catch (e) { if (alive.current) setError((e as Error).message); }
    finally {
      pendingWrites.current--;
      if (alive.current) setGenerating(false);
    }
  }
  async function accept(item: ReviewItem, labels: EvaluationLabels) {
    if (pendingWrites.current) return;
    pendingWrites.current++;
    requestVersion.current++;
    setSaving(true); setError('');
    try {
      const value = await api.accept(item.position, item.revision, labels);
      requestVersion.current++; setBatch(value); markDirty(false);
      const next = value.items.findIndex((i, n) => n > index && !i.reviewed_at);
      const first = value.items.findIndex((i) => !i.reviewed_at);
      if (next >= 0 || first >= 0) setIndex(next >= 0 ? next : first);
    } catch (e) { setError((e as Error).message); }
    finally { pendingWrites.current--; setSaving(false); }
  }
  if (loading) return <p className="commons-notice">Loading agent reviews…</p>;
  const reviewed = batch?.items.filter((i) => i.reviewed_at).length ?? 0;
  const ready = batch?.items.filter((i) => i.status === 'ready').length ?? 0;
  const running = generating || batch?.items.some((i) => i.status === 'running');
  const item = batch?.items[index];
  return <section className="commons-evaluation commons-review" aria-label="Agent reference review">
    <header className="evaluation-heading"><div>
      <small>AGENT GRADES · YOUR JUDGMENT</small><h1>Does this read right?</h1>
      <p>See the agent’s take. Agree, or change the parts you see differently.</p>
    </div><div className="review-progress"><strong>{reviewed} / {batch?.items.length ?? 15} reviewed</strong>
      <p>{ready} grades ready{running ? ' · Grading in progress…' : ''}</p>
      {batch?.state === 'open' && !running && batch.attempts < batch.call_budget && batch.items.some((i) => i.status === 'pending') &&
        <button className="commons-button" disabled={dirty || saving} onClick={() => void generate()}>Generate remaining grades</button>}
    </div></header>
    {error && <p role="alert" className="commons-notice commons-notice--error">{error}</p>}
    {!batch && <p>Prepare the reference set in Blind labeling first.</p>}
    {batch && item && <div className="evaluation-workspace">
      <nav aria-label="References to review">{batch.items.map((ref, n) => <button key={ref.position} disabled={dirty || saving || generating}
        aria-current={index === n ? 'true' : undefined} onClick={() => setIndex(n)}>
        Reference {String(n + 1).padStart(2, '0')} <span>{ref.reviewed_at ? '✓' : ref.status === 'ready' ? '•' : ref.status === 'failed' ? '!' : ref.status === 'running' ? '…' : ''}</span>
      </button>)}</nav>
      <ReferenceImage key={item.position} item={item} />
      <ReviewForm key={`${item.position}:${item.revision}`} batch={batch} item={item} dirty={dirty} saving={saving} generating={generating}
        onDirty={markDirty} onAccept={(labels) => accept(item, labels)} />
    </div>}
    <footer className="review-footer"><p>Agent proposals and your decisions are saved separately. This is assisted review, not an independent blind accuracy score.</p>
      {batch?.state === 'closed' && <p className="evaluation-hash" role="status">Closed as assisted review · {batch.closed_at ? new Date(batch.closed_at).toLocaleString() : ''} · SHA-256: {batch.close_hash}</p>}
      {batch?.state === 'open' && <CommonsCloseBatch revision={batch.batch_revision} assisted reviewed={reviewed} total={batch.items.length}
        disabled={dirty || saving || !!running} onClosed={(closed) => {
          // The close has committed: show it now, then reload. A failed reload is left to the poll.
          const version = ++requestVersion.current;
          setBatch((b) => b && { ...b, state: closed.state, batch_revision: closed.revision, close_hash: closed.close_hash,
            closed_at: typeof closed.closed?.closed_at === 'string' ? closed.closed.closed_at : b.closed_at });
          api.get().then((value) => {
            if (alive.current && !editingDraft.current && version === requestVersion.current) setBatch(value);
          }, () => undefined);
        }} />}
      {batch && <button className="commons-button" disabled={dirty || saving} onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(batch, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = 'commons-assisted-review.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }}>Download review record</button>}
    </footer>
  </section>;
}

function ReferenceImage({ item }: { item: ReviewItem }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); let objectUrl = '';
    commonsEvaluationApi.image(item.position, controller.signal).then((blob) => {
      if (!controller.signal.aborted) { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); }
    }, (e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [item.position]);
  return <div className="evaluation-image"><h2>Reference {String(item.position + 1).padStart(2, '0')}</h2>
    {error ? <p role="alert">{error}</p> : url ? <img className="review-reference" src={url} alt={`Reference ${item.position + 1}`} /> : <p>Loading image…</p>}
    {item.proposal && <p>{item.proposal.model} · {item.proposal.prompt_version}</p>}
  </div>;
}

function ReviewForm({ batch, item, dirty, saving, generating, onDirty, onAccept }: {
  batch: ReviewBatch; item: ReviewItem; dirty: boolean; saving: boolean; generating: boolean;
  onDirty: (dirty: boolean) => void; onAccept: (labels: EvaluationLabels) => Promise<void>;
}) {
  const baseline = item.reviewed_labels ?? item.proposal?.labels;
  const [labels, setLabels] = useState(() => baseline ? structuredClone(baseline) : null);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState('');
  const disabled = saving || generating;
  if (!item.proposal || !labels) return <div className="evaluation-form"><h2>{item.status === 'failed' ? 'Grade unavailable' : item.status === 'running' ? 'The agent is looking…' : 'Waiting for a grade'}</h2>
    <p>{item.error ?? 'The complete grade will appear here. There is nothing to fill out first.'}</p></div>;
  const change = (patch: Partial<EvaluationLabels>) => { setLabels({ ...labels, ...patch }); onDirty(true); };
  const fields = item.proposal.fields;
  const reason = (key: string) => (fields[key] as { why?: string } | undefined)?.why;
  const agreement = <button className="commons-button commons-button--primary" disabled={disabled}
    onClick={() => void onAccept(labels)}>{saving ? 'Saving…' : dirty ? 'Save corrections & next' : item.reviewed_at ? 'Keep this review & next' : 'Agree & next'}</button>;
  return <div className="evaluation-form">
    <small>{item.reviewed_at ? 'YOUR SAVED REVIEW' : 'PROPOSED BY THE AGENT'}</small>
    <h2>{fields.summary.value}</h2><p>{fields.composition_notes.value}</p>
    <div className="review-actions">{agreement}<button className="commons-button" disabled={disabled} onClick={() => setEditing(!editing)}>{editing ? 'Hide editing controls' : 'Edit grades'}</button></div>
    <fieldset disabled={disabled}>
      <h3>Structure</h3>{Object.entries(batch.fields).map(([key, values]) => <div className="review-grade" key={key}>
        <label>{pretty(key)}{editing ? <select value={labels.tags[key]} onChange={(e) => change({ tags: { ...labels.tags, [key]: e.target.value } })}>
          {values.map((value) => <option key={value} value={value}>{pretty(value)}</option>)}
        </select> : <strong>{pretty(labels.tags[key])}</strong>}</label><p className="review-reason">Agent: {reason(key)}</p>
      </div>)}
      <h3>Character</h3>{batch.axes.map((key) => <div className="review-grade" key={key}>
        <label>{pretty(key)} <strong>{labels.axes[key].toFixed(2)}</strong>
          {editing ? <input aria-label={pretty(key)} type="range" min={-1} max={1} step={0.05} value={labels.axes[key]}
            onChange={(e) => change({ axes: { ...labels.axes, [key]: Number(e.target.value) } })} />
            : <meter aria-label={pretty(key)} min={-1} max={1} value={labels.axes[key]} />}
        </label><div className="review-axis-ends"><span>−1 {key.split('_')[0]}</span><span>+1 {key.split('_')[1]}</span></div>
        <p className="review-reason">Agent: {fields.axes[key].why}</p>
      </div>)}
      <h3>Color roles</h3>{item.palette?.map((p) => <label key={p.index} className="evaluation-role"><span style={{ background: p.hex }} title={p.hex} />
        <span className="review-swatch-label">P{p.index} · {p.share * 100 < 0.1 ? '<0.1' : (p.share * 100).toFixed(1)}%</span>
        {editing ? <select aria-label={`Role for P${p.index}`} value={labels.palette_roles[p.index]} onChange={(e) => change({ palette_roles: { ...labels.palette_roles, [p.index]: e.target.value } })}>
          {batch.roles.map((role) => <option key={role}>{role}</option>)}</select> : <strong>{labels.palette_roles[p.index]}</strong>}
      </label>)}
      <h3>Keywords</h3><div className="evaluation-keywords">{labels.keywords.map((word) => editing ?
        <button className="commons-button" key={word} onClick={() => { const words = labels.keywords.filter((w) => w !== word); change({ keywords: words, no_keywords: !words.length }); }}>{pretty(word)} ×</button>
        : <span className="review-keyword" key={word}>{pretty(word)}</span>)}{!labels.keywords.length && <span>No applicable keywords</span>}</div>
      {editing && <><input aria-label="Search keywords" value={query} placeholder="Add a keyword…" onChange={(e) => setQuery(e.target.value)} />
        <div className="evaluation-keywords">{query.trim() && batch.keywords.filter((word) => word.includes(query.trim().toLowerCase().replaceAll(' ', '_')) && !labels.keywords.includes(word)).slice(0, 20).map((word) =>
          <button className="commons-button" key={word} disabled={labels.keywords.length >= 12} onClick={() => { change({ keywords: [...labels.keywords, word], no_keywords: false }); setQuery(''); }}>{pretty(word)}</button>)}</div></>}
    </fieldset>
    {agreement}
    {dirty && <button className="commons-button" disabled={disabled} onClick={() => { setLabels(structuredClone(baseline!)); onDirty(false); }}>Discard changes</button>}
    <p role="status">{dirty ? 'Unsaved corrections · save before changing reference' : item.reviewed_at ? 'Reviewed by you · saved on this computer' : 'Awaiting your review · nothing accepted yet'}</p>
    <details><summary>Original agent grade</summary><dl>
      {Object.entries(item.proposal.labels.tags).map(([key, value]) => <div key={key}><dt>{pretty(key)}</dt><dd>{pretty(value)}</dd></div>)}
      {Object.entries(item.proposal.labels.axes).map(([key, value]) => <div key={key}><dt>{pretty(key)}</dt><dd>{value.toFixed(2)}</dd></div>)}
      {Object.entries(item.proposal.labels.palette_roles).map(([key, value]) => <div key={key}><dt>Color P{key}</dt><dd>{value}</dd></div>)}
      <dt>Keywords</dt><dd>{item.proposal.labels.keywords.map(pretty).join(', ') || 'No applicable keywords'}</dd>
    </dl></details>
  </div>;
}
