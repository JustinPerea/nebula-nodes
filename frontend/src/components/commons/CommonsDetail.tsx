import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { commonsApi } from '../../lib/commonsApi';
import { CommonsMedia } from './CommonsMedia';
import {
  AXES, AXIS_LABELS, ENUMS, ROLES, TEXT_FIELDS,
  type AssetDetail, type EnumField, type MembershipDetail, type Region, type Role, type Sighting,
} from '../../lib/commonsTypes';
import { showConfirm } from '../../lib/commonsFiles';
import { actorLabel, STATE_LABELS } from '../../lib/commonsFormat';
import { useCommonsPrompt } from '../../hooks/useCommonsPrompt';

interface Props {
  assetId: string;
  onClose: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}

type Box = [number, number, number, number];

const TEXT_LABELS: Record<string, string> = { summary: 'Summary', subject: 'Subject', composition_notes: 'Composition notes' };
const ENUM_LABELS: Record<EnumField, string> = {
  type_style: 'Type style', spacing_density: 'Spacing', layout: 'Layout', medium: 'Medium',
};
const SIGHTING_STATE: Record<Sighting['state'], string | null> = {
  ok: null, missing_from_folder: 'missing', archived: 'archived', superseded: 'superseded',
};

function sourceLabel(source: string | undefined): string | null {
  if (!source) return null;
  if (source.startsWith('model:')) return `model: ${source.slice(6)}`;
  return source;
}

