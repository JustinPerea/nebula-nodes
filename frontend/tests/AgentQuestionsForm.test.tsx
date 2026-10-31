import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * The answer form (Q125 item 1) and the closed view, in GM - Design's
 * copy, verbatim: "A question from {agent}" / "Questions from {agent}",
 * "You can skip any question." under 2+, "Pick any that apply." under a
 * multi-choice question, "Type your answer." / "Other" + "Type your own
 * answer.", Send / Dismiss, and "No answer." for a blank one.
 */

vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {}, subscribeFirst: () => () => {}, connect: () => {}, send: () => {} } }));
const api = vi.hoisted(() => ({ answerQuestions: vi.fn(), dismissQuestions: vi.fn() }));
vi.mock('../src/lib/agentQuestions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentQuestions')>()),
  ...api,
}));

const { AgentQuestionsForm } = await import('../src/components/agent-notes/AgentQuestionsForm');
const { AgentQuestionsAnswers } = await import('../src/components/agent-notes/AgentQuestionsAnswers');
const { useAgentQuestionsStore } = await import('../src/store/agentQuestionsStore');
type View = import('../src/lib/agentQuestions').QuestionSetView;

const CLAUDE = { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false };

function view(overrides: Partial<View> = {}): View {
  return {
    id: 'qs_1', status: 'open', agent: CLAUDE, note: 'Picking the hero crop', projectId: 'p1', nodeIds: [],
    createdAt: 1, closedAt: null, answers: null,
    questions: [
      { id: 'q1', text: 'Which crop?', options: ['Square', 'Wide'], multiple: false, allowText: true },
      { id: 'q2', text: 'Moods?', options: ['Calm', 'Loud'], multiple: true, allowText: false },
      { id: 'q3', text: 'Anything to avoid?', options: [], multiple: false, allowText: true },
    ],
    ...overrides,
  };
}

function open(v: View = view()) {
  act(() => {
    useAgentQuestionsStore.getState().opened(v, 'k1');
    useAgentQuestionsStore.getState().openForm(v.id);
  });
}

beforeEach(() => {
  useAgentQuestionsStore.getState().reset();
  api.answerQuestions.mockReset().mockResolvedValue(undefined);
  api.dismissQuestions.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('the answer form', () => {
  it('heads several questions with GM\'s words and says any can be skipped', () => {
    open();
    render(<AgentQuestionsForm setId="qs_1" onClose={() => {}} />);
    const form = screen.getByRole('dialog', { name: 'Questions from Claude Code' });
    expect(within(form).getByText('You can skip any question.')).toBeTruthy();
    expect(within(form).getByText('Picking the hero crop')).toBeTruthy();
    // The multi-choice question has the hint; the single-choice one doesn't.
    const groups = within(form).getAllByRole('group');
    expect(groups).toHaveLength(3);
    expect(within(groups[0]).queryByText('Pick any that apply.')).toBeNull();
    expect(within(groups[1]).getByText('Pick any that apply.')).toBeTruthy();
    // Free text next to options: "Other"; with no options: its own placeholder; none when not allowed.
    expect(within(groups[0]).getByLabelText('Other').getAttribute('placeholder')).toBe('Type your own answer.');
    expect(within(groups[1]).queryByRole('textbox')).toBeNull();
    expect(within(groups[2]).getByRole('textbox').getAttribute('placeholder')).toBe('Type your answer.');
  });

  it('heads one question in the singular, with no skip line', () => {
    open(view({ questions: [{ id: 'q1', text: 'Square or wide?', options: ['Square', 'Wide'], multiple: false, allowText: true }] }));
    render(<AgentQuestionsForm setId="qs_1" onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'A question from Claude Code' })).toBeTruthy();
    expect(screen.queryByText('You can skip any question.')).toBeNull();
  });

  it('sends only once something is answered, picking one or any as each question allows', async () => {
    open();
    const onClose = vi.fn();
    render(<AgentQuestionsForm setId="qs_1" onClose={onClose} />);
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    const square = screen.getByRole('button', { name: 'Square' });
    const wide = screen.getByRole('button', { name: 'Wide' });
    fireEvent.click(square);
    expect(square.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(wide);
    expect(square.getAttribute('aria-pressed')).toBe('false');
    expect(wide.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Calm' }));
    fireEvent.click(screen.getByRole('button', { name: 'Loud' }));
    expect(screen.getByRole('button', { name: 'Calm' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Loud' }).getAttribute('aria-pressed')).toBe('true');
    expect(send.disabled).toBe(false);
    await act(async () => { fireEvent.click(send); });
    expect(api.answerQuestions).toHaveBeenCalledWith('qs_1', 'k1', [
      { questionId: 'q1', choices: ['Wide'] },
      { questionId: 'q2', choices: ['Calm', 'Loud'] },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('sends a typed answer alone, and Ctrl+Enter in the text sends too', async () => {
    open();
    render(<AgentQuestionsForm setId="qs_1" onClose={() => {}} />);
    const text = screen.getByPlaceholderText('Type your answer.');
    fireEvent.change(text, { target: { value: 'No orange' } });
    await act(async () => { fireEvent.keyDown(text, { key: 'Enter', ctrlKey: true }); });
    expect(api.answerQuestions).toHaveBeenCalledWith('qs_1', 'k1', [{ questionId: 'q3', text: 'No orange' }]);
  });

  it('dismisses with nothing filled in, and Escape only closes', async () => {
    open();
    const onClose = vi.fn();
    render(<AgentQuestionsForm setId="qs_1" onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(api.dismissQuestions).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Dismiss' })); });
    expect(api.dismissQuestions).toHaveBeenCalledWith('qs_1', 'k1');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('keeps what the person typed when it closes and opens again', () => {
    open();
    const first = render(<AgentQuestionsForm setId="qs_1" onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Type your answer.'), { target: { value: 'No orange' } });
    fireEvent.click(screen.getByRole('button', { name: 'Square' }));
    first.unmount();
    render(<AgentQuestionsForm setId="qs_1" onClose={() => {}} />);
    expect((screen.getByPlaceholderText('Type your answer.') as HTMLTextAreaElement).value).toBe('No orange');
    expect(screen.getByRole('button', { name: 'Square' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('takes focus on its first control', () => {
    open();
    render(<AgentQuestionsForm setId="qs_1" onClose={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Square' }));
  });
});

describe('the closed view', () => {
  it('shows each question with its answer, or "No answer."', () => {
    const answered = view({ status: 'answered', answers: [
      { questionId: 'q1', answered: true, choices: ['Wide'], text: 'but tighter' },
      { questionId: 'q2', answered: false, choices: [], text: null },
      { questionId: 'q3', answered: true, choices: [], text: 'No orange' },
    ] });
    render(<AgentQuestionsAnswers view={answered} />);
    const rows = screen.getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('Which crop?');
    expect(rows[0].textContent).toContain('Wide');
    expect(rows[0].textContent).toContain('but tighter');
    expect(rows[1].textContent).toContain('Moods?');
    expect(rows[1].textContent).toContain('No answer.');
    expect(rows[2].textContent).toContain('No orange');
  });

  it('shows nothing for a set closed without answers', () => {
    const { container } = render(<AgentQuestionsAnswers view={view({ status: 'dismissed' })} />);
    expect(container.textContent).toBe('');
  });
});
