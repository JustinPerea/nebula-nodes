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
import { cleanSession, cursorLabel } from './agentCursorLabel';
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

/** 'dropped': its listener's token was revoked before it took the message (never delivered). */
export type MessageState = 'sent' | 'held' | 'accepted' | 'dropped';

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
  /** A reply: the message its session's listener had taken when it replied (NIT-4). */
  replyTo?: string | null;
  /** A question row, once its set closed (GM r79.5): the person's own record, never an agent's. */
  outcome?: QuestionOutcome;
  /** Raised by each change to the row (review 3 LOW-4): the newer copy wins a merge. */
  rev?: number;
}

export interface QuestionOutcome {
  status: string;
  closedAt: number | null;
  answers: { questionId: string; choices: string[]; text: string | null }[] | null;
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

/** GM r89.1: THE one rule for what counts as a reply to the person: a reply
 * and a pin answer (addressed to the person). The "New reply" pill, the
 * "N unread replies" badge and the spoken "… replied." all read it. */
export function countsAsReply(row: Pick<ThreadRow, 'kind'>): boolean {
  return row.kind === 'reply' || row.kind === 'pinReply';
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
  if (row.state === 'sent' || row.state === 'held' || row.state === 'accepted' || row.state === 'dropped') clean.state = row.state;
  if (typeof row.acceptedAt === 'number') clean.acceptedAt = row.acceptedAt;
  if (typeof row.rev === 'number' && Number.isFinite(row.rev)) clean.rev = row.rev;
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
  for (const key of ['questionId', 'proposalId', 'noteId', 'pinId', 'replyTo'] as const) {
    if (typeof row[key] === 'string') clean[key] = row[key] as string;
  }
  const outcome = row.outcome as Record<string, unknown> | undefined;
  if (outcome && typeof outcome.status === 'string') {
    clean.outcome = {
      status: outcome.status,
      closedAt: typeof outcome.closedAt === 'number' ? outcome.closedAt : null,
      answers: Array.isArray(outcome.answers) ? outcome.answers.flatMap((a) => {
        const answer = a as Record<string, unknown> | null;
        return answer && typeof answer.questionId === 'string' ? [{ questionId: answer.questionId,
          choices: Array.isArray(answer.choices) ? answer.choices.filter((c): c is string => typeof c === 'string') : [],
          text: typeof answer.text === 'string' ? answer.text : null }] : [];
      }) : null,
    };
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
  // A copy older than the one held (a lower rev) never replaces it (review 3 LOW-4).
  for (const row of incoming) if ((byId.get(row.id)?.rev ?? 0) <= (row.rev ?? 0)) byId.set(row.id, row);
  return [...byId.values()].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

/** A sync of the thread the tab already holds: the snapshot, merged by rev,
 * plus rows newer than anything in it (a reply that reached the tab after
 * the snapshot was read), so a stale sync never drops one or moves a row back. */
export function syncRows(current: readonly ThreadRow[], snapshot: readonly ThreadRow[]): ThreadRow[] {
  const newest = snapshot.reduce((at, row) => Math.max(at, row.at), -Infinity);
  const ids = new Set(snapshot.map((row) => row.id));
  return mergeRows(current.filter((row) => ids.has(row.id) || row.at > newest), snapshot);
}

/** The last event of an agent session (by cursor key): when, and its action line. */
export interface SessionActivity { at: number; line: string | null }

// -- availability (the Message box's and the shortcut sheet's, GM r89.4, r94.2) ------

/** The product, named literally (r61 answer 3): the composer's label with no session to name (GM r89.4). */
export const PRODUCT_LABEL = 'Claude Code';

export type Availability =
  | { kind: 'ready'; recipient: ChannelListener; listening: ChannelListener[] }
  | { kind: 'notConnected' }
  | { kind: 'stopped'; listener: ChannelListener }
  /** `last`: the listener that was active most recently, if any (the composer's label names it). */
  | { kind: 'offline'; last: ChannelListener | null };

/** Which line locks the composer, if any. Offline wins (the app's row says it). */
export function availability(listeners: readonly ChannelListener[], offline: boolean,
  chosen: string | null, lastSeen: Readonly<Record<string, number>>): Availability {
  if (offline) return { kind: 'offline', last: listeners.length > 0 ? mostRecent(listeners, lastSeen) : null };
  const listening = listeners.filter((entry) => entry.state === 'listening');
  if (listening.length === 0) {
    // The session that stopped last is the one the line names.
    return listeners.length === 0 ? { kind: 'notConnected' } : { kind: 'stopped', listener: mostRecent(listeners, lastSeen) };
  }
  const picked = chosen ? listening.find((entry) => entry.listenerId === chosen) : undefined;
  return { kind: 'ready', recipient: picked ?? mostRecent(listening, lastSeen), listening };
}

/**
 * GM r89.4: THE label the composer names its agent by, in every state: the
 * field's placeholder and aria-label ("Message Claude Code") and the lock
 * line ("Claude Code stopped listening…") read it, as the agent's rows do
 * (its cursor label). Ready: the recipient. Stopped: the listener that
 * stopped last. Offline: the listener active most recently, if any. Else
 * (not connected, or offline with none) the product, as NOT_CONNECTED_LINE
 * names it.
 */
export function availabilityLabel(state: Availability): string {
  const who = state.kind === 'ready' ? state.recipient : state.kind === 'stopped' ? state.listener
    : state.kind === 'offline' ? state.last : null;
  return who ? cursorLabel(who.agent.name, who.session) : PRODUCT_LABEL;
}

/** The listening session that was active most recently: its last cursor event, else when it started listening. */
export function mostRecent(listening: readonly ChannelListener[], lastSeen: Readonly<Record<string, number>>): ChannelListener {
  const active = (entry: ChannelListener) => Math.max(entry.since, entry.sessionKey ? lastSeen[entry.sessionKey] ?? 0 : 0);
  return [...listening].sort((a, b) => active(b) - active(a) || b.since - a.since)[0];
}
