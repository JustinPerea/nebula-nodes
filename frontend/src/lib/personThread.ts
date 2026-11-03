/**
 * The Message box (GM - Design r50, r55; backend services/person_thread.py):
 * the person messages a Claude Code session that listens through the Nebula
 * channel, from the composer in the Agent log, and reads its replies there.
 *
 * The eager part: the rows and the listeners, which the store
 * (store/personThreadStore.ts, loaded with the app) needs to take every
 * socket event (the wake path). Everything only the deferred box uses lives
 * in the Agent log's chunk (GM r61, r70's budget): its words, states and
 * folds in lib/personThreadBox.ts, the draft and the send (the one API
 * call) in lib/personThreadCompose.ts.
 */
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

/** Window events the thread's Show buttons send: PinLayer pans to the pin
 * and opens it (detail {pinId}); the Updates corner opens its list. */
export const PIN_SHOW_EVENT = 'nebula:pin-show';
export const UPDATES_OPEN_EVENT = 'nebula:updates-open';

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
