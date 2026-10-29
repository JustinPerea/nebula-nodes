import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ArrowRight } from 'lucide-react';
import { backendAssetUrlSync } from '../../lib/backend';
import { takeReview } from '../../store/assetProposalReviewRequest';
import type { AssetProposalKind, AssetProposalView, CommonsEdit } from '../../lib/assetProposals';
import { proposalsFor, useAssetProposalsStore, type AssetProposalEntry } from '../../store/assetProposalsStore';
import { PROPOSAL_GATE_COPY } from '../../lib/canvasProposals';
import { personGateHeld, subscribePersonGate } from '../../lib/personSession';
import '../../styles/asset-proposals.css';

/** How often the strip rechecks expiry while one is showing. */
const TICK_MS = 15_000;
/** How long the Review ring stays on the strip (asset-proposals.css). */
const REVIEW_RING_MS = 1600;

/** Region and membership ids the screen can name (CommonsDetail: a region's label, a collection's name). */
export type ProposalNames = Readonly<Record<string, string>>;

function editCount(view: AssetProposalView): number {
  return view.change.edits?.length ?? 0;
}

function headline(view: AssetProposalView): string {
  if (view.kind === 'moodboard') return 'asks to send these notes to generators';
  if (view.kind === 'commons') {
    const count = editCount(view);
    return count === 1 ? 'proposes a change to this reference' : `proposes ${count} changes to this reference`;
  }
  return view.change.cover?.to ? 'proposes a new cover' : 'proposes the automatic cover';
}

function labels(view: AssetProposalView): { accept: string; reject: string } {
  if (view.kind === 'moodboard') return { accept: 'Send them', reject: 'Keep them here' };
  if (view.kind === 'commons') return { accept: editCount(view) === 1 ? 'Apply' : 'Apply all', reject: "Don't" };
  const accept = view.change.cover?.to ? 'Use this cover' : 'Use automatic';
  return { accept, reject: view.change.cover?.fromBy?.kind === 'person' ? 'Keep mine' : 'Keep this one' };
}

function minutesLeft(view: AssetProposalView, now: number): string {
  const minutes = Math.max(0, Math.ceil((view.expiresAt - now) / 60_000));
  return minutes <= 1 ? 'Under a minute left' : `${minutes} min left`;
}

function CoverChange({ view }: { view: AssetProposalView }) {
  const cover = view.change.cover;
  if (!cover) return null;
  const by = cover.fromBy;
  // A pin whose image left the project no longer counts (Q90 a): the backend
  // sends `from: null` then, so this never says "You pinned" over a missing image.
  const caption = !cover.from ? 'Automatic now' : by?.kind === 'person' ? 'You pinned' : `${by?.name ?? 'An agent'} set`;
  const lost = cover.lostPin ? (cover.lostPin.by?.kind === 'person' ? 'The image you pinned'
    : `The image ${cover.lostPin.by?.name ?? 'an agent'} set`) : null;
  // The automatic side shows the image the automatic cover is now, when the project has one.
  const side = (pick: string | null, text: string, proposed: boolean) => {
    const url = pick ?? cover.auto ?? null;
    return (
      <figure className={`asset-proposal__cover${proposed ? ' asset-proposal__cover--to' : ''}`}>
        {url ? <img src={backendAssetUrlSync(url)} alt="" loading="lazy" draggable={false} />
          : <span className="asset-proposal__cover-auto">Newest image</span>}
        <figcaption>{text}</figcaption>
      </figure>
    );
  };
  return (
    <>
      <div className="asset-proposal__covers">
        {side(cover.from, caption, false)}
        <ArrowRight className="asset-proposal__arrow" aria-hidden="true" />
        {side(cover.to, cover.to ? 'Proposed' : 'Automatic', true)}
      </div>
      {lost && <p className="asset-proposal__lost">{lost} is no longer in this project, so the cover is automatic.</p>}
    </>
  );
}

const FIELD_LABELS: Record<string, string> = {
  summary: 'Summary', subject: 'Subject', composition_notes: 'Composition notes', type_style: 'Type style',
  spacing_density: 'Spacing', layout: 'Layout', medium: 'Medium', keywords: 'Keywords',
  'axes.quiet_loud': 'Quiet – Loud', 'axes.warm_cold': 'Warm – Cold', 'axes.geometric_humanist': 'Geometric – Humanist',
  'axes.dense_airy': 'Dense – Airy', 'axes.polished_raw': 'Polished – Raw',
};

