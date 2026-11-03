/**
 * The Message box (GM - Design r50, r55; backend services/person_thread.py):
 * the person messages a Claude Code session that listens through the Nebula
 * channel, from the composer in the Agent log, and reads its replies there.
 *
 * The eager part: the rows, the listeners and the one API call, which the
 * store (store/personThreadStore.ts, loaded with the app) needs. Everything
 * only the deferred box reads (its words, states and folds) lives in
 * lib/personThreadBox.ts, in the Agent log's chunk (GM r61's budget: only
 * the thread store belongs in the entry).
 */
import { apiRequest } from './apiRequest';
import { RequestFailedError, failureMessage } from './errorCopy';
import { cleanSession } from './agentCursorLabel';
import type { AgentPresenceSession } from './wsClient';

/** The person's tabs get the thread (on a verified hello: `sync`; then each new or changed row). */
export interface PersonThreadEvent {
  type: 'personThread';
  change: 'sync' | 'rows';
  projectId: string | null;
  rows: unknown[];
}

/** PR A's readiness message: every channel listener, person form. */
export interface ChannelListenersEvent {
  type: 'channelListeners';
  projectId: string | null;
  listeners: unknown[];
  rev?: number;
}

export const MESSAGE_MAX = 2000;
/** The heading a failed send is read under (apiRequest's, failureMessage's). */
export const SEND_HEADING = "Couldn't send your message.";

/** Window events the thread's Show buttons send: PinLayer pans to the pin
 * and opens it (detail {pinId}); the Updates corner opens its list. */
export const PIN_SHOW_EVENT = 'nebula:pin-show';
export const UPDATES_OPEN_EVENT = 'nebula:updates-open';

/** The Sending… threshold and hold (r50: after 300 ms, held at least 400 ms). */
export const SENDING_AFTER_MS = 300;
export const SENDING_HOLD_MS = 400;

export interface ThreadAgent { id: string; name: string; color: string; verified: boolean }

export type MessageState = 'sent' | 'held' | 'accepted';

export interface ThreadRow {
  id: string;
  kind: 'message' | 'reply' | 'question' | 'proposal' | 'note' | 'pin' | 'pinReply';
  at: number;
  text?: string;
  nodeId?: string | null;
  nodeIds?: string[];
  /** A message's recipient. */
  to?: { listenerId: string; agent: ThreadAgent; session: AgentPresenceSession | null; sessionKey: string | null };
  state?: MessageState;
  acceptedAt?: number | null;
  clientId?: string;
  /** Everything but a message and a pin: whose row it is. */
  agent?: ThreadAgent;
  session?: AgentPresenceSession | null;
  sessionKey?: string | null;
  questionId?: string;
  questions?: { id: string; text: string; options: string[]; multiple: boolean; allowText: boolean }[];
  proposalId?: string;
  noteId?: string;
  pinId?: string;
}

export interface ChannelListener {
  listenerId: string;
  /** The session's cursor key, even when its cursor isn't live (no number then). */
  sessionKey: string | null;
  agent: ThreadAgent;
  state: 'listening' | 'stopped';
  reason: string | null;
  projectId: string | null;
  since: number;
  seenAt: number;
  session: AgentPresenceSession | null;
}

/** A session's cursor key ({key, ordinal}: the ordinal may be null). */
export function sessionKeyOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const key = (raw as Record<string, unknown>).key;
  return typeof key === 'string' && /^[0-9a-f]{12}$/.test(key) ? key : null;
}

const KINDS = new Set(['message', 'reply', 'question', 'proposal', 'note', 'pin', 'pinReply']);

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function cleanAgent(raw: unknown): ThreadAgent | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const agent = raw as Record<string, unknown>;
  if (typeof agent.id !== 'string' || typeof agent.name !== 'string') return undefined;
  return { id: agent.id, name: agent.name, color: str(agent.color) ?? '', verified: agent.verified === true };
}

