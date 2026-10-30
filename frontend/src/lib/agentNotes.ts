import { apiRequest } from './apiRequest';
import { TAB_HEADER, TAB_ID } from './tabId';

/**
 * Updates: what an agent or the board reader noticed, saved with the project
 * (main canvas) or with a board (backend services/agent_notes.py). "Updates"
 * is the word on screen; the code keeps the name `agentNotes`, since "update"
 * already names board writes and a bare "notes" would mean image notes.
 */

export type AgentNoteAbout =
  | 'sinceLastTurn' | 'analyze' | 'suggestion' | 'removedLook' | 'changedWords' | 'proposal' | 'question' | 'run'
  | 'other';

export interface AgentNoteAuthor {
  kind: 'agent' | 'reader';
  id: string;
  name: string;
  color: string;
  verified?: boolean;
}

export interface AgentNoteAction {
  label: string;
  op: { kind: string } & Record<string, unknown>;
}

/** Saved text as runs: plain text, or a board image drawn with its current number. */
export type AgentNotePart = { text: string } | { ref: string; number: number | null };

export interface AgentNote {
  id: string;
  author: AgentNoteAuthor;
  source: 'agent' | 'nebula';
  about: AgentNoteAbout;
  at: string;
  text: string;
  parts: AgentNotePart[];
  refs: string[];
  actions: AgentNoteAction[];
  readAt: string | null;
  dismissedAt: string | null;
  actedAt: string | null;
  /** The label of the action that ran ("Undo the sort"), once one did. */
  actedWith: string | null;
  /** An asset proposal's Update (Q92 a), once the proposal closed: when, and
   * how it ended in one short line ("Accepted: the cover changed"). */
  resolvedAt?: string | null;
  outcome?: string | null;
  /** A question set's Update (Q125 item 1): the set it asks. Its questions
   * and answers are never on the Update (store/agentQuestionsStore.ts). */
  questionsId?: string | null;
  /** That set's count of questions (1 to 5) and when it was asked (ms), from
   * its ref, never the text: what a held tab's Agents panel counts and orders
   * by (GM, 2026-10-29). Older refs have neither. */
  questionsCount?: number | null;
  questionsSince?: number | null;
  /** A done card (Q125 item 3): the agent's run that ended, as Nebula posted it. */
  run?: AgentNoteRun | null;
  /** A proposal's Update: what its structured ref says of the change (backend
   * agent_notes.proposal_detail). Only the kind of cover and the edit count. */
  proposal?: AgentNoteProposal | null;
}

/** A proposal Update's ref beyond its id and target (GM, PR #200 follow-up 2):
 * a cover's kind, never which image; a Commons ask's count of edits. */
export interface AgentNoteProposal {
  cover?: 'automatic' | 'image';
  changes?: number;
  /** A Commons ask only to take a reference out of the inbox (GM, PR #202 r1). */
  inbox?: true;
  /** PR #202 review 2 LOW-A: when the ask was made (its createdAt, ms), so a held tab orders as the promoted line does. */
  since?: number;
  /** PR #204 review 1 MEDIUM-1: an asset Update one agent's open asks on one
   * target share says how many (`asks`) and the oldest one's createdAt
   * (`firstSince`), so a held tab counts and orders as the promoted one does. */
  asks?: number;
  firstSince?: number;
}

/** The backend's bounds for an Update's ref (backend agent_notes.MAX_REF_QUESTIONS,
 * agent_questions.MAX_QUESTIONS; agent_notes.MAX_SHARED_ASKS,
 * canvas_proposals.MAX_OPEN_PER_AGENT). One value each: a backend contract test
 * (test_presence_followups_3_round3.py) reads these lines and fails when they drift. */
export const MAX_REF_QUESTIONS = 5;
export const MAX_SHARED_ASKS = 3;

/** A whole number from a question set's ref, within [min, max]; else null. */
function questionsField(raw: unknown, key: 'count' | 'since', min: number, max: number): number | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

/** A done card's run (backend agent_notes.post_run_done). */
export interface AgentNoteRun {
  id: string;
  nodeIds: string[];
  lastNodeId: string;
  outcome: 'success' | 'partial' | 'failure';
  /** An output Nebula keeps (an /api/outputs URL), never a copy or a provider's URL. */
  thumbnail?: { kind: 'image' | 'video'; url: string; nodeId: string };
}

export type AgentNotesSurface = { kind: 'canvas' } | { kind: 'board'; boardId: string };

export interface AgentNotesListing {
  projectId?: string | null;
  boardId?: string;
  notes: AgentNote[];
  unread: number;
  keptWith?: 'project' | 'board';
}

