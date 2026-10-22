import { apiRequest } from './apiRequest';

/**
 * Updates: what an agent or the board reader noticed, saved with the project
 * (main canvas) or with a board (backend services/agent_notes.py). "Updates"
 * is the word on screen; the code keeps the name `agentNotes`, since "update"
 * already names board writes and a bare "notes" would mean image notes.
 */

export type AgentNoteAbout =
  | 'sinceLastTurn' | 'analyze' | 'suggestion' | 'removedLook' | 'changedWords' | 'proposal' | 'other';

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
  'sinceLastTurn', 'analyze', 'suggestion', 'removedLook', 'changedWords', 'proposal', 'other',
];

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
    actions.push({ label: action.label, op: { ...op, kind: op.kind } });
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
  const response = await apiRequest("Couldn't load the updates.", base(surface));
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
