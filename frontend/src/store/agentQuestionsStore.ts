import { create } from 'zustand';
import { wsClient } from '../lib/wsClient';
import {
  answerQuestions,
  dismissQuestions,
  sanitizeQuestionSet,
  type QuestionAnswer,
  type QuestionAnswerInput,
  type QuestionSetStatus,
  type QuestionSetView,
} from '../lib/agentQuestions';
import { failureMessage } from '../lib/errorCopy';
import { clearLineOnPromote } from '../lib/clearsOnPromote';
import { personUnconfirmed } from '../lib/personSession';

/**
 * Questions agents asked the person (Q125 item 1), from the socket:
 * `questionsSync` after hello, `questionsOpened`, `questionsClosed`. Kept by
 * set id; `openByAgent` reads them by agent for the Agents panel to come
 * (Q125 item 2: an agent's state as the person sees it). Imported at startup
 * (App.tsx) so no question is missed before the Updates corner's chunk lands.
 *
 * The person's answers are drafts kept per set until Send or Dismiss, so a
 * closed popover loses nothing; not across a reload. Sets are kept with the
 * project on the backend, so a backend restart keeps them: the resync after
 * the socket reconnects brings the same set under a new key, and `synced`
 * keeps its draft and an open form.
 */

export interface QuestionSetEntry {
  view: QuestionSetView;
  /** This tab's key to answer it: only on an open set, only on the person's socket. */
  answerKey?: string;
}

export interface QuestionDraft {
  choices: string[];
  text: string;
}

export type SetDraft = Record<string, QuestionDraft>;

interface AgentQuestionsState {
  sets: Record<string, QuestionSetEntry>;
  drafts: Record<string, SetDraft>;
  /** Why the last Send or Dismiss of a set failed. */
  errors: Record<string, string>;
  /** The set whose form is open, or null. */
  formId: string | null;
  /** Sends in flight. */
  busy: Record<string, boolean>;
  opened: (view: QuestionSetView, answerKey: string) => void;
  closed: (setId: string, status: Exclude<QuestionSetStatus, 'open'>, view: QuestionSetView | null) => void;
  synced: (entries: QuestionSetEntry[]) => void;
  openForm: (setId: string) => void;
  closeForm: () => void;
  toggleChoice: (setId: string, questionId: string, option: string) => void;
  setText: (setId: string, questionId: string, text: string) => void;
  send: (setId: string) => Promise<boolean>;
  dismiss: (setId: string) => Promise<boolean>;
  reset: () => void;
}

