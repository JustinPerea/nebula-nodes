import { useContext, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { LeaveBusyContext } from './leaveBusy';
import { HELD_OPS, useNoteLock } from './heldLock';
import { PersonLockLine, type PersonLock } from '../PersonLock';
import { backendAssetUrlSync } from '../../lib/backend';
import type { AgentNote, AgentNoteAction, AgentNoteAuthor, AgentNoteRun } from '../../lib/agentNotes';
import { authorInitials, clipDuration, noteControls, type NoteButton } from '../../lib/agentNotesView';

/**
 * What a surface (the main canvas, later a board in the Studio) gives the
 * Updates corner: how to label and run Show, how to run an edit action, and
 * where the list says it is kept.
 */
export interface AgentNotesAdapter {
  /** "kept with this project" / "kept with this board". */
  keptWith: string;
  showLabel: (note: AgentNote) => string;
  /**
   * Show and a row click: bring the refs into view and outline them. Writes
   * nothing. From another screen it returns the way there: it resolves once
   * there, or rejects with the reason it can't go (the corner shows it).
   */
  show: (note: AgentNote) => void | Promise<void>;
  /** Run an edit action as the person, through the route its button uses elsewhere. */
  runAction: (note: AgentNote, action: AgentNoteAction) => void | Promise<void>;
  /** Why an action can't run any more ("Expired"), or null while it can. */
  actionState?: (action: AgentNoteAction) => string | null;
  /** A board image's number now (the Studio's board), to draw `#n` in the text. */
  numberFor?: (ref: string) => number | null;
  /** Whether hovering an entry or a card outlines its refs (the canvas's
   *  outline layer draws nodes only; a board's refs are images). */
  outlines?: boolean;
  /** The Agents panel's Working row (Q125 item 2): these nodes in view and
   *  outlined, as Show does; from another screen, the canvas first. */
  showNodes?: (nodeIds: string[], color: string) => void | Promise<void>;
  /** The Agents panel's Needs-you row: open a proposal where it is decided, as Review does. */
  reviewProposal?: (proposal: { proposalId: string; target: string; targetId: string | null }) => Promise<void>;
}

/** The hollow ring's tooltip (Q125 item 2, GM): an agent that named itself, with no token. */
export const NAMED_ITSELF = 'This agent named itself.';

export function AuthorDot({
  author,
  lit,
  verified,
}: {
  author: Pick<AgentNoteAuthor, 'kind' | 'name' | 'color'>;
  /** The chip's dots brighten while their author has unread updates. */
  lit?: boolean;
  /** False draws a hollow ring in the agent's colour (the Agents panel and
   *  the question form): it named itself. Left out, the dot is as before. */
  verified?: boolean;
}) {
  const unverified = verified === false;
  return (
    <span
      className={`agent-notes-dot agent-notes-dot--${author.kind}${unverified ? ' agent-notes-dot--unverified' : ''}`}
      data-lit={lit === undefined ? undefined : String(lit)}
      style={{ '--an-dot': author.color } as CSSProperties}
      title={unverified ? NAMED_ITSELF : undefined}
      aria-hidden="true"
    >
      {authorInitials(author)}
    </span>
  );
}

/**
 * A done card's picture (Q125 item 3; GM - Design, 2026-10-25): below the
 * message, 96 px tall, natural aspect, never cropped, capped at the card's
 * width. A video shows its first frame with its length in mono in the
 * corner. None for a failed run, or when the file can't be read.
 */
export function RunThumbnail({ run }: { run: AgentNoteRun | null | undefined }) {
  const [failed, setFailed] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const thumb = run && run.outcome !== 'failure' ? run.thumbnail : undefined;
  if (!thumb || failed) return null;
  const src = backendAssetUrlSync(thumb.url);
  return (
    <div className="agent-run-thumb" data-kind={thumb.kind}>
      {thumb.kind === 'image' ? (
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <>
          {/* #t: the first frame, without playing it. */}
          <video src={`${src}#t=0.001`} preload="metadata" muted playsInline aria-hidden="true"
            onLoadedMetadata={(event) => {
              const length = event.currentTarget.duration;
              setDuration(Number.isFinite(length) && length > 0 ? length : null);
            }}
            onError={() => setFailed(true)} />
          {duration !== null && <span className="agent-run-thumb__duration">{clipDuration(duration)}</span>}
        </>
      )}
    </div>
  );
}

/**
 * GM: a failed run's card gets the error icon by its message, never a red
 * edge. The glyph a node's own failure shows (a failed Cinema shot's ⚠; the
 * card's error block itself has no icon), and aria-hidden: the message
 * already says "failed" (GM - Design, 2026-10-25).
 */
export function RunOutcomeIcon({ run }: { run: AgentNoteRun | null | undefined }) {
  if (run?.outcome !== 'failure') return null;
  return <span className="agent-run-icon" aria-hidden="true">&#x26A0;</span>;
}

/**
 * A corner button that reads "Saving…" while the Commons' save in progress
 * holds the leave it asked for (commons-leave, LeaveBusyContext).
 */
export function BusyButton({ className, onClick, children, op, lock }: {
  className: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
  /** The action's kind, for the corner to find this button again (focus after a popover). */
  op?: string;
  /** Why it can't act yet (heldLock useNoteLock, components/PersonLock): aria-disabled, still
   * focusable, pointing at the line under the buttons; no tooltip (PR #204 round 10). */
  lock?: PersonLock | null;
}) {
  const [element, setElement] = useState<HTMLButtonElement | null>(null);
  const busy = useContext(LeaveBusyContext) === element && element !== null;
  const locked = Boolean(lock?.locked);
  return (
    <button ref={setElement} type="button" className={locked ? `${className} agent-notes-btn--held` : className}
      aria-busy={busy || undefined} data-op={op} {...lock?.control()} onClick={onClick}>
      {busy ? 'Saving…' : children}
    </button>
  );
}

/** The update's own buttons (edit actions first, then Show) or its greyed state. */
export function NoteButtons({
  note,
  adapter,
  onAction,
  onShow,
}: {
  note: AgentNote;
  adapter: AgentNotesAdapter;
  /** `anchor`: the clicked button, where the Commons asks before leaving. */
  onAction: (action: AgentNoteAction, anchor: HTMLElement) => void;
  onShow: (anchor: HTMLElement) => void;
}) {
  const controls = noteControls(note, { showLabel: adapter.showLabel(note), actionState: adapter.actionState });
  // GM, #204 r3 item 2: an ask this tab doesn't hold yet keeps its Review or Answer, locked.
  const lock = useNoteLock(note);
  const held = lock.locked;
  if (controls.buttons.length === 0 && !controls.state) return null;
  const holds = controls.buttons.some((button) => button.kind === 'action' && HELD_OPS.has(button.action.op.kind));
  return (
    <div className="agent-notes-acts">
      {controls.state && <span className="agent-notes-acts__state">{controls.state}</span>}
      {controls.buttons.map((button: NoteButton) => (
        <BusyButton
          key={button.kind === 'show' ? 'show' : button.label}
          className={`agent-notes-btn${button.kind === 'action' && button.primary ? ' agent-notes-btn--primary' : ''}`}
          op={button.kind === 'action' ? button.action.op.kind : undefined}
          lock={button.kind === 'action' && HELD_OPS.has(button.action.op.kind) ? lock : null}
          onClick={(event) => {
            event.stopPropagation();
            if (button.kind === 'show') onShow(event.currentTarget);
            else if (!(held && HELD_OPS.has(button.action.op.kind))) onAction(button.action, event.currentTarget);
          }}
        >
          {button.label}
        </BusyButton>
      ))}
      {holds && <PersonLockLine lock={lock} className="agent-notes-acts__held-line" />}
    </div>
  );
}
