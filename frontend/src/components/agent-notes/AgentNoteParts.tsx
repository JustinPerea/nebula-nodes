import type { CSSProperties } from 'react';
import type { AgentNote, AgentNoteAction, AgentNoteAuthor } from '../../lib/agentNotes';
import { authorInitials, noteControls, type NoteButton } from '../../lib/agentNotesView';

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
}

export function AuthorDot({
  author,
  lit,
}: {
  author: Pick<AgentNoteAuthor, 'kind' | 'name' | 'color'>;
  /** The chip's dots brighten while their author has unread updates. */
  lit?: boolean;
}) {
  return (
    <span
      className={`agent-notes-dot agent-notes-dot--${author.kind}`}
      data-lit={lit === undefined ? undefined : String(lit)}
      style={{ '--an-dot': author.color } as CSSProperties}
      aria-hidden="true"
    >
      {authorInitials(author)}
    </span>
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
  onAction: (action: AgentNoteAction) => void;
  onShow: () => void;
}) {
  const controls = noteControls(note, { showLabel: adapter.showLabel(note), actionState: adapter.actionState });
  if (controls.buttons.length === 0 && !controls.state) return null;
  return (
    <div className="agent-notes-acts">
      {controls.state && <span className="agent-notes-acts__state">{controls.state}</span>}
      {controls.buttons.map((button: NoteButton) => (
        <button
          key={button.kind === 'show' ? 'show' : button.label}
          type="button"
          className={`agent-notes-btn${button.kind === 'action' && button.primary ? ' agent-notes-btn--primary' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            if (button.kind === 'show') onShow();
            else onAction(button.action);
          }}
        >
          {button.label}
        </button>
      ))}
    </div>
  );
}