function initialState() {
  return {
    sets: {} as Record<string, QuestionSetEntry>,
    drafts: {} as Record<string, SetDraft>,
    errors: {} as Record<string, string>,
    formId: null as string | null,
    busy: {} as Record<string, boolean>,
  };
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

function emptyDraft(view: QuestionSetView): SetDraft {
  return Object.fromEntries(view.questions.map((q) => [q.id, { choices: [], text: '' }]));
}

function answerable(entry: QuestionSetEntry | undefined): entry is QuestionSetEntry & { answerKey: string } {
  return Boolean(entry && entry.view.status === 'open' && entry.answerKey);
}

/** The draft as Send posts it: answered questions only, in the order asked. */
function answerInputs(view: QuestionSetView, draft: SetDraft | undefined): QuestionAnswerInput[] {
  const inputs: QuestionAnswerInput[] = [];
  for (const question of view.questions) {
    const answer = draft?.[question.id];
    if (!answer) continue;
    const choices = question.options.filter((option) => answer.choices.includes(option));
    const text = question.allowText ? answer.text.trim() : '';
    if (choices.length > 0) inputs.push(text ? { questionId: question.id, choices, text } : { questionId: question.id, choices });
    else if (text) inputs.push({ questionId: question.id, text });
  }
  return inputs;
}

/** What the closed view shows until the socket's copy lands: every question, blank ones unanswered. */
function localAnswers(view: QuestionSetView, inputs: QuestionAnswerInput[]): QuestionAnswer[] {
  return view.questions.map((question) => {
    const input = inputs.find((i) => i.questionId === question.id);
    const choices = input && 'choices' in input ? input.choices : [];
    const text = input?.text ? input.text : null;
    return { questionId: question.id, answered: Boolean(input), choices, text };
  });
}

export const useAgentQuestionsStore = create<AgentQuestionsState>((set, get) => {
  function editDraft(setId: string, questionId: string, edit: (draft: QuestionDraft) => QuestionDraft | null) {
    const entry = get().sets[setId];
    if (!answerable(entry)) return;
    const question = entry.view.questions.find((q) => q.id === questionId);
    if (!question) return;
    set((state) => {
      const current = state.drafts[setId] ?? emptyDraft(entry.view);
      const next = edit(current[questionId] ?? { choices: [], text: '' });
      if (!next) return {};
      return { drafts: { ...state.drafts, [setId]: { ...current, [questionId]: next } } };
    });
  }

  function settle(setId: string, status: Exclude<QuestionSetStatus, 'open'>, answers: QuestionAnswer[] | null) {
    set((state) => {
      const entry = state.sets[setId];
      if (!entry) return {};
      const view: QuestionSetView = { ...entry.view, status, answers, closedAt: Date.now() };
      return {
        sets: { ...state.sets, [setId]: { view } },
        drafts: without(state.drafts, setId),
        errors: without(state.errors, setId),
        formId: state.formId === setId ? null : state.formId,
      };
    });
  }

  return {
    ...initialState(),

    opened: (view, answerKey) => set((state) => ({
      sets: { ...state.sets, [view.id]: { view, answerKey } },
    })),

    closed: (setId, status, view) => set((state) => {
      const entry = state.sets[setId];
      const next = view ?? (entry ? { ...entry.view, status } : null);
      return {
        sets: next ? { ...state.sets, [setId]: { view: { ...next, status } } } : state.sets,
        drafts: without(state.drafts, setId),
        errors: without(state.errors, setId),
        busy: without(state.busy, setId),
        formId: state.formId === setId ? null : state.formId,
      };
    }),

    synced: (entries) => set((state) => {
      const sets = Object.fromEntries(entries.map((entry) => [entry.view.id, entry]));
      const keep = (id: string) => answerable(sets[id]);
      return {
        sets,
        // A draft lives as long as its set is still open here.
        drafts: Object.fromEntries(Object.entries(state.drafts).filter(([id]) => keep(id))),
        errors: Object.fromEntries(Object.entries(state.errors).filter(([id]) => keep(id))),
        formId: state.formId && keep(state.formId) ? state.formId : null,
      };
    }),

    openForm: (setId) => {
      if (answerable(get().sets[setId])) set({ formId: setId });
    },
    closeForm: () => set({ formId: null }),

    toggleChoice: (setId, questionId, option) => {
      const question = get().sets[setId]?.view.questions.find((q) => q.id === questionId);
      if (!question || !question.options.includes(option)) return;
      editDraft(setId, questionId, (draft) => {
        const picked = draft.choices.includes(option);
        if (question.multiple) {
          const wanted = new Set(picked ? draft.choices.filter((c) => c !== option) : [...draft.choices, option]);
          return { ...draft, choices: question.options.filter((o) => wanted.has(o)) };
        }
        // One choice: a second click on the picked one unpicks it.
        return { ...draft, choices: picked ? [] : [option] };
      });
    },

    setText: (setId, questionId, text) => {
      const question = get().sets[setId]?.view.questions.find((q) => q.id === questionId);
      if (!question?.allowText) return;
      editDraft(setId, questionId, (draft) => ({ ...draft, text: text.slice(0, 1000) }));
    },

    send: async (setId) => {
      const entry = get().sets[setId];
      // GM r7 (1): a tab not confirmed as the person sends nothing (its form's buttons lock).
      if (!answerable(entry) || get().busy[setId] || personUnconfirmed()) return false;
      const inputs = answerInputs(entry.view, get().drafts[setId]);
      if (inputs.length === 0) return false;
      set((state) => ({ busy: { ...state.busy, [setId]: true }, errors: without(state.errors, setId) }));
      try {
        await answerQuestions(setId, entry.answerKey, inputs);
      } catch (error) {
        const line = failureMessage(error, "Couldn't send the answers.");
        set((state) => ({ busy: without(state.busy, setId), errors: { ...state.errors, [setId]: line } }));
        // GM, #204 r3: a refusal only for not being connected as the person goes on the promote.
        clearLineOnPromote(error, () => get().errors[setId], line, // clears-on-promote: questions.answer
          () => set((state) => ({ errors: without(state.errors, setId) })));
        return false;
      }
      set((state) => ({ busy: without(state.busy, setId) }));
      // The socket's questionsClosed brings the server's copy; until then, ours.
      if (get().sets[setId]?.view.status === 'open') settle(setId, 'answered', localAnswers(entry.view, inputs));
      return true;
    },

    dismiss: async (setId) => {
      const entry = get().sets[setId];
      // GM r7 (1): a tab not confirmed as the person sends nothing (its form's buttons lock).
      if (!answerable(entry) || get().busy[setId] || personUnconfirmed()) return false;
      set((state) => ({ busy: { ...state.busy, [setId]: true }, errors: without(state.errors, setId) }));
      try {
        await dismissQuestions(setId, entry.answerKey);
      } catch (error) {
        const line = failureMessage(error, "Couldn't dismiss the questions.");
        set((state) => ({ busy: without(state.busy, setId), errors: { ...state.errors, [setId]: line } }));
        // GM, #204 r3: a refusal only for not being connected as the person goes on the promote.
        clearLineOnPromote(error, () => get().errors[setId], line, // clears-on-promote: questions.dismiss
          () => set((state) => ({ errors: without(state.errors, setId) })));
        return false;
      }
      set((state) => ({ busy: without(state.busy, setId) }));
      if (get().sets[setId]?.view.status === 'open') settle(setId, 'dismissed', null);
      return true;
    },

    reset: () => set(initialState()),
  };
});

/** Whether Send is on: the set is open here and at least one question has an answer. */
export function canSend(state: Pick<AgentQuestionsState, 'sets' | 'drafts'>, setId: string): boolean {
  const entry = state.sets[setId];
  return answerable(entry) && answerInputs(entry.view, state.drafts[setId]).length > 0;
}

/** Each agent's open sets, oldest first: what "Needs you" lists (Q125 item 2). */
export function openByAgent(state: Pick<AgentQuestionsState, 'sets'>): Record<string, QuestionSetView[]> {
  const byAgent: Record<string, QuestionSetView[]> = {};
  const open = Object.values(state.sets).map((entry) => entry.view).filter((view) => view.status === 'open');
  open.sort((a, b) => a.createdAt - b.createdAt);
  for (const view of open) (byAgent[view.agent.id] ??= []).push(view);
  return byAgent;
}

wsClient.subscribe((event) => {
  const store = useAgentQuestionsStore.getState();
  if (event.type === 'questionsOpened') {
    const view = sanitizeQuestionSet(event.set);
    if (view && typeof event.answerKey === 'string' && event.answerKey) store.opened(view, event.answerKey);
  } else if (event.type === 'questionsClosed') {
    if (typeof event.questionId !== 'string') return;
    const view = sanitizeQuestionSet(event.set);
    store.closed(event.questionId, event.status, view && view.id === event.questionId ? view : null);
  } else if (event.type === 'questionsSync') {
    const entries: QuestionSetEntry[] = [];
    for (const raw of Array.isArray(event.sets) ? event.sets : []) {
      const view = sanitizeQuestionSet(raw);
      if (!view) continue;
      const key = (raw as { answerKey?: unknown }).answerKey;
      if (view.status === 'open') {
        // An open set with no key can't be answered from this tab: not kept.
        if (typeof key === 'string' && key) entries.push({ view, answerKey: key });
      } else {
        entries.push({ view });
      }
    }
    store.synced(entries);
  }
});
