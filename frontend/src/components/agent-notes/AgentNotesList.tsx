import { type CSSProperties, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import type { AgentNote, AgentNoteAction } from '../../lib/agentNotes';
import { clockTime, noteDone, noteLabel, noteText, offersNotNow, questionSetId } from '../../lib/agentNotesView';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { AgentQuestionsAnswers } from './AgentQuestionsAnswers';
import { ScrollFade } from '../ScrollFade';
import { AuthorDot, BusyButton, NoteButtons, type AgentNotesAdapter } from './AgentNoteParts';

/** One list in the opened Updates: its updates (newest first) and how to draw and run them. */
export interface AgentNotesListSection {
  /** Stable id ("board", "project"). */
  id: string;
  /** Its heading when the list has more than one ("This board"). */
  title: string;
  notes: AgentNote[];
  adapter: AgentNotesAdapter;
}

/**
 * The opened Updates list, as GM's still draws it (stills/updates-open.png):
 * a header with the count, the read state and where the list is kept; every
 * update newest first with its author's stripe, dot, name, label and clock
 * time; each update's own buttons; and a footer that explains Not now and
 * links to the Agent log.
 *
 * In Moodboard Studio with the board's own Updates (Justin's Q113 c) it is
 * two sections in one list, "This board" first, then the project's: the
 * header keeps the count of both and the read state, and each section's
 * heading says where it is kept. With one section it is exactly the list
 * every other screen shows.
 */
export function AgentNotesList({
  listRef,
  sections,
  newCount,
  now,
  onClose,
  onSeeAll,
  onAction,
  onShow,
  onHover,
  error,
  top,
}: {
  listRef: Ref<HTMLDivElement>;
  sections: AgentNotesListSection[];
  /** Updates that arrived while this list was open ("· 1 new"). */
  newCount: number;
  now: number;
  onClose: (returnFocus: boolean) => void;
  /** "See all actions →": null while the Agent log is switched off. */
  /** `anchor`: what was clicked, where the Commons asks before leaving (commons-leave). */
  onSeeAll: ((anchor: HTMLElement) => void) | null;
  onAction: (note: AgentNote, action: AgentNoteAction, anchor?: HTMLElement) => void;
  onShow: (note: AgentNote, anchor?: HTMLElement) => void;
  onHover: (note: AgentNote | null) => void;
  /** The last thing that failed (a dismiss the server refused), if any. */
  error: string | null;
  /** What sits above the updates, under the header: the Agents panel (Q125 item 2). */
  top?: ReactNode;
}) {
  const today = new Date(now);
  const state = newCount > 0 ? `${newCount} new` : 'all read';
  const total = sections.reduce((sum, section) => sum + section.notes.length, 0);
  const notNow = sections.some((section) => section.notes.some(offersNotNow));
  const single = sections.length === 1 ? sections[0] : null;

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
      onShow(note, event.currentTarget);
    }
  }

  function entry(note: AgentNote, adapter: AgentNotesAdapter) {
    const label = noteLabel(note);
    const showable = note.refs.length > 0;
    const done = noteDone(note);
    return (
      <li
        key={note.id}
        data-note-id={note.id}
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
        onClick={(event) => { if (showable) onShow(note, event.currentTarget); }}
        onKeyDown={(event) => rowKeyDown(event, note)}
      >
        <div className="agent-notes-entry__who">
          <AuthorDot author={note.author} />
          <span className="agent-notes-entry__name">{note.author.name}</span>
          {label && <span className="agent-notes-entry__label">{label}</span>}
          <time className="agent-notes-entry__time" dateTime={note.at}>{clockTime(note.at, today)}</time>
        </div>
        <p className="agent-notes-entry__text">{noteText(note, adapter.numberFor)}</p>
        <QuestionAnswersFor note={note} />
        <NoteButtons
          note={note}
          adapter={adapter}
          onAction={(action, anchor) => onAction(note, action, anchor)}
          onShow={(anchor) => onShow(note, anchor)}
        />
      </li>
    );
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
        <span className="agent-notes-panel__count">{`${total} · ${state}`}</span>
        {single && <span className="agent-notes-panel__kept">{single.adapter.keptWith}</span>}
      </div>
      {top}
      {single ? (
        single.notes.length === 0 ? (
          <div className="agent-notes-panel__empty">
            <span className="agent-notes-panel__empty-title">No updates yet</span>
            <span className="agent-notes-panel__empty-hint">What an agent notices lands here, not at its cursor.</span>
          </div>
        ) : (
          <ScrollFade as="ul" className="agent-notes-panel__list">
            {single.notes.map((note) => entry(note, single.adapter))}
          </ScrollFade>
        )
      ) : (
        <ScrollFade className="agent-notes-panel__list agent-notes-panel__list--sections">
          {sections.map((section) => (
            <section key={section.id} className="agent-notes-section" aria-label={section.title}>
              <div className="agent-notes-section__head">
                <span className="agent-notes-section__title">{section.title}</span>
                <span className="agent-notes-section__count">{section.notes.length}</span>
                <span className="agent-notes-section__kept">{section.adapter.keptWith}</span>
              </div>
              {section.notes.length === 0 ? (
                <p className="agent-notes-section__empty">No updates yet</p>
              ) : (
                <ul className="agent-notes-section__list">
                  {section.notes.map((note) => entry(note, section.adapter))}
                </ul>
              )}
            </section>
          ))}
        </ScrollFade>
      )}
      {error && <div className="agent-notes-panel__error" role="alert">{error}</div>}
      <div className="agent-notes-panel__foot">
        <span className="agent-notes-panel__foot-note">{notNow ? 'Not now hides a suggestion for good' : ''}</span>
        {onSeeAll && (
          <BusyButton className="agent-notes-panel__see-all" onClick={(event) => onSeeAll(event.currentTarget)}>
            See all actions →
          </BusyButton>
        )}
      </div>
    </div>
  );
}

/** Under a question set's Update, once answered: each question and its answer. */
function QuestionAnswersFor({ note }: { note: AgentNote }) {
  const setId = questionSetId(note);
  const view = useAgentQuestionsStore((s) => (setId ? s.sets[setId]?.view : undefined));
  return view ? <AgentQuestionsAnswers view={view} /> : null;
}
