/**
 * The Message box (GM - Design r50, r55; backend services/person_thread.py):
 * the person messages a Claude Code session that listens through the Nebula
 * channel, from the composer in the Agent log, and reads its replies there.
 *
 * Pure parts and the one API call, shared by the eager store
 * (store/personThreadStore.ts) and the deferred box (components/panels/MessageBox.tsx).
 * Every state comes from something Nebula saw (the request in flight, the
 * listener's push or hold, an event from that session, a reply, a timer),
 * never from a read receipt.
 */
import { apiRequest } from './apiRequest';
import { RequestFailedError, quotedNames } from './errorCopy';
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
/** "N left" shows from here (the composer's counter, PromptDialog's form). */
export const MESSAGE_COUNTER_FROM = 200;
/** Spoken past these only (GM r23 item 4, the PromptDialog rule). */
export const MESSAGE_ANNOUNCE_AT = [30, 10, 0] as const;
export const COPY_COMMAND = 'nebula mcp connect claude-code --channel';

// GM r50 and r55, verbatim (curly quotes and apostrophes, the single …).
export const SENDING_LINE = 'Sending…';
export const WAITING_LINE = 'Waiting for Claude';
export const WORKING_LINE = 'Claude is working';
export const SENT_LINE = 'Sent';
export const HELD_LINE = 'Sends in a few minutes because you’ve sent 200 this hour.';
export const NOT_CONNECTED_LINE = 'Connect Claude Code with the Nebula channel to message it here.';
export const STOPPED_LISTENING_LINE = 'Claude stopped listening. Reconnect nebula-listen with /mcp in its terminal to message it here.';
export const SERVER_FAILED_LINE = 'Nebula couldn’t send your message because the server isn’t answering. Try again.';
export const LISTENER_DROPPED_LINE = 'Nebula couldn’t send your message because Claude stopped listening. Reconnect it in the terminal, then send it again.';
export const COPY_LABEL = 'Copy command';
export const COPIED_LINE = 'Copied the command';
export const NEW_REPLY_PILL = 'New reply';

/** Window events the thread's Show buttons send: PinLayer pans to the pin
 * and opens it (detail {pinId}); the Updates corner opens its list. */
export const PIN_SHOW_EVENT = 'nebula:pin-show';
export const UPDATES_OPEN_EVENT = 'nebula:updates-open';

/** The Sending… threshold and hold (r50: after 300 ms, held at least 400 ms). */
export const SENDING_AFTER_MS = 300;
export const SENDING_HOLD_MS = 400;
/** "Working" settles back to "Waiting" after this with no event (the cursor's dim). */
export const WORKING_SETTLE_MS = 20_000;
/** "Sent" after this with nothing back. */
export const QUIET_SENT_MS = 60_000;

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

// -- availability ----------------------------------------------------------------

export type Availability =
  | { kind: 'ready'; recipient: ChannelListener; listening: ChannelListener[] }
  | { kind: 'notConnected' }
  | { kind: 'stopped' }
  | { kind: 'offline' };

/** Which line locks the composer, if any. Offline wins (the app's row says it). */
export function availability(listeners: readonly ChannelListener[], offline: boolean,
  chosen: string | null, lastSeen: Readonly<Record<string, number>>): Availability {
  if (offline) return { kind: 'offline' };
  const listening = listeners.filter((entry) => entry.state === 'listening');
  if (listening.length === 0) return listeners.length === 0 ? { kind: 'notConnected' } : { kind: 'stopped' };
  const picked = chosen ? listening.find((entry) => entry.listenerId === chosen) : undefined;
  return { kind: 'ready', recipient: picked ?? mostRecent(listening, lastSeen), listening };
}

/** The listening session that was active most recently: its last cursor event, else when it started listening. */
export function mostRecent(listening: readonly ChannelListener[], lastSeen: Readonly<Record<string, number>>): ChannelListener {
  const active = (entry: ChannelListener) => Math.max(entry.since, entry.sessionKey ? lastSeen[entry.sessionKey] ?? 0 : 0);
  return [...listening].sort((a, b) => active(b) - active(a) || b.since - a.since)[0];
}

// -- a message's state ------------------------------------------------------------

export interface SessionActivity { at: number; line: string | null }

export type StatusLine =
  | { kind: 'held'; text: string }
  | { kind: 'waiting'; text: string }
  | { kind: 'working'; text: string }
  | { kind: 'sent'; text: string }
  | null;

/**
 * What shows under a message (r50's table, r55's held row), from what Nebula
 * saw. `reply`: a reply from that agent after it (the row clears). `activity`:
 * the last event from the recipient's session (a cursor move, a say, an edit).
 */