/** The socket's `agentNotes` message (backend main.py `_notes_message`). */
export interface AgentNotesEvent {
  type: 'agentNotes';
  surface: 'canvas' | 'board';
  op: 'sync' | 'added' | 'read' | 'dismissed' | 'acted' | 'resolved' | 'changed';
  projectId?: string | null;
  boardId?: string;
  note?: unknown;
  notes?: unknown[];
  ids?: string[];
  /** Updates that left the list to make room for an added one. */
  removed?: string[];
  unread?: number;
  at: number;
}

export const DEFAULT_AGENT_COLOR = '#E8825A';
/** Argon's lavender, the reader's colour in GM's mockups. */
export const READER_COLOR = '#B4A7FF';
export const MAX_NOTE_BUTTONS = 2;

const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const ABOUT: readonly AgentNoteAbout[] = [
  'sinceLastTurn', 'analyze', 'suggestion', 'removedLook', 'changedWords', 'proposal', 'question', 'run', 'other',
];
const OUTCOMES: readonly AgentNoteRun['outcome'][] = ['success', 'partial', 'failure'];
/** Only a file in Nebula's output folder: no scheme, no `..`, nothing signed. */
const OUTPUT_URL = /^\/api\/outputs\/(?!.*\.\.)[^?#\s]+$/;

function sanitizeRun(raw: unknown): AgentNoteRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const run = raw as Record<string, unknown>;
  const id = str(run.id);
  const lastNodeId = str(run.lastNodeId);
  if (!id || !lastNodeId) return null;
  const outcome = OUTCOMES.includes(run.outcome as AgentNoteRun['outcome'])
    ? (run.outcome as AgentNoteRun['outcome']) : 'success';
  const thumb = run.thumbnail && typeof run.thumbnail === 'object' ? run.thumbnail as Record<string, unknown> : null;
  const thumbnail = thumb && (thumb.kind === 'image' || thumb.kind === 'video')
    && typeof thumb.url === 'string' && OUTPUT_URL.test(thumb.url)
    ? { kind: thumb.kind, url: thumb.url, nodeId: str(thumb.nodeId) ?? lastNodeId } as const : null;
  return {
    id,
    nodeIds: Array.isArray(run.nodeIds) ? run.nodeIds.filter((node): node is string => typeof node === 'string').slice(0, 200) : [],
    lastNodeId,
    outcome,
    ...(thumbnail ? { thumbnail } : {}),
  };
}

function sanitizeProposal(raw: unknown): AgentNoteProposal | null {
  if (!raw || typeof raw !== 'object') return null;
  const ref = raw as Record<string, unknown>;
  const out: AgentNoteProposal = {};
  if (ref.cover === 'automatic' || ref.cover === 'image') out.cover = ref.cover;
  if (typeof ref.changes === 'number' && Number.isInteger(ref.changes) && ref.changes >= 1 && ref.changes <= 999) {
    out.changes = ref.changes;
  }
  if (ref.inbox === true) out.inbox = true;
  if (typeof ref.since === 'number' && Number.isSafeInteger(ref.since) && ref.since >= 0) out.since = ref.since;
  if (typeof ref.asks === 'number' && Number.isSafeInteger(ref.asks) && ref.asks >= 1 && ref.asks <= MAX_SHARED_ASKS) {
    out.asks = ref.asks;
  }
  if (typeof ref.firstSince === 'number' && Number.isSafeInteger(ref.firstSince) && ref.firstSince >= 0) {
    out.firstSince = ref.firstSince;
  }
  return out;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function sanitizeAuthor(raw: unknown): AgentNoteAuthor | null {
  if (!raw || typeof raw !== 'object') return null;
  const author = raw as Record<string, unknown>;
  const kind = author.kind === 'reader' ? 'reader' : author.kind === 'agent' ? 'agent' : null;
  if (!kind) return null;
  const name = str(author.name) ?? (kind === 'reader' ? 'Reader' : 'Agent');
  const fallback = kind === 'reader' ? READER_COLOR : DEFAULT_AGENT_COLOR;
  return {
    kind,
    id: str(author.id) ?? name,
    name: name.slice(0, 40),
    color: typeof author.color === 'string' && SAFE_COLOR.test(author.color) ? author.color : fallback,
    ...(author.verified === true ? { verified: true } : {}),
  };
}

function sanitizeParts(raw: unknown, text: string): AgentNotePart[] {
  if (!Array.isArray(raw)) return [{ text }];
  const parts: AgentNotePart[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const part = item as Record<string, unknown>;
    if (typeof part.text === 'string') parts.push({ text: part.text });
    else if (typeof part.ref === 'string') {
      parts.push({ ref: part.ref, number: typeof part.number === 'number' && Number.isFinite(part.number) ? part.number : null });
    }
  }
  return parts.length > 0 ? parts : [{ text }];
}

function sanitizeActions(raw: unknown): AgentNoteAction[] {
  if (!Array.isArray(raw)) return [];
  const actions: AgentNoteAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const action = item as Record<string, unknown>;
    const op = action.op as Record<string, unknown> | undefined;
    if (typeof action.label !== 'string' || !op || typeof op !== 'object' || typeof op.kind !== 'string') continue;
    // GM r9 3 (#204 round 7): an old stored Update's Accept and Reject are no longer offered.
    // They become one Review of the same canvas proposal, so every row decides through the
    // one full view (the bar). `legacy` lets the corner grey it when the proposal is gone.
    if (op.kind === 'proposal.accept' || op.kind === 'proposal.reject') {
      const proposalId = typeof op.proposalId === 'string' ? op.proposalId : '';
      if (!proposalId || actions.some((kept) => kept.op.kind === 'proposal.review' && kept.op.proposalId === proposalId)) continue;
      actions.push({ label: 'Review', op: { kind: 'proposal.review', proposalId, target: 'canvas', legacy: true } });
    } else actions.push({ label: action.label, op: { ...op, kind: op.kind } });
    if (actions.length === MAX_NOTE_BUTTONS) break;
  }
  return actions;
}

