import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Questions an agent asked the person (Q125 item 1): the store the socket
 * feeds, kept by agent for the Agents panel to come (item 2), with the
 * person's drafts kept per set until Send or Dismiss.
 */

const api = vi.hoisted(() => ({ answerQuestions: vi.fn(), dismissQuestions: vi.fn() }));
const ws = vi.hoisted(() => ({ handlers: [] as Array<(event: unknown) => void> }));

vi.mock('../src/lib/wsClient', () => ({
  wsClient: {
    subscribe: (handler: (event: unknown) => void) => { ws.handlers.push(handler); return () => {}; },
  },
}));
vi.mock('../src/lib/agentQuestions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/agentQuestions')>()),
  ...api,
}));

const { canSend, openByAgent, useAgentQuestionsStore } = await import('../src/store/agentQuestionsStore');
type View = import('../src/lib/agentQuestions').QuestionSetView;

const CLAUDE = { id: 'ext:claude-code', name: 'Claude Code', color: '#3FC1A5', verified: false };
const CODEX = { id: 'ext:codex', name: 'Codex', color: '#F2C14E', verified: false };

function view(overrides: Partial<View> = {}): View {
  return {
    id: 'qs_00000001', status: 'open', agent: CLAUDE, note: 'Picking the hero crop', projectId: 'p1',
    nodeIds: [], createdAt: 1, closedAt: null, answers: null,
    questions: [
      { id: 'q1', text: 'Which crop?', options: ['Square', 'Wide', 'Tall'], multiple: false, allowText: true },
      { id: 'q2', text: 'Moods?', options: ['Calm', 'Loud'], multiple: true, allowText: false },
      { id: 'q3', text: 'Anything to avoid?', options: [], multiple: false, allowText: true },
    ],
    ...overrides,
  };
}

function emit(event: unknown) {
  for (const handler of ws.handlers) handler(event);
}

beforeEach(() => {
  useAgentQuestionsStore.getState().reset();
  api.answerQuestions.mockReset().mockResolvedValue(undefined);
  api.dismissQuestions.mockReset().mockResolvedValue(undefined);
});