function SourceBadge({ source }: { source: string | undefined }) {
  const label = sourceLabel(source);
  if (!label) return null;
  const kind = source === 'corrected' ? 'corrected' : source === 'code' ? 'code' : 'model';
  return <span className={`commons-source commons-source--${kind}`}>{label}</span>;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function boxStyle(box: Box): CSSProperties {
  return {
    '--rx': `${box[0] * 100}%`, '--ry': `${box[1] * 100}%`, '--rw': `${box[2] * 100}%`, '--rh': `${box[3] * 100}%`,
  } as CSSProperties;
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function Membership({ assetId, membership, run }: {
  assetId: string;
  membership: MembershipDetail;
  run: (work: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const postingRef = useRef(false);
  return (
    <section className="commons-detail__section commons-membership">
      <header className="commons-membership__head">
        <strong>{membership.collection_name}</strong>
        {membership.brand && <span className="commons-badge">{membership.brand}</span>}
        {membership.in_inbox ? (
          <>
            <span className="commons-badge commons-badge--inbox">inbox</span>
            <button type="button" className="commons-button" onClick={() => run(() => commonsApi.accept(membership.id))}>
              Accept
            </button>
          </>
        ) : null}
      </header>
      <div className="commons-detail__row">
        <label className="commons-field">
          Role
          <select
            value={membership.role}
            onChange={(event) => run(() => commonsApi.patchMembership(membership.id, { role: event.target.value as Role }))}
          >
            {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
        </label>
        <label className="commons-field commons-field--grow">
          Why
          <input
            key={membership.why ?? ''}
            defaultValue={membership.why ?? ''}
            placeholder="Why this belongs here"
            onBlur={(event) => {
              const why = event.target.value.trim();
              if (why !== (membership.why ?? '')) void run(() => commonsApi.patchMembership(membership.id, { why }));
            }}
          />
        </label>
      </div>
      <p className="commons-meta">Added by {actorLabel(membership.actor)}</p>

      {membership.sightings.length > 0 && (
        <ul className="commons-list">
          {membership.sightings.map((s) => (
            <li key={s.id} className="commons-list__item">
              <span className="commons-badge">{s.source_kind}</span>
              <span className="commons-list__text">{s.page_title || s.original_name || s.url || s.original_path || '—'}</span>
              {s.source_date && <span className="commons-meta">{s.source_date.slice(0, 10)}</span>}
              {SIGHTING_STATE[s.state] && (
                <span className={`commons-badge commons-badge--${SIGHTING_STATE[s.state]}`}>{SIGHTING_STATE[s.state]}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="commons-thread" aria-label={`Comments in ${membership.collection_name}`}>
        {membership.comments.map((c) => (
          <div key={c.id} className="commons-comment">
            <span className="commons-comment__actor">{actorLabel(c.actor)}</span>
            <span className="commons-meta">{(c.source_date ?? c.created_at).slice(0, 10)}</span>
            <p className="commons-comment__text">{c.text}</p>
          </div>
        ))}
        <form
          className="commons-thread__form"
          onSubmit={(event) => {
            event.preventDefault();
            const text = draft.trim();
            if (!text || postingRef.current) return;
            const submittedDraft = draft;
            postingRef.current = true;
            setPosting(true);
            void run(() => commonsApi.comment(assetId, text, membership.id)).then((saved) => {
              if (saved) setDraft((current) => current === submittedDraft ? '' : current);
            }).finally(() => {
              postingRef.current = false;
              setPosting(false);
            });
          }}
        >
          <input aria-label="Add a comment" placeholder="Add a comment" value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button type="submit" className="commons-button" disabled={posting || !draft.trim()}>Post</button>
        </form>
      </div>
    </section>
  );
}

export function CommonsDetail({ assetId, onClose, onChanged, onDeleted }: Props) {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draftBox, setDraftBox] = useState<Box | null>(null);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [frameIndex, setFrameIndex] = useState(0);
  const dragStart = useRef<[number, number] | null>(null);
  const [ask, promptElement] = useCommonsPrompt();

  const load = useCallback(async () => {
    try {
      setDetail(await commonsApi.asset(assetId));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [assetId]);

  useEffect(() => {
    let cancelled = false;
    commonsApi.asset(assetId).then(
      (d) => { if (!cancelled) setDetail(d); },
      (e: Error) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
  }, [assetId]);

  const run = useCallback(async (work: () => Promise<unknown>) => {
    try {
      await work();
      await load();
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }, [load, onChanged]);

  const correct = async (field_path: string, op: 'set' | 'add' | 'remove', value: unknown, withReason = false) => {
    let reason: string | undefined;
    if (withReason) {
      const answer = await ask('Why? (optional — helps the next reading)');
      if (answer === null) return;
      reason = answer.trim() || undefined;
    }
    await run(() => commonsApi.correct(assetId, { field_path, op, value, reason }));
  };

  if (!detail) {
    return (
      <aside className="commons-detail" aria-label="Asset detail">
        <div className="commons-detail__bar">
          <button type="button" className="commons-button" onClick={onClose}>Close</button>
        </div>
        <p className="commons-empty">{error ?? 'Loading…'}</p>
      </aside>
    );
  }

  const { asset, effective, regions } = detail;
  const fields = effective.fields;
  const sources = effective.sources;
  const corrected = new Set(effective.corrected_paths);
  const liveRegions = regions.filter((r) => r.status !== 'deleted');
  const frames = detail.keyframes ?? [];
  const frame = frames[Math.min(frameIndex, Math.max(0, frames.length - 1))];

  const pointFrom = (event: PointerEvent<HTMLDivElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    return [clamp01((event.clientX - rect.left) / rect.width), clamp01((event.clientY - rect.top) / rect.height)];
  };
  const boxFrom = (a: [number, number], b: [number, number]): Box => [
    Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]),
  ];
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragStart.current = pointFrom(event);
    setDraftBox([dragStart.current[0], dragStart.current[1], 0, 0]);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragStart.current) setDraftBox(boxFrom(dragStart.current, pointFrom(event)));
  };
  const onPointerUp = async (event: PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    dragStart.current = null;
    if (!start) return;
    const box = boxFrom(start, pointFrom(event));
    if (box[2] < 0.01 || box[3] < 0.01) {
      setDraftBox(null);
      return;
    }
    const label = await ask('Label this region');
    setDraftBox(null);
    if (label && label.trim()) await run(() => commonsApi.addRegion(assetId, box, label.trim()));
  };

  const renameRegion = async (region: Region) => {
    const label = await ask('Rename region', region.label);
    if (label && label.trim() && label.trim() !== region.label) {
      await run(() => commonsApi.patchRegion(region.id, { label: label.trim() }));
    }
  };

  const purge = async () => {
    if (!(await showConfirm('Delete this item and purge its file from the commons? This cannot be undone.'))) return;
    try {
      await commonsApi.purge(assetId);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const keywords = fields.keywords ?? [];
  const palette = fields.palette ?? [];

  return (
    <aside className="commons-detail" aria-label="Asset detail">
      <div className="commons-detail__bar">
        <span className={`commons-badge commons-badge--${asset.analysis_state}`}>{STATE_LABELS[asset.analysis_state]}</span>
        <span className="commons-meta">
          {asset.media}{asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''} · made by {asset.made_by}
        </span>
        {detail.quarantined && <span className="commons-badge commons-badge--analysis_failed">quarantined</span>}
        <span className="commons-spacer" />
        <button type="button" className="commons-button" onClick={onClose} aria-label="Close detail">Close</button>
      </div>

      {error && <p className="commons-notice commons-notice--error" role="alert">{error}</p>}

      {asset.analysis_state === 'analysis_failed' && (
        <div className="commons-notice commons-notice--error">
          <span>Analysis failed{asset.last_error ? `: ${asset.last_error}` : ''}</span>
          <button type="button" className="commons-button" onClick={() => run(() => commonsApi.reanalyze(assetId))}>Retry</button>
        </div>
      )}

      {asset.media === 'image' ? (
        <div className="commons-stage">
          <CommonsMedia className="commons-stage__image" path={detail.blob_url} alt={fields.summary?.value ?? ''} draggable={false} />
          <div
            className="commons-stage__overlay"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => void onPointerUp(event)}
            aria-label="Drag to draw a region"
          >
            {liveRegions.map((r) => (
              <div key={r.id} className={`commons-region commons-region--${r.status}`} style={boxStyle(r.box)}>
                <span className="commons-region__label">{r.label}</span>
              </div>
            ))}
            {draftBox && <div className="commons-region commons-region--draft" style={boxStyle(draftBox)} />}
          </div>
        </div>
      ) : (
        <div className="commons-stage commons-stage--video">
          {frame ? (
            <CommonsMedia className="commons-stage__image" path={frame.blob_url} alt={`Keyframe at ${formatTime(frame.t)}`} />
          ) : (
            <CommonsMedia video className="commons-stage__image" path={detail.blob_url} controls preload="metadata" />
          )}
          {frames.length > 0 && (
            <div className="commons-keyframes" role="tablist" aria-label="Keyframes">
              {frames.map((f, i) => (
                <button
                  key={f.asset_id} type="button" role="tab" aria-selected={f === frame}
                  className={`commons-keyframe${f === frame ? ' commons-keyframe--active' : ''}`}
                  onClick={() => setFrameIndex(i)}
                >
                  <CommonsMedia path={f.blob_url} alt="" loading="lazy" />
                  <span>{formatTime(f.t)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {liveRegions.length > 0 && (
        <ul className="commons-list" aria-label="Regions">
          {liveRegions.map((r) => (
            <li key={r.id} className="commons-list__item">
              <span className={`commons-badge commons-badge--region-${r.status}`}>{r.status}</span>
              <span className="commons-list__text">{r.label}</span>
              {r.status === 'proposed' && (
                <button type="button" className="commons-link" onClick={() => run(() => commonsApi.patchRegion(r.id, { status: 'confirmed' }))}>
                  Confirm
                </button>
              )}
              <button type="button" className="commons-link" onClick={() => void renameRegion(r)}>Rename</button>
              <button type="button" className="commons-link" onClick={() => run(() => commonsApi.patchRegion(r.id, { status: 'deleted' }))}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <section className="commons-detail__section" aria-label="Fields">
        {palette.length > 0 && (
          <div className="commons-field-block">
            <div className="commons-field-block__head">Palette <SourceBadge source={sources.palette} /></div>
            <div className="commons-palette">
              {palette.map((p, i) => (
                <span
                  key={`${p.hex}-${i}`}
                  className={`commons-swatch${p.is_accent ? ' commons-swatch--accent' : ''}`}
                  style={{ '--swatch': p.hex } as CSSProperties}
                  title={`${p.hex} · ${(p.share * 100).toFixed(1)}%${p.is_accent ? ' · accent' : ''}`}
                >
                  <span className="commons-swatch__chip" />
                  <span className="commons-swatch__text">{p.hex}</span>
                  <span className="commons-meta">{(p.share * 100).toFixed(0)}%{p.is_accent ? ' ◆' : ''}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {TEXT_FIELDS.map((key) => (
          <label key={key} className="commons-field">
            <span className="commons-field-block__head">
              {TEXT_LABELS[key]} <SourceBadge source={sources[`${key}.value`]} />
            </span>
            <textarea
              key={fields[key]?.value ?? ''}
              rows={key === 'summary' ? 3 : 2}
              defaultValue={fields[key]?.value ?? ''}
              onBlur={(event) => {
                const value = event.target.value.trim();
                if (value !== (fields[key]?.value ?? '')) void correct(`${key}.value`, 'set', value);
              }}
            />
          </label>
        ))}

        <div className="commons-detail__grid">
          {(Object.keys(ENUMS) as EnumField[]).map((key) => (
            <label key={key} className="commons-field">
              <span className="commons-field-block__head">
                {ENUM_LABELS[key]} <SourceBadge source={sources[`${key}.value`]} />
              </span>
              <select
                value={fields[key]?.value ?? ''}
                onChange={(event) => void correct(`${key}.value`, 'set', event.target.value, true)}
              >
                <option value="" disabled>—</option>
                {ENUMS[key].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
          ))}
        </div>

        <div className="commons-field-block">
          <div className="commons-field-block__head">Axes</div>
          <div className="commons-detail__grid">
            {AXES.map((axis) => {
              const value = fields.axes?.[axis]?.value;
              return (
                <label key={axis} className="commons-field">
                  <span className="commons-field-block__head">
                    {AXIS_LABELS[axis].join(' – ')} <SourceBadge source={sources[`axes.${axis}.value`]} />
                  </span>
                  <input
                    key={String(value)}
                    type="number" min={-1} max={1} step={0.05}
                    defaultValue={value ?? ''}
                    onBlur={(event) => {
                      if (event.target.value === '') return;
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next) || next < -1 || next > 1 || next === value) return;
                      void correct(`axes.${axis}.value`, 'set', next);
                    }}
                  />
                </label>
              );
            })}
          </div>
        </div>

        <div className="commons-field-block">
          <div className="commons-field-block__head">
            Keywords <SourceBadge source={corrected.has('keywords') ? 'corrected' : sources.keywords} />
          </div>
          <div className="commons-chips">
            {keywords.map((k) => (
              <span key={k} className="commons-chip">
                {k}
                <button type="button" aria-label={`Remove ${k}`} onClick={() => void correct('keywords', 'remove', k)}>×</button>
              </span>
            ))}
          </div>
          <input
            aria-label="Add keyword" placeholder="Add keyword, Enter" value={keywordDraft}
            onChange={(event) => setKeywordDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              const k = keywordDraft.trim().toLowerCase();
              setKeywordDraft('');
              if (k && !keywords.includes(k)) void correct('keywords', 'add', k);
            }}
          />
        </div>

        {effective.analysis && (
          <p className="commons-meta">
            Read by {effective.analysis.model_id} · prompt {effective.analysis.prompt_version} · {effective.analysis.created_at.slice(0, 16).replace('T', ' ')}
          </p>
        )}
      </section>

      {detail.memberships.map((m) => (
        <Membership key={m.id} assetId={assetId} membership={m} run={run} />
      ))}

      <section className="commons-detail__section" aria-label="Used in">
        <div className="commons-field-block__head">Used in</div>
        {detail.borrowings.length === 0 ? (
          <p className="commons-meta">Not borrowed yet.</p>
        ) : (
          <ul className="commons-list">
            {detail.borrowings.map((b) => {
              const status = b.fidelity?.status ?? 'pending';
              return (
                <li key={b.id} className="commons-list__item">
                  <span className={`commons-badge commons-badge--fidelity-${status}`} title={b.fidelity?.reason}>{status}</span>
                  <span className="commons-list__text">{b.attribute} → {b.used_in.kind}:{b.used_in.ref}</span>
                  <span className="commons-meta">{actorLabel(b.actor)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="commons-detail__actions">
        <button type="button" className="commons-button" onClick={() => run(() => commonsApi.reanalyze(assetId))}>Re-analyze</button>
        <button type="button" className="commons-button commons-button--danger" onClick={() => void purge()}>Delete and purge</button>
      </div>
      {promptElement}
    </aside>
  );
}
