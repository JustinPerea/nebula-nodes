/**
 * The Message box's words, states and folds (GM - Design r50, r55, r61):
 * the pure parts only the deferred box (components/panels/MessageBox.tsx)
 * reads, so they load with the Agent log's chunk, not the app's entry
 * (r61's budget). The rows, the listeners and the send live in
 * lib/personThread.ts, which the eager store needs.
 *
 * Every state comes from something Nebula saw (the request in flight, the
 * listener's push or hold, an event from that session, a reply, a timer),
 * never from a read receipt.
 *
 * Names (r61 answer 3): the product is named literally ("Connect Claude
 * Code…"); anything about one session uses its cursor label ("Waiting for
 * Claude · 2"). With one session the label is "Claude".
 */
import { quotedNames } from './errorCopy';
import { MESSAGE_MAX, type ChannelListener, type SessionActivity, type ThreadRow } from './personThread';

/** "N left" shows from here (the composer's counter, PromptDialog's form). */
export const MESSAGE_COUNTER_FROM = 200;
/** Spoken past these only (GM r23 item 4, the PromptDialog rule). */
export const MESSAGE_ANNOUNCE_AT = [30, 10, 0] as const;
export const COPY_COMMAND = 'nebula mcp connect claude-code --channel';

/** One session's label when nothing names it (r61: one session is "Claude"). */
export const DEFAULT_SESSION_LABEL = 'Claude';

// GM r50, r55 and r61, verbatim (curly quotes and apostrophes, the single …).
export const SENDING_LINE = 'Sending…';
export const SENT_LINE = 'Sent';
export const HELD_LINE = 'Sends in a few minutes because you’ve sent 200 this hour.';
export const NOT_CONNECTED_LINE = 'Connect Claude Code with the Nebula channel to message it here.';
export const SERVER_FAILED_LINE = 'Nebula couldn’t send your message because the server isn’t answering. Try again.';
export const COPY_LABEL = 'Copy command';
export const COPIED_LINE = 'Copied the command';
export const NEW_REPLY_PILL = 'New reply';
/** r61 answer 4: a question with no options is answered from the composer. */
export const ANSWER_LABEL = 'Answer';
export const ANSWERING_PREFIX = 'Answering';
export const ANSWERING_REMOVE_LABEL = 'Remove';

/** "Waiting for Claude · 2" (r61: the session's cursor label). */
export function waitingLine(label: string = DEFAULT_SESSION_LABEL): string {
  return `Waiting for ${label}`;
}

/** "Claude · 2 is working", with its latest action line after " · ". */
export function workingLine(label: string = DEFAULT_SESSION_LABEL, line?: string | null): string {
  return line ? `${label} is working · ${line}` : `${label} is working`;
}

export function stoppedListeningLine(label: string = DEFAULT_SESSION_LABEL): string {
  return `${label} stopped listening. Reconnect nebula-listen with /mcp in its terminal to message it here.`;
}

export function listenerDroppedLine(label: string = DEFAULT_SESSION_LABEL): string {
  return `Nebula couldn’t send your message because ${label} stopped listening. Reconnect it in the terminal, then send it again.`;
}

/** The one-session forms (r50's words, unchanged with one session). */
export const WAITING_LINE = waitingLine();
export const WORKING_LINE = workingLine();
export const STOPPED_LISTENING_LINE = stoppedListeningLine();
export const LISTENER_DROPPED_LINE = listenerDroppedLine();

/** "Waiting…" and "working" settle: back to waiting after this with no event (the cursor's dim). */
export const WORKING_SETTLE_MS = 20_000;
/** "Sent" after this with nothing back. */
export const QUIET_SENT_MS = 60_000;

// -- availability ----------------------------------------------------------------

export type Availability =
  | { kind: 'ready'; recipient: ChannelListener; listening: ChannelListener[] }
  | { kind: 'notConnected' }
  | { kind: 'stopped'; listener: ChannelListener }
  | { kind: 'offline' };

/** Which line locks the composer, if any. Offline wins (the app's row says it). */
export function availability(listeners: readonly ChannelListener[], offline: boolean,
  chosen: string | null, lastSeen: Readonly<Record<string, number>>): Availability {
  if (offline) return { kind: 'offline' };
  const listening = listeners.filter((entry) => entry.state === 'listening');
  if (listening.length === 0) {
    // The session that stopped last is the one the line names.
    return listeners.length === 0 ? { kind: 'notConnected' } : { kind: 'stopped', listener: mostRecent(listeners, lastSeen) };
  }
  const picked = chosen ? listening.find((entry) => entry.listenerId === chosen) : undefined;
  return { kind: 'ready', recipient: picked ?? mostRecent(listening, lastSeen), listening };
}

/** The listening session that was active most recently: its last cursor event, else when it started listening. */
export function mostRecent(listening: readonly ChannelListener[], lastSeen: Readonly<Record<string, number>>): ChannelListener {
  const active = (entry: ChannelListener) => Math.max(entry.since, entry.sessionKey ? lastSeen[entry.sessionKey] ?? 0 : 0);
  return [...listening].sort((a, b) => active(b) - active(a) || b.since - a.since)[0];
}

