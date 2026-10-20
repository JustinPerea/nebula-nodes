import { type CSSProperties, type KeyboardEvent, type Ref } from 'react';
import type { AgentNote, AgentNoteAction } from '../../lib/agentNotes';
import { aboutLabel, clockTime, noteText, offersNotNow } from '../../lib/agentNotesView';
import { ScrollFade } from '../ScrollFade';
import { AuthorDot, NoteButtons, type AgentNotesAdapter } from './AgentNoteParts';

/**
 * The opened Updates list, as GM's still draws it (stills/updates-open.png):
 * a header with the count, the read state and where the list is kept; every
 * update newest first with its author's stripe, dot, name, label and clock
 * time; each update's own buttons; and a footer that explains Not now and
 * links to the Agent log.
 */
export function AgentNotesList({
  listRef,
  notes,
  newCount,
  now,
  adapter,
  onClose,
  onSeeAll,
  onAction,
  onShow,
  onHover,
  error,
}: {
  listRef: Ref<HTMLDivElement>;
  notes: AgentNote[];
  /** Updates that arrived while this list was open ("· 1 new"). */
  newCount: number;
  now: number;
  adapter: AgentNotesAdapter;
  onClose: (returnFocus: boolean) => void;
  /** "See all actions →": null while the Agent log is switched off. */
  onSeeAll: (() => void) | null;
  onAction: (note: AgentNote, action: AgentNoteAction) => void;
  onShow: (note: AgentNote) => void;
  onHover: (note: AgentNote | null) => void;
  /** The last thing that failed (a dismiss the server refused), if any. */
  error: string | null;
}) {
  const today = new Date(now);
  const state = newCount > 0 ? `${newCount} new` : 'all read';
  const notNow = notes.some(offersNotNow);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose(true);
    }
  }

  function rowKeyDown(event: KeyboardEvent<HTMLLIElement>, note: AgentNote) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onShow(note);
    }
  }

  return (
    <div
      ref={listRef}
      className="agent-notes-panel"
      role="dialog"
      aria-label="Updates"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
    >
      <div className="agent-notes-panel__head">
        <span className="agent-notes-panel__title">Updates</span>
        <span className="agent-notes-panel__count">{`${notes.length} · ${state}`}</span>
        <span className="agent-notes-panel__kept">{adapter.keptWith}</span>
      </div>
      {notes.length === 0 ? (
        <div className="agent-notes-panel__empty">
          <span className="agent-notes-panel__empty-title">No updates yet</span>
          <span className="agent-notes-panel__empty-hint">What an agent notices lands here, not at its cursor.</span>
        </div>
      ) : (
        <ScrollFade as="ul" className="agent-notes-panel__list">
          {notes.map((note) => {
            const label = aboutLabel(note.about);
            const showable = note.refs.length > 0;
            const done = Boolean(note.dismissedAt || note.actedAt);
            return (
              <li
                key={note.id}
                className="agent-notes-entry"
                data-kind={note.author.kind}
                data-state={done ? 'done' : undefined}
                data-showable={showable ? 'true' : undefined}
                style={{ '--an-author': note.author.color } as CSSProperties}
                tabIndex={showable ? 0 : undefined}
                onMouseEnter={() => onHover(note)}
                onMouseLeave={() => onHover(null)}
                onFocus={(event) => { if (event.target === event.currentTarget) onHover(note); }}
                onBlur={(event) => { if (event.target === event.currentTarget) onHover(null); }}
                onClick={() => { if (showable) onShow(note); }}
                onKeyDown={(event) => rowKeyDown(event, note)}
              >
                <div className="agent-notes-entry__who">
                  <AuthorDot author={note.author} />
                  <span className="agent-notes-entry__name">{note.author.name}</span>
                  {label && <span className="agent-notes-entry__label">{label}</span>}
                  <time className="agent-notes-entry__time" dateTime={note.at}>{clockTime(note.at, today)}</time>
                </div>
                <p className="agent-notes-entry__text">{noteText(note)}</p>
                <NoteButtons
                  note={note}
                  adapter={adapter}
                  onAction={(action) => onAction(note, action)}
                  onShow={() => onShow(note)}
                />
              </li>
            );
          })}
        </ScrollFade>
      )}
      {error && <div className="agent-notes-panel__error" role="alert">{error}</div>}
      <div className="agent-notes-panel__foot">
        <span className="agent-notes-panel__foot-note">{notNow ? 'Not now hides a suggestion for good' : ''}</span>
        {onSeeAll && (
          <button type="button" className="agent-notes-panel__see-all" onClick={onSeeAll}>
            See all actions →
          </button>
        )}
      </div>
    </div>
  );
}