function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return typeof value === 'string' ? value : String(value);
}

const quoted = (text: string) => `“${text}”`;

function regionChange(body: Extract<CommonsEdit, { region: unknown }>['region']): string {
  const parts: string[] = [];
  if (body.status === 'confirmed') parts.push('confirm it');
  if (body.status === 'deleted') parts.push('delete it');
  if (body.label !== undefined) parts.push(`rename to ${quoted(body.label)}`);
  if (body.note !== undefined) parts.push(`note ${quoted(body.note)}`);
  if (body.box) parts.push('move or resize it');
  return parts.join(' · ');
}

function membershipChange(body: Extract<CommonsEdit, { membership: unknown }>['membership'],
  was: Record<string, unknown> | null): string {
  const parts: string[] = [];
  if (body.role !== undefined) parts.push(was ? `role ${shown(was.role)} → ${body.role}` : `role ${body.role}`);
  if (body.why !== undefined) parts.push(`why ${quoted(body.why)}`);
  if (body.accept) parts.push('take it out of the inbox');
  return parts.join(' · ');
}

/** One edit: what it changes, as it is now (when this screen got `before`) and as proposed. */
function CommonsEditRow({ edit, was, names }: { edit: CommonsEdit; was: Record<string, unknown> | null;
  names: ProposalNames }) {
  if ('correction' in edit) {
    const { field_path: path, op, value, reason } = edit.correction;
    const key = path.replace(/\.value$/, '');
    const label = FIELD_LABELS[key] ?? key;
    return (
      <li className="asset-proposal__edit">
        <span className="asset-proposal__edit-label">{label}</span>
        {key === 'keywords' ? (
          <span className="asset-proposal__edit-to">{op === 'add' ? '+' : '−'} {shown(value)}</span>
        ) : (
          <>
            {was && 'value' in was && <span className="asset-proposal__edit-from">{shown(was.value)}</span>}
            {was && 'value' in was && <span className="asset-proposal__edit-arrow" aria-hidden="true">→</span>}
            <span className="asset-proposal__edit-to">{shown(value)}</span>
          </>
        )}
        {reason && <span className="asset-proposal__edit-why">Why: {reason}</span>}
      </li>
    );
  }
  if ('region' in edit) {
    const body = edit.region;
    if (!body.id) {
      return (
        <li className="asset-proposal__edit">
          <span className="asset-proposal__edit-label">New region</span>
          <span className="asset-proposal__edit-to">{quoted(body.label ?? '')}</span>
        </li>
      );
    }
    const name = typeof was?.label === 'string' ? was.label : names[body.id];
    return (
      <li className="asset-proposal__edit">
        <span className="asset-proposal__edit-label">{name ? `Region ${quoted(name)}` : 'A region'}</span>
        <span className="asset-proposal__edit-to">{regionChange(body)}</span>
      </li>
    );
  }
  const body = edit.membership;
  const collection = names[body.id];
  return (
    <li className="asset-proposal__edit">
      <span className="asset-proposal__edit-label">{collection ? `In ${collection}` : 'In a collection'}</span>
      <span className="asset-proposal__edit-to">{membershipChange(body, was)}</span>
    </li>
  );
}

function CommonsChange({ view, names }: { view: AssetProposalView; names: ProposalNames }) {
  const edits = view.change.edits ?? [];
  return (
    <ul className="asset-proposal__edits">
      {edits.map((edit, index) => (
        // The edits never reorder while a proposal shows, so their place is their key.
        <CommonsEditRow key={index} edit={edit} was={view.before?.[index] ?? null} names={names} />
      ))}
    </ul>
  );
}

const NO_NAMES: ProposalNames = {};

