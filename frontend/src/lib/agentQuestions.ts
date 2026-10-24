import { apiRequest } from './apiRequest';
import { DEFAULT_AGENT_COLOR } from './agentNotes';

/**
 * Questions an agent asked the person (Q125 item 1; backend
 * services/agent_questions.py). The agent asks 1 to 5; the person answers
 * or dismisses them from the Update's Answer, and only from a canvas the
 * socket gave the set's answer key to. Nothing here lets an agent answer.
 *
 * Imported at startup by store/agentQuestionsStore.ts; the form itself is
 * deferred (components/agent-notes/AgentQuestionsForm.tsx).
 */

export type QuestionSetStatus = 'open' | 'answered' | 'dismissed' | 'withdrawn';

export interface QuestionAgent {
  id: string;
  name: string;
  color: string;
  verified: boolean;
}

export interface AgentQuestion {
  /** "q1".."q5", in the order asked. */
  id: string;
  text: string;
  /** 0, or 2 to 6 choices. */
  options: string[];
  /** Any number of the options, rather than one. */
  multiple: boolean;
  /** A typed answer is allowed (always, when there are no options). */
  allowText: boolean;
}

export interface QuestionAnswer {
  questionId: string;
  answered: boolean;
  /** In option order. */
  choices: string[];
  text: string | null;
}

/** As the backend's QuestionBook.view: the person's canvas and the asking agent only. */
export interface QuestionSetView {
  id: string;
  status: QuestionSetStatus;
  agent: QuestionAgent;
  note: string | null;
  projectId: string | null;
  nodeIds: string[];
  createdAt: number;
  closedAt: number | null;
  questions: AgentQuestion[];
  /** One per question once answered; null otherwise. */
  answers: QuestionAnswer[] | null;
  /** The Update it posted ({id, projectId}). */
  update?: { id: string; projectId: string } | null;
}

/** What Send posts: answered questions only; one left out is blank. */
export type QuestionAnswerInput =
  | { questionId: string; choices: string[]; text?: string }
  | { questionId: string; text: string };

/** Browser sockets only: a new set plus the key that lets this canvas answer it. */
export interface QuestionsOpenedEvent {
  type: 'questionsOpened';
  set: unknown;
  answerKey: string;
}

/** Browser sockets only, after hello: open sets with their keys, then recently closed ones. */
export interface QuestionsSyncEvent {
  type: 'questionsSync';
  sets: unknown[];
}

/** Browser sockets only: answered, dismissed or withdrawn, with the set as it closed. */
export interface QuestionsClosedEvent {
  type: 'questionsClosed';
  questionId: string;
  status: Exclude<QuestionSetStatus, 'open'>;
  agentId: string;
  set?: unknown;
}

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const STATUSES: readonly QuestionSetStatus[] = ['open', 'answered', 'dismissed', 'withdrawn'];

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function strings(value: unknown, max: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, max) : [];
}

function sanitizeQuestion(raw: unknown): AgentQuestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const question = raw as Record<string, unknown>;
  const id = str(question.id);
  const text = str(question.text);
  if (!id || !text) return null;
  const options = strings(question.options, 6);
  return {
    id,
    text,
    options,
    multiple: options.length > 0 && question.multiple === true,
    // No options: a typed answer is the only answer there is.
    allowText: options.length === 0 || question.allowText !== false,
  };
}

function sanitizeAnswer(raw: unknown): QuestionAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const answer = raw as Record<string, unknown>;
  const questionId = str(answer.questionId);
  if (!questionId) return null;
  return {
    questionId,
    answered: answer.answered === true,
    choices: strings(answer.choices, 6),
    text: typeof answer.text === 'string' && answer.text ? answer.text : null,
  };
}

/** Keep only a well-formed set; its text stays plain and is rendered escaped. */
export function sanitizeQuestionSet(raw: unknown): QuestionSetView | null {
  if (!raw || typeof raw !== 'object') return null;
  const set = raw as Record<string, unknown>;
  const id = str(set.id);
  const agent = set.agent && typeof set.agent === 'object' ? set.agent as Record<string, unknown> : null;
  if (!id || !agent) return null;
  const questions = Array.isArray(set.questions)
    ? set.questions.map(sanitizeQuestion).filter((q): q is AgentQuestion => q !== null).slice(0, 5)
    : [];
  if (questions.length === 0) return null;
  const name = (str(agent.name) ?? 'Agent').slice(0, 40);
  const update = set.update && typeof set.update === 'object' ? set.update as Record<string, unknown> : null;
  return {
    id,
    status: STATUSES.includes(set.status as QuestionSetStatus) ? set.status as QuestionSetStatus : 'open',
    agent: {
      id: str(agent.id) ?? name,
      name,
      // The colour goes into CSS: only plain hex passes.
      color: typeof agent.color === 'string' && SAFE_COLOR.test(agent.color) ? agent.color : DEFAULT_AGENT_COLOR,
      verified: agent.verified === true,
    },
    note: str(set.note),
    projectId: str(set.projectId),
    nodeIds: strings(set.nodeIds, 12),
    createdAt: typeof set.createdAt === 'number' && Number.isFinite(set.createdAt) ? set.createdAt : 0,
    closedAt: typeof set.closedAt === 'number' && Number.isFinite(set.closedAt) ? set.closedAt : null,
    questions,
    answers: Array.isArray(set.answers)
      ? set.answers.map(sanitizeAnswer).filter((a): a is QuestionAnswer => a !== null)
      : null,
    update: update && str(update.id) ? { id: str(update.id)!, projectId: str(update.projectId) ?? '' } : null,
  };
}

// -- the API (the person's only: the key comes from this tab's socket) -------------

function keyed(answerKey: string, body?: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Nebula-Proposal-Key': answerKey },
    body: JSON.stringify(body ?? {}),
  };
}

export async function answerQuestions(setId: string, answerKey: string, answers: QuestionAnswerInput[]): Promise<void> {
  await apiRequest("Couldn't send the answers.", `/api/canvas/questions/${encodeURIComponent(setId)}/answer`,
    keyed(answerKey, { answers }));
}

export async function dismissQuestions(setId: string, answerKey: string): Promise<void> {
  await apiRequest("Couldn't dismiss the questions.", `/api/canvas/questions/${encodeURIComponent(setId)}/dismiss`,
    keyed(answerKey));
}