/** A row as the socket or the GET sent it, or null when it isn't one. */
export function sanitizeRow(raw: unknown): ThreadRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.id !== 'string' || !KINDS.has(String(row.kind))) return null;
  const at = typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : 0;
  const clean: ThreadRow = { id: row.id, kind: row.kind as ThreadRow['kind'], at };
  if (typeof row.text === 'string') clean.text = row.text;
  if (typeof row.nodeId === 'string') clean.nodeId = row.nodeId;
  if (Array.isArray(row.nodeIds)) clean.nodeIds = row.nodeIds.filter((id): id is string => typeof id === 'string');
  if (row.state === 'sent' || row.state === 'held' || row.state === 'accepted') clean.state = row.state;
  if (typeof row.acceptedAt === 'number') clean.acceptedAt = row.acceptedAt;
  if (typeof row.clientId === 'string') clean.clientId = row.clientId;
  const to = row.to as Record<string, unknown> | undefined;
  const toAgent = cleanAgent(to?.agent);
  if (to && toAgent && typeof to.listenerId === 'string') {
    clean.to = { listenerId: to.listenerId, agent: toAgent, session: cleanSession(to.session),
      sessionKey: sessionKeyOf(to.session) };
  }
  const agent = cleanAgent(row.agent);
  if (agent) clean.agent = agent;
  if (row.session !== undefined) {
    clean.session = cleanSession(row.session);
    clean.sessionKey = sessionKeyOf(row.session);
  }
  for (const key of ['questionId', 'proposalId', 'noteId', 'pinId'] as const) {
    if (typeof row[key] === 'string') clean[key] = row[key] as string;
  }
  if (Array.isArray(row.questions)) {
    clean.questions = row.questions.flatMap((q) => {
      if (!q || typeof q !== 'object') return [];
      const question = q as Record<string, unknown>;
      if (typeof question.id !== 'string' || typeof question.text !== 'string') return [];
      const options = Array.isArray(question.options) ? question.options.filter((o): o is string => typeof o === 'string') : [];
      return [{ id: question.id, text: question.text, options, multiple: question.multiple === true,
        allowText: question.allowText === true }];
    });
  }
  return clean;
}

export function sanitizeListener(raw: unknown): ChannelListener | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const agent = cleanAgent(entry.agent);
  if (!agent || typeof entry.listenerId !== 'string') return null;
  return {
    listenerId: entry.listenerId,
    agent,
    state: entry.state === 'stopped' ? 'stopped' : 'listening',
    reason: str(entry.reason) ?? null,
    projectId: str(entry.projectId) ?? null,
    since: typeof entry.since === 'number' ? entry.since : 0,
    seenAt: typeof entry.seenAt === 'number' ? entry.seenAt : 0,
    session: cleanSession(entry.session),
    sessionKey: sessionKeyOf(entry.session),
  };
}

/** Rows merged by id, oldest first (a changed row replaces its old copy). */
export function mergeRows(current: readonly ThreadRow[], incoming: readonly ThreadRow[]): ThreadRow[] {
  const byId = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** The last event of an agent session (by cursor key): when, and its action line. */
export interface SessionActivity { at: number; line: string | null }

// -- the API -------------------------------------------------------------------------

export type SendFailure = 'server' | 'stopped' | 'other';

/** Which line a failed send gets: the listener dropped (no button), or the
 * server didn't answer (Try again); anything else reads as the server's. */
export function sendFailure(error: unknown): SendFailure {
  if (error instanceof RequestFailedError) {
    if (error.code === 'listener_stopped') return 'stopped';
    if (error.status >= 500) return 'server';
    return 'other';
  }
  return 'server';
}

export async function postMessage(body: { text: string; to: string; nodeIds: string[]; clientId: string }): Promise<ThreadRow> {
  const response = await apiRequest(SEND_HEADING, '/api/canvas/thread/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { row?: unknown };
  const row = sanitizeRow(payload.row);
  if (!row) throw new RequestFailedError(SEND_HEADING, 500, { detail: 'invalid answer' });
  return row;
}

export function newClientId(): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `c-${random.replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 64);
}

/**
 * How long a send that was answered waits before it settles: none when the
 * answer came before "Sending…" showed (300 ms); otherwise until the line
 * has shown for at least 400 ms, so it never flickers.
 */
export function sendingSettleDelay(startedAt: number, answeredAt: number): number {
  const elapsed = answeredAt - startedAt;
  if (elapsed < SENDING_AFTER_MS) return 0;
  return Math.max(0, SENDING_AFTER_MS + SENDING_HOLD_MS - elapsed);
}

/** Rows not yet known by id are added; a known row keeps its (maybe newer) copy. */
export function mergeMissing(current: readonly ThreadRow[], incoming: readonly ThreadRow[]): ThreadRow[] {
  const known = new Set(current.map((row) => row.id));
  const added = incoming.filter((row) => !known.has(row.id));
  return added.length ? mergeRows(current, added) : [...current];
}

/** A failed send's own words, for a failure that is neither the server's
 * nor the listener's (those two have r50's lines, which the box writes with
 * the session's label): failureMessage's, never an Error's raw message. */
export function otherFailureLine(error: unknown): string {
  return failureMessage(error, SEND_HEADING);
}