describe('agentQuestionsStore', () => {
  it('keeps open sets with their keys and closed ones with their answers, from the socket', () => {
    emit({ type: 'questionsSync', sets: [
      { ...view(), answerKey: 'k1' },
      { ...view({ id: 'qs_2', agent: { ...CODEX, color: 'red;background:url(x)' } }), answerKey: 'k2' },
      // An open set with no key can't be answered from this tab: not kept.
      { ...view({ id: 'qs_3' }) },
      { ...view({ id: 'qs_4', status: 'answered', answers: [{ questionId: 'q1', answered: true, choices: ['Wide'], text: null }] }) },
    ] });
    const { sets } = useAgentQuestionsStore.getState();
    expect(Object.keys(sets).sort()).toEqual(['qs_00000001', 'qs_2', 'qs_4']);
    expect(sets.qs_00000001.answerKey).toBe('k1');
    // The agent colour goes into CSS: only plain hex passes.
    expect(sets.qs_2.view.agent.color).toBe('#E8825A');
    expect(sets.qs_4.view.answers?.[0].choices).toEqual(['Wide']);
    expect(sets.qs_4.answerKey).toBeUndefined();
  });

  it('lists each agent\'s open sets, for "Needs you"', () => {
    emit({ type: 'questionsOpened', set: view(), answerKey: 'k1' });
    emit({ type: 'questionsOpened', set: view({ id: 'qs_2', agent: CODEX }), answerKey: 'k2' });
    emit({ type: 'questionsOpened', set: view({ id: 'qs_3' }), answerKey: 'k3' });
    emit({ type: 'questionsClosed', questionId: 'qs_3', status: 'withdrawn', agentId: CLAUDE.id,
      set: view({ id: 'qs_3', status: 'withdrawn' }) });
    const byAgent = openByAgent(useAgentQuestionsStore.getState());
    expect(byAgent[CLAUDE.id].map((v) => v.id)).toEqual(['qs_00000001']);
    expect(byAgent[CODEX.id].map((v) => v.id)).toEqual(['qs_2']);
  });

  it('picks one choice for a single question, any number for a multiple one, and keeps the typed text', () => {
    const store = useAgentQuestionsStore.getState();
    store.opened(view(), 'k1');
    expect(canSend(useAgentQuestionsStore.getState(), 'qs_00000001')).toBe(false);
    store.toggleChoice('qs_00000001', 'q1', 'Square');
    store.toggleChoice('qs_00000001', 'q1', 'Wide');
    store.toggleChoice('qs_00000001', 'q2', 'Loud');
    store.toggleChoice('qs_00000001', 'q2', 'Calm');
    store.setText('qs_00000001', 'q3', 'No orange');
    const draft = useAgentQuestionsStore.getState().drafts.qs_00000001;
    expect(draft.q1.choices).toEqual(['Wide']);
    expect(draft.q2.choices).toEqual(['Calm', 'Loud']);
    expect(draft.q3.text).toBe('No orange');
    // A second click on the picked choice unpicks it.
    store.toggleChoice('qs_00000001', 'q1', 'Wide');
    expect(useAgentQuestionsStore.getState().drafts.qs_00000001.q1.choices).toEqual([]);
    // A choice that isn't an option, or text where none is allowed, is ignored.
    store.toggleChoice('qs_00000001', 'q1', 'Round');
    store.setText('qs_00000001', 'q2', 'nope');
    expect(useAgentQuestionsStore.getState().drafts.qs_00000001.q1.choices).toEqual([]);
    expect(useAgentQuestionsStore.getState().drafts.qs_00000001.q2.text).toBe('');
    expect(canSend(useAgentQuestionsStore.getState(), 'qs_00000001')).toBe(true);
  });

  it('counts only real answers: blank text is no answer', () => {
    const store = useAgentQuestionsStore.getState();
    store.opened(view(), 'k1');
    store.setText('qs_00000001', 'q3', '   ');
    expect(canSend(useAgentQuestionsStore.getState(), 'qs_00000001')).toBe(false);
  });

  it('keeps the drafts when the form closes, until Send', async () => {
    const store = useAgentQuestionsStore.getState();
    store.opened(view(), 'k1');
    store.openForm('qs_00000001');
    store.toggleChoice('qs_00000001', 'q1', 'Tall');
    store.setText('qs_00000001', 'q3', 'No orange');
    store.closeForm();
    expect(useAgentQuestionsStore.getState().formId).toBeNull();
    expect(useAgentQuestionsStore.getState().drafts.qs_00000001.q1.choices).toEqual(['Tall']);

    await expect(useAgentQuestionsStore.getState().send('qs_00000001')).resolves.toBe(true);
    // Answered questions only; a blank one is left out (the backend marks it answered=false).
    expect(api.answerQuestions).toHaveBeenCalledWith('qs_00000001', 'k1', [
      { questionId: 'q1', choices: ['Tall'] },
      { questionId: 'q3', text: 'No orange' },
    ]);
    const state = useAgentQuestionsStore.getState();
    expect(state.drafts.qs_00000001).toBeUndefined();
    expect(state.sets.qs_00000001.view.status).toBe('answered');
    expect(state.sets.qs_00000001.view.answers).toEqual([
      { questionId: 'q1', answered: true, choices: ['Tall'], text: null },
      { questionId: 'q2', answered: false, choices: [], text: null },
      { questionId: 'q3', answered: true, choices: [], text: 'No orange' },
    ]);
  });

  it('keeps the drafts and says why when Send fails', async () => {
    api.answerQuestions.mockRejectedValueOnce(new Error('nope'));
    const store = useAgentQuestionsStore.getState();
    store.opened(view(), 'k1');
    store.setText('qs_00000001', 'q3', 'No orange');
    await expect(useAgentQuestionsStore.getState().send('qs_00000001')).resolves.toBe(false);
    const state = useAgentQuestionsStore.getState();
    expect(state.drafts.qs_00000001.q3.text).toBe('No orange');
    expect(state.errors.qs_00000001).toBeTruthy();
    expect(state.sets.qs_00000001.view.status).toBe('open');
  });

  it('never sends with nothing answered, and dismisses with no answers', async () => {
    const store = useAgentQuestionsStore.getState();
    store.opened(view(), 'k1');
    await expect(store.send('qs_00000001')).resolves.toBe(false);
    expect(api.answerQuestions).not.toHaveBeenCalled();
    store.setText('qs_00000001', 'q3', 'draft');
    await expect(useAgentQuestionsStore.getState().dismiss('qs_00000001')).resolves.toBe(true);
    expect(api.dismissQuestions).toHaveBeenCalledWith('qs_00000001', 'k1');
    const state = useAgentQuestionsStore.getState();
    expect(state.sets.qs_00000001.view.status).toBe('dismissed');
    expect(state.drafts.qs_00000001).toBeUndefined();
  });

  it('keeps an open set, its draft and the open form across a backend restart, with the new key', async () => {
    // Sets are kept with the project now: a restarted Nebula still has this
    // one (same id) and sends it again after hello, under a new key.
    emit({ type: 'questionsOpened', set: view(), answerKey: 'k1' });
    const store = useAgentQuestionsStore.getState();
    store.openForm('qs_00000001');
    store.toggleChoice('qs_00000001', 'q1', 'Wide');
    store.setText('qs_00000001', 'q3', 'No orange');
    emit({ type: 'socketReconnected' });
    emit({ type: 'questionsSync', sets: [{ ...view(), answerKey: 'k2' }] });
    let state = useAgentQuestionsStore.getState();
    expect(state.sets.qs_00000001.answerKey).toBe('k2');
    expect(state.sets.qs_00000001.view.status).toBe('open');
    expect(state.formId).toBe('qs_00000001');
    expect(state.drafts.qs_00000001.q1.choices).toEqual(['Wide']);
    expect(state.drafts.qs_00000001.q3.text).toBe('No orange');
    await expect(useAgentQuestionsStore.getState().send('qs_00000001')).resolves.toBe(true);
    expect(api.answerQuestions).toHaveBeenCalledWith('qs_00000001', 'k2', [
      { questionId: 'q1', choices: ['Wide'] },
      { questionId: 'q3', text: 'No orange' },
    ]);
    state = useAgentQuestionsStore.getState();
    expect(state.sets.qs_00000001.view.status).toBe('answered');
  });

  it('keeps the draft when Send fails on the old key before the resync lands', async () => {
    api.answerQuestions.mockRejectedValueOnce(new Error('These questions can only be answered from the Nebula canvas.'));
    emit({ type: 'questionsOpened', set: view(), answerKey: 'k1' });
    useAgentQuestionsStore.getState().setText('qs_00000001', 'q3', 'No orange');
    await expect(useAgentQuestionsStore.getState().send('qs_00000001')).resolves.toBe(false);
    emit({ type: 'questionsSync', sets: [{ ...view(), answerKey: 'k2' }] });
    const state = useAgentQuestionsStore.getState();
    expect(state.drafts.qs_00000001.q3.text).toBe('No orange');
    expect(state.sets.qs_00000001.answerKey).toBe('k2');
    await expect(useAgentQuestionsStore.getState().send('qs_00000001')).resolves.toBe(true);
    expect(api.answerQuestions).toHaveBeenLastCalledWith('qs_00000001', 'k2', [{ questionId: 'q3', text: 'No orange' }]);
  });

  it('drops the draft and closes the form when the set closes elsewhere', () => {
    const store = useAgentQuestionsStore.getState();
    store.opened(view(), 'k1');
    store.openForm('qs_00000001');
    store.setText('qs_00000001', 'q3', 'draft');
    emit({ type: 'questionsClosed', questionId: 'qs_00000001', status: 'withdrawn', agentId: CLAUDE.id,
      set: view({ status: 'withdrawn' }) });
    const state = useAgentQuestionsStore.getState();
    expect(state.sets.qs_00000001.view.status).toBe('withdrawn');
    expect(state.sets.qs_00000001.answerKey).toBeUndefined();
    expect(state.drafts.qs_00000001).toBeUndefined();
    expect(state.formId).toBeNull();
  });
});
