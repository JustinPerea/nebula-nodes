import type { QuestionSetView } from '../../lib/agentQuestions';

/**
 * An answered set's closed view, under its Update in the list: each
 * question with what the person answered, or "No answer." for one they
 * skipped (Q125 item 1, GM's copy). A set closed any other way shows
 * nothing here; its Update's outcome line says how it ended.
 */
export function AgentQuestionsAnswers({ view }: { view: QuestionSetView }) {
  if (view.status !== 'answered' || !view.answers) return null;
  return (
    <ul className="agent-questions-answers" aria-label="Your answers">
      {view.questions.map((question) => {
        const answer = view.answers?.find((a) => a.questionId === question.id);
        const parts = answer?.answered ? [answer.choices.join(', '), answer.text ?? ''].filter(Boolean) : [];
        return (
          <li key={question.id} className="agent-questions-answers__row">
            <span className="agent-questions-answers__question">{question.text}</span>
            {parts.length > 0 ? (
              <span className="agent-questions-answers__answer">
                {parts.map((part, index) => (
                  <span key={index} className="agent-questions-answers__part">{part}</span>
                ))}
              </span>
            ) : (
              <span className="agent-questions-answers__answer" data-blank="true">No answer.</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