// -- a message's state ------------------------------------------------------------

export type StatusLine =
  | { kind: 'held'; text: string }
  | { kind: 'waiting'; text: string }
  | { kind: 'working'; text: string }
  | { kind: 'sent'; text: string }
  | null;

/**
 * What shows for a message (r50's table, r55's held row), from what Nebula
 * saw. `replied`: a reply from that agent after it (the row clears).
 * `activity`: the last event from the recipient's session (a cursor move, a
 * say, an edit). `label`: the recipient's cursor label (r61).
 */
export function messageStatus(row: ThreadRow, now: number, options: {
  replied: boolean;
  activity: SessionActivity | null;
  label?: string;
}): StatusLine {
  if (row.kind !== 'message' || options.replied) return null;
  if (row.state === 'held') return { kind: 'held', text: HELD_LINE };
  const event = options.activity && options.activity.at >= row.at ? options.activity : null;
  if (event && now - event.at < WORKING_SETTLE_MS) {
    return { kind: 'working', text: workingLine(options.label, event.line) };
  }
  const since = Math.max(row.at, event?.at ?? 0);
  if (now - since >= QUIET_SENT_MS) return { kind: 'sent', text: SENT_LINE };
  if (row.state === 'accepted') return { kind: 'waiting', text: waitingLine(options.label) };
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

/** Whether a status leads its run's fold (r61 A): while the session works on
 * the message or waits on it, the status row is the fold's header, so the
 * newest thing is the last row. "Sent" and the held line stay under the
 * message: they are settled, not news. */
export function statusLeadsRun(status: StatusLine): boolean {
  return status !== null && (status.kind === 'working' || status.kind === 'waiting');
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

/** “A”, “A” and “B”, “A”, “B” and “C”: every one named (an answer is never counted). */
export function joinQuoted(words: readonly string[]): string {
  const quoted = words.map((word) => `“${word}”`);
  return quoted.length <= 1 ? (quoted[0] ?? '') : `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
}

/** r61 answer 4: the quiet line an answered question row keeps.
 * "You chose “Only this one”." and "You chose “All three” and “Keep 1:1”.";
 * words typed from the composer read "You answered “…”." */
export function answeredLine(answers: readonly { choices: readonly string[]; text: string | null }[]): string | null {
  const choices = answers.flatMap((answer) => answer.choices);
  if (choices.length > 0) return `You chose ${joinQuoted(choices)}.`;
  const typed = answers.map((answer) => answer.text?.trim() ?? '').filter(Boolean);
  return typed.length > 0 ? `You answered ${joinQuoted(typed)}.` : null;
}

/** The question on one line, for the composer's "Answering “…”" chip (CSS cuts it to the width). */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The counter's words, past MESSAGE_COUNTER_FROM left only. */
export function counterLine(length: number, max: number = MESSAGE_MAX): string | null {
  const left = Math.max(0, max - length);
  return left <= MESSAGE_COUNTER_FROM ? `${left} left` : null;
}

/** Spoken once as the draft reaches 30, 10 and 0 left (never each key). */
export function counterAnnouncement(lengthBefore: number, length: number, max: number = MESSAGE_MAX): string | null {
  const before = max - lengthBefore;
  const left = Math.max(0, max - length);
  if (left >= before || !MESSAGE_ANNOUNCE_AT.some((mark) => before > mark && left <= mark)) return null;
  return `${left} ${left === 1 ? 'character' : 'characters'} left`;
}

/** Whether a reply from this message's agent (and session, when both name one) came after it. */
export function repliedAfter(row: ThreadRow, rows: readonly ThreadRow[]): boolean {
  if (row.kind !== 'message' || !row.to) return false;
  const to = row.to;
  return rows.some((other) => other.kind === 'reply' && other.at >= row.at && other.agent?.id === to.agent.id
    && (!to.sessionKey || !other.sessionKey || other.sessionKey === to.sessionKey));
}

/** The message whose run is going on: the latest one with no reply yet (r61 A). */
export function runMessage(rows: readonly ThreadRow[]): ThreadRow | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === 'message') return repliedAfter(row, rows) ? null : row;
  }
  return null;
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

/**
 * r61 A: the thread's items with the run's fold marked. While the latest
 * message waits on its session (or the session works on it), the actions
 * after the last row are that run's, and the status row is their fold's
 * header; with no actions yet, the status row stands alone at the end. The
 * fold keeps its id when the reply lands, so it stays open or shut as the
 * person left it, then reads "1 action" above the reply.
 */
export type RunItem<E> = ThreadItem<E> | { kind: 'run'; id: string; message: ThreadRow; entries: E[] };

export function withRun<E extends { id: string; ts: number }>(items: readonly ThreadItem<E>[], run: ThreadRow | null): RunItem<E>[] {
  if (!run) return [...items];
  const last = items[items.length - 1];
  if (last && last.kind === 'actions' && last.entries.every((entry) => entry.ts >= run.at)) {
    return [...items.slice(0, -1), { kind: 'run', id: last.id, message: run, entries: last.entries }];
  }
  return [...items, { kind: 'run', id: `run-${run.id}`, message: run, entries: [] }];
}