export function messageStatus(row: ThreadRow, now: number, options: {
  replied: boolean;
  activity: SessionActivity | null;
}): StatusLine {
  if (row.kind !== 'message' || options.replied) return null;
  if (row.state === 'held') return { kind: 'held', text: HELD_LINE };
  const event = options.activity && options.activity.at >= row.at ? options.activity : null;
  if (event && now - event.at < WORKING_SETTLE_MS) {
    return { kind: 'working', text: event.line ? `${WORKING_LINE} · ${event.line}` : WORKING_LINE };
  }
  const since = Math.max(row.at, event?.at ?? 0);
  if (now - since >= QUIET_SENT_MS) return { kind: 'sent', text: SENT_LINE };
  if (row.state === 'accepted') return { kind: 'waiting', text: WAITING_LINE };
  return null;
}

/** When the line above may next change by itself (a timer, never polling the server). */
export function nextStatusChange(row: ThreadRow, now: number, activity: SessionActivity | null): number | null {
  if (row.kind !== 'message' || row.state === 'held') return null;
  const event = activity && activity.at >= row.at ? activity : null;
  const times = [Math.max(row.at, event?.at ?? 0) + QUIET_SENT_MS];
  if (event) times.push(event.at + WORKING_SETTLE_MS);
  const later = times.filter((t) => t > now);
  return later.length ? Math.min(...later) : null;
}

/** "About “Hero shot”", "… and “Sky”", "About 4 nodes" (r50, quotedNames' rule). */
export function contextChipLabel(names: readonly string[]): string {
  return `About ${quotedNames(names, 'nodes')}`;
}

export function contextRemoveLabel(names: readonly string[]): string {
  return names.length >= 2 ? 'Remove the nodes' : `Remove ${quotedNames(names, 'nodes')}`;
}

export function unreadLabel(count: number): string {
  return count === 1 ? '1 unread reply' : `${count} unread replies`;
}

export function actionsLabel(count: number): string {
  return count === 1 ? '1 action' : `${count} actions`;
}

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
  const response = await apiRequest("Couldn't send your message.", '/api/canvas/thread/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as { row?: unknown };
  const row = sanitizeRow(payload.row);
  if (!row) throw new RequestFailedError("Couldn't send your message.", 500, { detail: 'invalid answer' });
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

/** The composer's line for a failed send (r50's because form). */
export function failureLine(kind: SendFailure, error: unknown): string {
  if (kind === 'server') return SERVER_FAILED_LINE;
  if (kind === 'stopped') return LISTENER_DROPPED_LINE;
  return error instanceof Error && error.message ? error.message : SERVER_FAILED_LINE;
}

/** Whether a reply from this message's agent (and session, when both name one) came after it. */
export function repliedAfter(row: ThreadRow, rows: readonly ThreadRow[]): boolean {
  if (row.kind !== 'message' || !row.to) return false;
  const to = row.to;
  return rows.some((other) => other.kind === 'reply' && other.at >= row.at && other.agent?.id === to.agent.id
    && (!to.sessionKey || !other.sessionKey || other.sessionKey === to.sessionKey));
}

/** The counter's words, past MESSAGE_COUNTER_FROM left only. */
export function counterLine(length: number): string | null {
  const left = Math.max(0, MESSAGE_MAX - length);
  return left <= MESSAGE_COUNTER_FROM ? `${left} left` : null;
}

/** Spoken once as the draft reaches 30, 10 and 0 left (never each key). */
export function counterAnnouncement(lengthBefore: number, length: number): string | null {
  const before = MESSAGE_MAX - lengthBefore;
  const left = Math.max(0, MESSAGE_MAX - length);
  if (left >= before || !MESSAGE_ANNOUNCE_AT.some((mark) => before > mark && left <= mark)) return null;
  return `${left} ${left === 1 ? 'character' : 'characters'} left`;
}

/** The thread with the Agent log's actions folded between its rows (r50: "3 actions"). */
export type ThreadItem<E> = { kind: 'row'; row: ThreadRow } | { kind: 'actions'; id: string; entries: E[] };

export function foldActions<E extends { id: string; ts: number }>(rows: readonly ThreadRow[], entries: readonly E[]): ThreadItem<E>[] {
  const sorted = [...entries].sort((a, b) => a.ts - b.ts);
  const items: ThreadItem<E>[] = [];
  let next = 0;
  const flush = (before: number) => {
    const group: E[] = [];
    while (next < sorted.length && sorted[next].ts < before) group.push(sorted[next++]);
    if (group.length) items.push({ kind: 'actions', id: `actions-${group[0].id}`, entries: group });
  };
  for (const row of rows) {
    flush(row.at);
    items.push({ kind: 'row', row });
  }
  flush(Infinity);
  return items;
}