/** Keep only well-formed updates; text stays plain and is rendered escaped. */
export function sanitizeNote(raw: unknown): AgentNote | null {
  if (!raw || typeof raw !== 'object') return null;
  const note = raw as Record<string, unknown>;
  const id = str(note.id);
  const author = sanitizeAuthor(note.author);
  if (!id || !author || typeof note.text !== 'string') return null;
  return {
    id,
    author,
    source: note.source === 'nebula' ? 'nebula' : 'agent',
    about: ABOUT.includes(note.about as AgentNoteAbout) ? (note.about as AgentNoteAbout) : 'other',
    at: str(note.at) ?? '',
    text: note.text,
    parts: sanitizeParts(note.parts, note.text),
    refs: Array.isArray(note.refs) ? note.refs.filter((ref): ref is string => typeof ref === 'string').slice(0, 12) : [],
    actions: sanitizeActions(note.actions),
    readAt: str(note.readAt),
    dismissedAt: str(note.dismissedAt),
    actedAt: str(note.actedAt),
    actedWith: str(note.actedWith),
    resolvedAt: str(note.resolvedAt),
    outcome: typeof note.outcome === 'string' && note.outcome ? note.outcome.slice(0, 80) : null,
    questionsId: note.questions && typeof note.questions === 'object'
      ? str((note.questions as Record<string, unknown>).id) : null,
    questionsCount: questionsField(note.questions, 'count', 1, MAX_REF_QUESTIONS),
    questionsSince: questionsField(note.questions, 'since', 0, Number.MAX_SAFE_INTEGER),
    run: note.about === 'run' ? sanitizeRun(note.run) : null,
    proposal: note.about === 'proposal' ? sanitizeProposal(note.proposal) : null,
  };
}

export function sanitizeNotes(raw: unknown): AgentNote[] {
  return Array.isArray(raw) ? raw.map(sanitizeNote).filter((note): note is AgentNote => note !== null) : [];
}

export function isUnread(note: AgentNote): boolean {
  return !note.readAt && !note.dismissedAt;
}

export function surfaceKey(surface: { kind: 'canvas'; projectId: string | null } | { kind: 'board'; boardId: string }): string {
  return surface.kind === 'canvas' ? `canvas:${surface.projectId ?? ''}` : `board:${surface.boardId}`;
}

// -- the API ---------------------------------------------------------------------

function base(surface: AgentNotesSurface): string {
  return surface.kind === 'canvas'
    ? '/api/canvas/agent-notes'
    : `/api/moodboards/${encodeURIComponent(surface.boardId)}/agent-notes`;
}

export async function fetchAgentNotes(surface: AgentNotesSurface): Promise<AgentNotesListing> {
  // This tab says it is a tab (X-Nebula-Tab, which agents never send), so a shared Update keeps
  // what it stands for here even before the tab is connected as the person (PR #204 round 4).
  const response = await apiRequest("Couldn't load the updates.", base(surface), { headers: { [TAB_HEADER]: TAB_ID } });
  return (await response.json()) as AgentNotesListing;
}

/** Read every update from `upTo` down (opening the list), or just `ids` (a clicked card). */
export async function markAgentNotesRead(
  surface: AgentNotesSurface,
  upTo?: string,
  ids?: string[],
): Promise<{ ids: string[]; unread: number; projectId?: string | null }> {
  const response = await apiRequest("Couldn't mark the updates as read.", `${base(surface)}/read`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ids ? { ids } : upTo ? { upTo } : {}),
  });
  return (await response.json()) as { ids: string[]; unread: number; projectId?: string | null };
}

export async function dismissAgentNote(
  surface: AgentNotesSurface,
  id: string,
): Promise<{ note?: unknown; unread: number }> {
  const response = await apiRequest("Couldn't dismiss the update.", `${base(surface)}/${encodeURIComponent(id)}/dismiss`, { method: 'POST' });
  return (await response.json()) as { note?: unknown; unread: number };
}