function ProposalCard({ entry, now, names }: { entry: AssetProposalEntry; now: number; names: ProposalNames }) {
  const { view, closing } = entry;
  // The strip's clock ticks every 15 s from when it mounted (Moodboard Studio
  // mounts it with the board, long before a proposal may come): count from
  // no earlier than when this proposal showed.
  const [shownAt] = useState(() => Date.now());
  const pending = useAssetProposalsStore((state) => state.pending[view.id]);
  const error = useAssetProposalsStore((state) => state.errors[view.id]);
  const accept = useAssetProposalsStore((state) => state.accept);
  const reject = useAssetProposalsStore((state) => state.reject);
  const said = headline(view);
  const words = labels(view);
  const busy = Boolean(pending || closing);
  // GM r33 item 1 (review 18 LOW-2): held like the canvas's proposal bar while
  // this tab isn't connected as the person (both routes are person-only:
  // main._decidable_asset_proposal, require_person), with the same titles;
  // the server's promote clears it and its demote brings it back.
  const gateHeld = useSyncExternalStore(subscribePersonGate, personGateHeld);
  return (
    <div role="group" aria-label={`${view.agent.name} ${said}`} tabIndex={-1}
      className={`asset-proposal${closing ? ' asset-proposal--closing' : ''}`}
      style={{ '--agent-color': view.agent.color } as CSSProperties}>
      <div className="asset-proposal__who">
        <span className="asset-proposal__dot" aria-hidden="true" />
        <span className="asset-proposal__agent">{view.agent.name}</span>
        <span className="asset-proposal__asks">{said}</span>
      </div>
      {view.note && <p className="asset-proposal__note">{view.note}</p>}
      {view.kind === 'project' && <CoverChange view={view} />}
      {view.kind === 'commons' && <CommonsChange view={view} names={names} />}
      {error && <p className="asset-proposal__error" role="alert">{error}</p>}
      <div className="asset-proposal__foot">
        <span className="asset-proposal__expires">{closing ? '' : minutesLeft(view, Math.max(now, shownAt))}</span>
        <button type="button" className="asset-proposal__button" disabled={busy || gateHeld}
          title={gateHeld ? PROPOSAL_GATE_COPY.reject : undefined}
          onClick={() => void reject(view.id)}>{pending === 'reject' ? 'Saying no…' : words.reject}</button>
        <button type="button" className="asset-proposal__button asset-proposal__button--accept" disabled={busy || gateHeld}
          title={gateHeld ? PROPOSAL_GATE_COPY.accept : undefined}
          onClick={() => void accept(view.id)}>{pending === 'accept' ? 'Accepting…' : words.accept}</button>
      </div>
    </div>
  );
}

/**
 * An agent's proposal for this project, board or Commons reference, where the
 * person works on it: on its card on the Projects screen, beside Send notes in
 * Moodboard Studio, on the reference's detail in the Commons. Nothing changes
 * until they accept (backend /api/asset-proposals).
 */
export function AssetProposalStrip({ kind, targetId, names = NO_NAMES }: { kind: AssetProposalKind; targetId: string;
  names?: ProposalNames }) {
  const entries = useAssetProposalsStore(useShallow((state) => proposalsFor(state, kind, targetId)));
  const [now, setNow] = useState(() => Date.now());
  const showing = entries.length > 0;
  const root = useRef<HTMLDivElement>(null);
  const asked = useAssetProposalsStore((state) => state.review?.kind === kind && state.review.targetId === targetId);
  const ringTimer = useRef<number | null>(null);
  // Review on this proposal's Update (Q92 a): come into view and take focus,
  // with a ring that springs in and settles (asset-proposals.css).
  useEffect(() => {
    const element = root.current;
    if (!asked || !showing || !element) return;
    if (!takeReview(kind, targetId)) return;
    element.scrollIntoView({ block: 'center', inline: 'nearest' });
    element.querySelector<HTMLElement>('[role="group"]')?.focus({ preventScroll: true });
    element.dataset.review = 'true';
    if (ringTimer.current !== null) window.clearTimeout(ringTimer.current);
    ringTimer.current = window.setTimeout(() => {
      ringTimer.current = null;
      delete element.dataset.review;
    }, REVIEW_RING_MS);
  }, [asked, showing, kind, targetId]);
  useEffect(() => () => {
    if (ringTimer.current !== null) window.clearTimeout(ringTimer.current);
  }, []);
  useEffect(() => {
    if (!showing) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      useAssetProposalsStore.getState().pruneExpired();
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [showing]);
  if (!showing) return null;
  return (
    <div className="asset-proposals" ref={root}>
      {entries.map((entry) => <ProposalCard key={entry.view.id} entry={entry} now={now} names={names} />)}
    </div>
  );
}
