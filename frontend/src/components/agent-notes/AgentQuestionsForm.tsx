import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent, type Ref } from 'react';
import type { AgentQuestion } from '../../lib/agentQuestions';
import { canSend, useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { AuthorDot } from './AgentNoteParts';

/**
 * The answer form (Q125 item 1): a popover from the Updates corner, at the
 * list's width, opened by an Update's Answer. GM's copy, verbatim. Each
 * question is its own group; options are toggle buttons (one, or any for a
 * multiple question); a typed answer sits beside them as "Other", or alone.
 * Send is on once one question has an answer. Escape closes without
 * dismissing: what the person typed stays (the store's draft) until Send
 * or Dismiss. Deferred: the corner loads it the first time it opens.
 */
export function AgentQuestionsForm({
  setId,
  onClose,
  formRef,
}: {
  setId: string;
  /** Close the popover (after Send or Dismiss too); the corner returns focus. */
  onClose: () => void;
  formRef?: Ref<HTMLDivElement>;
}) {
  const entry = useAgentQuestionsStore((s) => s.sets[setId]);
  const drafts = useAgentQuestionsStore((s) => s.drafts[setId]);
  const error = useAgentQuestionsStore((s) => s.errors[setId] ?? null);
  const busy = useAgentQuestionsStore((s) => Boolean(s.busy[setId]));
  const sendable = useAgentQuestionsStore((s) => canSend(s, setId));
  const toggleChoice = useAgentQuestionsStore((s) => s.toggleChoice);
  const setText = useAgentQuestionsStore((s) => s.setText);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const headingId = useId();

  // Focus starts on the first control, so Tab walks the questions in order.
  useEffect(() => {
    bodyRef.current?.querySelector<HTMLElement>('button, textarea')?.focus({ preventScroll: true });
  }, []);

  if (!entry || entry.view.status !== 'open') return null;
  const { view } = entry;
  const many = view.questions.length > 1;
  const heading = many ? `Questions from ${view.agent.name}` : `A question from ${view.agent.name}`;

  async function send() {
    if (!sendable || busy) return;
    if (await useAgentQuestionsStore.getState().send(setId)) onClose();
  }

  async function dismiss() {
    if (busy) return;
    if (await useAgentQuestionsStore.getState().dismiss(setId)) onClose();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      // Only the popover closes: the list under it stays, and nothing is dismissed.
      event.stopPropagation();
      onClose();
    }
  }

  function question(q: AgentQuestion) {
    const draft = drafts?.[q.id];
    const legendId = `${headingId}-${q.id}`;
    const textId = `${headingId}-${q.id}-text`;
    return (
      // A div, not a fieldset: a legend sits on the fieldset's border, outside its padding.
      <div key={q.id} role="group" className="agent-questions-form__question" aria-labelledby={legendId}>
        <p id={legendId} className="agent-questions-form__text">{q.text}</p>
        {q.multiple && <p className="agent-questions-form__hint">Pick any that apply.</p>}
        {q.options.length > 0 && (
          <div className="agent-questions-form__options">
            {q.options.map((option) => {
              const picked = Boolean(draft?.choices.includes(option));
              return (
                <button
                  key={option}
                  type="button"
                  className="agent-questions-form__option"
                  aria-pressed={picked}
                  disabled={busy}
                  onClick={() => toggleChoice(setId, q.id, option)}
                >
                  {option}
                </button>
              );
            })}
          </div>
        )}
        {q.allowText && (
          <div className="agent-questions-form__typed">
            {q.options.length > 0 && <label htmlFor={textId} className="agent-questions-form__other">Other</label>}
            <textarea
              id={textId}
              className="agent-questions-form__input"
              rows={q.options.length > 0 ? 1 : 2}
              maxLength={1000}
              placeholder={q.options.length > 0 ? 'Type your own answer.' : 'Type your answer.'}
              aria-labelledby={q.options.length > 0 ? undefined : legendId}
              value={draft?.text ?? ''}
              disabled={busy}
              onChange={(event) => setText(setId, q.id, event.target.value)}
              onKeyDown={(event) => {
                // Enter types a new line; Ctrl or Cmd with it sends.
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={formRef}
      className="agent-notes-panel agent-questions-form"
      role="dialog"
      aria-labelledby={headingId}
      style={{ '--an-author': view.agent.color } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <div className="agent-questions-form__head">
        <AuthorDot author={{ kind: 'agent', name: view.agent.name, color: view.agent.color }} />
        <div className="agent-questions-form__titles">
          <h2 id={headingId} className="agent-questions-form__heading">{heading}</h2>
          {many && <p className="agent-questions-form__skip">You can skip any question.</p>}
        </div>
      </div>
      <div ref={bodyRef} className="agent-questions-form__body">
        {view.note && <p className="agent-questions-form__note">{view.note}</p>}
        {view.questions.map(question)}
      </div>
      {error && <div className="agent-notes-panel__error" role="alert">{error}</div>}
      <div className="agent-questions-form__foot">
        <button type="button" className="agent-notes-btn" disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </button>
        <button
          type="button"
          className="agent-notes-btn agent-notes-btn--primary"
          disabled={!sendable || busy}
          aria-busy={busy || undefined}
          onClick={() => void send()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
