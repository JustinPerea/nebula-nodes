import { type CSSProperties, type Ref } from 'react';
import { X } from 'lucide-react';
import type { AgentNote, AgentNoteAction } from '../../lib/agentNotes';
import { noteLabel, noteText } from '../../lib/agentNotesView';
import { AuthorDot, NoteButtons, type AgentNotesAdapter } from './AgentNoteParts';

interface HoldHandlers {
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * One update, dropped from the chip into the corner for about 4 s (GM's
 * mockup v5.2). Hover or focus holds it. A click on it, or on one of its
 * actions, reads it; × dismisses it; leaving by itself leaves it unread.
 */
export function AgentNoteCard({
  note,
  adapter,
  leaving,
  cardRef,
  hold,
  onRead,
  onDismiss,
  onAction,
  onShow,
}: {
  note: AgentNote;
  adapter: AgentNotesAdapter;
  leaving: boolean;
  cardRef: Ref<HTMLDivElement>;
  hold: HoldHandlers;
  onRead: () => void;
  onDismiss: () => void;
  onAction: (action: AgentNoteAction) => void;
  onShow: () => void;
}) {
  const label = noteLabel(note);
  return (
    <div
      ref={cardRef}
      className="agent-note-card"
      data-kind={note.author.kind}
      data-leaving={leaving ? 'true' : undefined}
      role="status"
      aria-label={`Update from ${note.author.name}`}
      style={{ '--an-author': note.author.color } as CSSProperties}
      {...hold}
    >
      <div className="agent-note-card__who">
        <AuthorDot author={note.author} />
        <span className="agent-note-card__name">{note.author.name}</span>
        {label && <span className="agent-note-card__label">{label}</span>}
        <button
          type="button"
          className="agent-note-card__close"
          aria-label="Dismiss this update"
          title="Dismiss (it stays in Updates)"
          onClick={(event) => {
            event.stopPropagation();
            onDismiss();
          }}
        >
          <X size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
        </button>
      </div>
      <p className="agent-note-card__text" onClick={() => { onRead(); if (note.refs.length > 0) onShow(); }}>
        {noteText(note)}
      </p>
      <NoteButtons
        note={note}
        adapter={adapter}
        onAction={(action) => { onRead(); onAction(action); }}
        onShow={() => { onRead(); onShow(); }}
      />
    </div>
  );
}

/** Four or more at once: one card that opens the list. */
export function AgentNotesSummaryCard({
  count,
  color,
  leaving,
  cardRef,
  hold,
  onOpen,
  onClose,
}: {
  count: number;
  color: string;
  leaving: boolean;
  cardRef: Ref<HTMLDivElement>;
  hold: HoldHandlers;
  onOpen: () => void;
  onClose: () => void;
}) {
  const label = `${count} new updates`;
  return (
    <div
      ref={cardRef}
      className="agent-note-card agent-note-card--summary"
      data-leaving={leaving ? 'true' : undefined}
      role="status"
      aria-label={label}
      style={{ '--an-author': color } as CSSProperties}
      {...hold}
    >
      <button type="button" className="agent-note-card__summary" onClick={onOpen}>
        {label}
      </button>
      <button type="button" className="agent-note-card__close" aria-label="Close" onClick={onClose}>
        <X size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
      </button>
    </div>
  );
}
