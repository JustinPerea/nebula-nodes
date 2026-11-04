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
import { cursorLabel } from './agentCursorLabel';
import { MESSAGE_MAX, PRODUCT_LABEL, countsAsReply, type SessionActivity, type ThreadAgent, type ThreadRow } from './personThread';

/** "N left" shows from here (the composer's counter, PromptDialog's form). */
export const MESSAGE_COUNTER_FROM = 200;
/** Spoken past these only (GM r23 item 4, the PromptDialog rule). */
export const MESSAGE_ANNOUNCE_AT = [30, 10, 0] as const;
export const COPY_COMMAND = 'nebula mcp connect claude-code --channel';

/** One session's label when nothing names it (r61: one session is "Claude"). */
export const DEFAULT_SESSION_LABEL = 'Claude';
export { PRODUCT_LABEL } from './personThread';

// GM r50, r55 and r61, verbatim (curly quotes and apostrophes, the single …).
export const SENDING_LINE = 'Sending…';
export const SENT_LINE = 'Sent';
export const HELD_LINE = 'Sends in a few minutes because you’ve sent 200 this hour.';
export const NOT_CONNECTED_LINE = `Connect ${PRODUCT_LABEL} with the Nebula channel to message it here.`;
export const SERVER_FAILED_LINE = 'Nebula couldn’t send your message because the server isn’t answering. Try again.';
export const COPY_LABEL = 'Copy command';
export const COPIED_LINE = 'Copied the command';
export const NEW_REPLY_PILL = 'New reply';
/** GM r79.4: the pill names the newest unseen agent row addressed to the person
 * (a reply or a pin answer, countsAsReply's, reads NEW_REPLY_PILL). */
export const NEW_ROW_PILLS = {
  question: 'New question',
  proposal: 'New proposal',
  note: 'New note',
} as const satisfies Partial<Record<ThreadRow['kind'], string>>;
/** GM r79.5: a question whose outcome Nebula no longer knows. */
export const QUESTION_CLOSED_LINE = 'This question is closed.';
/** r61 answer 4: a question with no options is answered from the composer. */
export const ANSWER_LABEL = 'Answer';
export const ANSWERING_PREFIX = 'Answering';
/** The × on the "Answering “…”" chip (GM r70): the words then go as a plain message. */
export const ANSWERING_REMOVE_LABEL = 'Stop answering';

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

/** A message whose listener stopped beating but may come back to it: neutral, no resend offered. */
export function listenerLapsedLine(label: string = DEFAULT_SESSION_LABEL): string {
  return `${label} stopped listening. It’ll get this message if it reconnects from the same terminal.`;
}

/** GM r79.6: the question was withdrawn while the person typed its answer. */
export function withdrawnLine(label: string = DEFAULT_SESSION_LABEL): string {
  return `${label} withdrew the question. Send again to post your answer as a message every agent can read.`;
}

/** GM r89.3: answered or closed in another tab while the person typed its answer. */
export const ANSWERED_ELSEWHERE_LINE = 'You answered this question in another tab. Send again to post your text as a message every agent can read.';
export const CLOSED_ELSEWHERE_LINE = 'You closed this question in another tab. Send again to post your text as a message every agent can read.';

/** GM r94.1: a set this tab no longer holds (F13). True whatever the cause. */
export const GONE_ELSEWHERE_LINE = 'This question is closed. Send again to post your text as a message every agent can read.';

/** 'gone': the set went and this tab can't say why (GONE_ELSEWHERE_LINE). */
export type AnswerGoneCause = 'withdrawn' | 'answered' | 'closed' | 'gone';

/** Why a question set is no longer answerable, from its status. Null while
 * it is open, and for a set this tab no longer holds: Nebula doesn't know
 * why it went, so the caller falls back to 'gone', whose line claims no
 * cause (review 2, F13; GM r94.1). */
export function answerGoneCause(status: string | undefined): AnswerGoneCause | null {
  if (status === 'withdrawn') return 'withdrawn';
  if (status === 'answered') return 'answered';
  if (status === 'dismissed') return 'closed';
  return null;
}

/** The composer's line for that cause (the withdrawn one names the asker). */
export function answerGoneLine(gone: { cause: AnswerGoneCause; label: string }): string {
  if (gone.cause === 'answered') return ANSWERED_ELSEWHERE_LINE;
  if (gone.cause === 'closed') return CLOSED_ELSEWHERE_LINE;
  if (gone.cause === 'gone') return GONE_ELSEWHERE_LINE;
  return withdrawnLine(gone.label);
}

/** The pill's words for a row, or null for one that never raises it (the person's own, a fold). */
export function pillFor(row: ThreadRow): string | null {
  if (countsAsReply(row)) return NEW_REPLY_PILL;
  return (NEW_ROW_PILLS as Partial<Record<ThreadRow['kind'], string>>)[row.kind] ?? null;
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
// In personThread.ts (the store's module, already in the first load), so the
// shortcut sheet's "/" label reads the same source without pulling this
// module into the entry (GM r94.2). Re-exported here for the Message box.
export { availability, availabilityLabel, mostRecent, type Availability } from './personThread';


// -- a message's state ------------------------------------------------------------

export type StatusLine =
  | { kind: 'held'; text: string }
  | { kind: 'dropped'; text: string }
  | { kind: 'lapsed'; text: string }
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
  // Its listener's token was revoked before it took this (#225 review 2): never delivered.
  if (row.state === 'dropped') return { kind: 'dropped', text: listenerDroppedLine(options.label) };
  if (row.state === 'sent' && row.lapsed) return { kind: 'lapsed', text: listenerLapsedLine(options.label) };
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
  if (row.kind !== 'message' || row.state === 'held' || row.state === 'dropped' || row.lapsed) return null;
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

/** GM r94: a quoted answer that ends its line already ending in . ? or !
 * keeps its own mark, and the sentence drops its period:
 * "You answered “From the other tab.”", never "…tab.”.". */
export function closingPeriod(lastQuoted: string): string {
  return /[.?!]$/.test(lastQuoted.trimEnd()) ? '' : '.';
}

/** r61 answer 4: the quiet line an answered question row keeps.
 * "You chose “Only this one”." and "You chose “All three” and “Keep 1:1”.";
 * words typed from the composer read "You answered “…”." (GM r94: no
 * period after a quote that ends in its own mark, closingPeriod). */
export function answeredLine(answers: readonly { choices: readonly string[]; text: string | null }[]): string | null {
  const choices = answers.flatMap((answer) => answer.choices);
  if (choices.length > 0) return `You chose ${joinQuoted(choices)}${closingPeriod(choices[choices.length - 1])}`;
  const typed = typedAnswers(answers);
  return typed.length > 0 ? `You answered ${joinQuoted(typed)}${closingPeriod(typed[typed.length - 1])}` : null;
}

function typedAnswers(answers: readonly { text: string | null }[]): string[] {
  return answers.map((answer) => oneLine(answer.text ?? '')).filter(Boolean);
}

/**
 * GM r70: "You answered “…”." on one line, the words cut with the ellipsis
 * inside the curly quotes: the line in three parts, the middle one the part
 * the CSS cuts (the closing quote and the full stop always show). `after`
 * is for the whole words (GM r94: no period after their own . ? or !);
 * `afterCut` for words cut short, which end in the ellipsis, not a mark.
 * Null for a chosen answer, whose line is answeredLine's as it is.
 */
export function answeredQuote(answers: readonly { choices: readonly string[]; text: string | null }[]):
  { before: string; words: string; after: string; afterCut: string } | null {
  if (answers.some((answer) => answer.choices.length > 0)) return null;
  const typed = typedAnswers(answers);
  if (typed.length === 0) return null;
  // “A”, “B” and “C”, less its outer quotes.
  const joined = joinQuoted(typed);
  return { before: 'You answered “', words: joined.slice(1, -1), after: `”${closingPeriod(typed[typed.length - 1])}`,
    afterCut: '”.' };
}

/** The question on one line, for the composer's "Answering “…”" chip (cutAtWord cuts it to the width). */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Closing brackets and quotes with their openers. */
const OPENER_OF: Record<string, string> = { ')': '(', ']': '[', '}': '{', '”': '“', '’': '‘', '»': '«' };
/** Openers with their closers; straight quotes pair with themselves (review 2, NIT-1). */
const CLOSER_OF: Record<string, string> = { '(': ')', '[': ']', '{': '}', '“': '”', '‘': '’', '«': '»', '"': '"', "'": "'" };

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Where a ' or ’ sits: inside a word (an apostrophe: don’t, it's), at a word's start or at its end. */
function quoteEdge(text: string, i: number): 'inside' | 'start' | 'end' {
  const before = i > 0 && WORD_CHAR.test(text[i - 1]);
  const after = i + 1 < text.length && WORD_CHAR.test(text[i + 1]);
  if (before && after) return 'inside';
  return after ? 'start' : 'end';
}

/**
 * The brackets and quotes `text` leaves open, oldest first, and whether its
 * last character closed one of its own. `inside`: the opener the caller
 * writes before the words (the chip's “): it starts open, and closing it is
 * not closing one of the words' own.
 */
function scanPairs(text: string, inside?: string): { open: { ch: string; own: boolean }[]; lastClosedOwn: boolean } {
  const open = inside ? [{ ch: inside, own: false }] : [];
  let lastClosedOwn = false;
  const close = (opener: string): boolean => {
    for (let j = open.length - 1; j >= 0; j -= 1) {
      if (open[j].ch === opener) return open.splice(j, 1)[0].own;
    }
    return false;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    lastClosedOwn = false;
    if (ch === '"') {
      // Self-pairing: one already open closes, else it opens.
      if (open.some((entry) => entry.ch === '"')) lastClosedOwn = close('"');
      else open.push({ ch, own: true });
    } else if (ch === "'" || ch === '’') {
      // A quote only at a word's edge; inside a word it is an apostrophe.
      const edge = quoteEdge(text, i);
      if (edge === 'start' && ch === "'") open.push({ ch, own: true });
      else if (edge === 'end') lastClosedOwn = close(ch === "'" ? "'" : '‘');
    } else if (OPENER_OF[ch]) {
      lastClosedOwn = close(OPENER_OF[ch]);
    } else if (CLOSER_OF[ch]) {
      open.push({ ch, own: true });
    }
  }
  return { open, lastClosedOwn };
}

/** What a cut drops before its ellipsis: a trailing comma, space or other
 * punctuation, but never a closing bracket or quote whose opener is in the
 * words (review 1, NIT-2: “Use (see n4)…”, not “Use (see n4…”; review 2,
 * NIT-1: `Use the "warm"…`), nor a possessive apostrophe (“the dogs’…”). */
function cutTail(words: string, inside?: string): string {
  let out = words;
  for (;;) {
    const last = out.slice(-1);
    if (!last || !/[\s\p{P}]/u.test(last)) return out;
    if (OPENER_OF[last] || last === '"' || last === "'") {
      const scan = scanPairs(out, inside);
      // A closer for `inside` with none of its kind left open leaves the
      // caller's closer nothing to close: dropped, the caller's stands in
      // (“Warm”, “Cool…”., not “Warm”, “Cool”…”.).
      const callers = inside !== undefined && last === CLOSER_OF[inside] && !scan.open.some((entry) => entry.ch === inside);
      if (scan.lastClosedOwn && !callers) return out;
      // A ' or ’ at a word's end that closes no quote is a possessive
      // apostrophe, part of the word (review 3, NIT-1: “the dogs’…”).
      if (!scan.lastClosedOwn && (last === "'" || last === '’') && WORD_CHAR.test(out.slice(-2, -1))) return out;
    }
    out = out.slice(0, -1);
  }
}

/** The closers for what the cut words leave open, innermost first (GM r89.5:
 * “Hero…” keeps its closing quote). The caller's own closer (for `inside`)
 * closes the outermost of its kind, so that one is left to it. */
function closersFor(words: string, inside?: string): string {
  const { open } = scanPairs(words, inside);
  if (inside) {
    const outer = open.findIndex((entry) => entry.ch === inside);
    if (outer >= 0) open.splice(outer, 1);
  }
  return open.map((entry) => CLOSER_OF[entry.ch]).reverse().join('');
}

/**
 * GM r73: THE word-boundary cut, shared by the "Answering “…”" chip, "You
 * answered “…”." and the working fold (GM r89.5). The whole text when it
 * fits; else the longest run of whole words that fits with its ellipsis,
 * less any trailing comma, space or punctuation (“Use the same palette on
 * the other three shots…”, never “…shots, …”), then a closer for each
 * bracket or quote the kept words leave open (“Changed “Prompt” on “Hero…””).
 * `inside`: the opener the caller puts before the words (the chip's “); its
 * closer is the caller's, so the ellipsis sits inside it. `fits` says whether
 * a candidate fits (the box measures the element; tests count characters);
 * widths only grow with the words, so the boundaries are searched by
 * halving. When not even the first word fits, the first word and its
 * ellipsis; the CSS cut takes the rest.
 */
export function cutAtWord(text: string, fits: (candidate: string) => boolean, inside?: string): string {
  const whole = oneLine(text);
  if (whole === '' || fits(whole)) return whole;
  const candidates: string[] = [];
  for (const match of whole.matchAll(/\s/g)) {
    const words = cutTail(whole.slice(0, match.index), inside);
    if (words && words !== candidates[candidates.length - 1]) candidates.push(words);
  }
  // One long word: as it is (the CSS cut takes it).
  if (candidates.length === 0) return whole;
  const cut = (index: number) => `${candidates[index]}…${closersFor(candidates[index], inside)}`;
  let low = 0;
  let high = candidates.length - 1;
  let best = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (fits(cut(middle))) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return cut(best);
}

/** A cut's words and its tail (the ellipsis and any closers), or the words
 * whole with no tail when nothing was cut. */
export function cutParts(shown: string, text: string): { words: string; ellipsis: string } {
  const at = shown.lastIndexOf('…');
  return shown !== oneLine(text) && at >= 0 ? { words: shown.slice(0, at), ellipsis: shown.slice(at) } : { words: shown, ellipsis: '' };
}

// -- the typed answer's You row (GM r73 item 2) --------------------------------------

/**
 * A typed (no-option) answer, shown in the person's thread as a You row. It
 * is never a thread row: Justin's boundary rule (2026-11-03) lets every
 * connected agent read the thread, while an answer goes only to the agent
 * that asked (question.answered). So nothing stores or sends it: the person's
 * own tab derives it from the answered question set its questions store
 * already holds (questionsSync after a reload), placed at the set's
 * closedAt among the thread rows.
 */
export interface AnswerRow {
  id: string;
  questionId: string;
  at: number;
  text: string;
}

interface AnsweredSetLike {
  view: {
    status: string;
    closedAt: number | null;
    answers: readonly { choices: readonly string[]; text: string | null }[] | null;
  };
}

/** The You rows for the thread's question rows answered with words only (option picks get none). */
export function answerRows(rows: readonly ThreadRow[], sets: Readonly<Record<string, AnsweredSetLike | undefined>>): AnswerRow[] {
  const out: AnswerRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind !== 'question' || !row.questionId || seen.has(row.questionId)) continue;
    seen.add(row.questionId);
    // The set this tab holds, else the outcome kept with the row (GM r79.5: any reload).
    const view = sets[row.questionId]?.view ?? row.outcome;
    if (!view || view.status !== 'answered' || !view.answers || typeof view.closedAt !== 'number') continue;
    if (view.answers.some((answer) => answer.choices.length > 0)) continue;
    const typed = view.answers.map((answer) => (answer.text ?? '').trim()).filter(Boolean);
    if (typed.length === 0) continue;
    out.push({ id: `answer-${row.questionId}`, questionId: row.questionId, at: Math.max(view.closedAt, row.at), text: typed.join('\n\n') });
  }
  return out.sort((a, b) => a.at - b.at);
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

/** Whether a reply from this message's agent (and session, when both name one) came after it.
 * A reply that names the message it followed (`replyTo`, review 1 NIT-4)
 * clears that message and the ones before it, never a later one in flight;
 * one that names a question set (an answer push's reply) clears none. */
export function repliedAfter(row: ThreadRow, rows: readonly ThreadRow[]): boolean {
  if (row.kind !== 'message' || !row.to) return false;
  const to = row.to;
  return rows.some((other) => {
    if (other.kind !== 'reply' || other.at < row.at || other.agent?.id !== to.agent.id) return false;
    if (to.sessionKey && other.sessionKey && other.sessionKey !== to.sessionKey) return false;
    if (other.replyTo === undefined) return true;
    if (other.replyTo === null) return false;
    // Only a message it names clears (push ledger test 17): a reply to an
    // answer push names a question set id, and clears no message.
    const followed = rows.find((one) => one.id === other.replyTo && one.kind === 'message');
    return other.replyTo === row.id || (followed !== undefined && row.at < followed.at);
  });
}

/** The reply's first sentence, as its cursor says it (person_thread.first_sentence). */
export function firstSentence(text: string, limit = 140): string {
  let line = (text.split(/\r?\n/)[0] ?? '').split(/\s+/).filter(Boolean).join(' ');
  const end = line.search(/[.!?](?: |$)/);
  if (end >= 0) line = line.slice(0, end + 1);
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

/** How long after a reply its cursor's say may come. */
const ECHO_MS = 10_000;

/** GM r79.1: a session's "Replied on …" say matching its own reply row is no
 * action: never folded or counted (the Agent log's own list still has it).
 * GM r112.3: the same for a pin answer (resolve_pin): its cursor's say folds
 * into the pin reply row, never a trailing "1 action" after it. A pin reply
 * is about its pin's node, so it needs no nodeId of its own. */
export function isReplyEcho(entry: { ts: number; message?: string; agent?: { id: string; name: string } },
  rows: readonly ThreadRow[]): boolean {
  if (!entry.agent || !entry.message) return false;
  const agent = entry.agent;
  const message = entry.message;
  return rows.some((row) => ((row.kind === 'reply' && row.nodeId) || row.kind === 'pinReply')
    && row.agent?.id === agent.id
    && cursorLabel(row.agent.name, row.session ?? null) === agent.name
    && entry.ts >= row.at && entry.ts - row.at <= ECHO_MS
    && (firstSentence(row.text ?? '') === message || (row.kind === 'pinReply' && (row.text ?? '').trim() === message)));
}

/** The thread with the Agent log's actions folded between its rows (r50: "3 actions"),
 * and the person's typed answers (r73) placed by time among them. */
export type ThreadItem<E> =
  | { kind: 'row'; row: ThreadRow }
  | { kind: 'answer'; answer: AnswerRow }
  | { kind: 'actions'; id: string; entries: E[] };

export function foldActions<E extends { id: string; ts: number; message?: string; agent?: { id: string; name: string } }>(
  rows: readonly ThreadRow[], entries: readonly E[], answers: readonly AnswerRow[] = []): ThreadItem<E>[] {
  const sorted = entries.filter((entry) => !isReplyEcho(entry, rows)).sort((a, b) => a.ts - b.ts);
  const items: ThreadItem<E>[] = [];
  let next = 0;
  let nextAnswer = 0;
  const flush = (before: number) => {
    const group: E[] = [];
    while (next < sorted.length && sorted[next].ts < before) group.push(sorted[next++]);
    if (group.length) items.push({ kind: 'actions', id: `actions-${group[0].id}`, entries: group });
  };
  // An answer goes after every row at or before its time (its question first).
  const answersBefore = (before: number) => {
    while (nextAnswer < answers.length && answers[nextAnswer].at < before) {
      const answer = answers[nextAnswer++];
      flush(answer.at);
      items.push({ kind: 'answer', answer });
    }
  };
  for (const row of rows) {
    answersBefore(row.at);
    flush(row.at);
    items.push({ kind: 'row', row });
  }
  answersBefore(Infinity);
  flush(Infinity);
  return items;
}

/**
 * GM r79.3: what woke Claude on purpose, whose run gets the working fold
 * under it: a message, a pin note row, a typed answer's You row, or the
 * question card for an option pick. Passive wakes (edits, finished runs)
 * have none: their actions fold as plain "N actions". `agent` (and
 * `sessionKey`) is the session whose work and reply it waits on; a pin
 * reaches every listener, so any session's (null).
 */
export interface RunOrigin {
  id: string;
  kind: 'message' | 'pin' | 'answer' | 'question';
  at: number;
  row: ThreadRow | null;
  agent: ThreadAgent | null;
  session: ThreadRow['session'];
  sessionKey: string | null;
}

/** The latest deliberate wake still waiting on its reply, or null. */
export function runOrigin(rows: readonly ThreadRow[], answers: readonly AnswerRow[],
  sets: Readonly<Record<string, AnsweredSetLike | undefined>> = {}): RunOrigin | null {
  let best: RunOrigin | null = null;
  const consider = (origin: RunOrigin) => { if (!best || origin.at >= best.at) best = origin; };
  const questionRow = (id: string) => rows.find((row) => row.kind === 'question' && row.questionId === id) ?? null;
  for (const row of rows) {
    if (row.kind === 'message') {
      consider({ id: row.id, kind: 'message', at: row.at, row, agent: row.to?.agent ?? null,
        session: row.to?.session ?? null, sessionKey: row.to?.sessionKey ?? null });
    } else if (row.kind === 'pin') {
      consider({ id: row.id, kind: 'pin', at: row.at, row, agent: null, session: null, sessionKey: null });
    } else if (row.kind === 'question' && row.questionId) {
      const view = sets[row.questionId]?.view ?? row.outcome;
      if (view?.status === 'answered' && typeof view.closedAt === 'number'
        && (view.answers ?? []).some((answer) => answer.choices.length > 0)) {
        consider({ id: row.id, kind: 'question', at: Math.max(view.closedAt, row.at), row, agent: row.agent ?? null,
          session: row.session ?? null, sessionKey: row.sessionKey ?? null });
      }
    }
  }
  for (const answer of answers) {
    const asked = answer.questionId ? questionRow(answer.questionId) : null;
    consider({ id: answer.id, kind: 'answer', at: answer.at, row: asked, agent: asked?.agent ?? null,
      session: asked?.session ?? null, sessionKey: asked?.sessionKey ?? null });
  }
  const origin = best as RunOrigin | null;
  if (!origin) return null;
  if (origin.kind === 'message') {
    return origin.row && (origin.row.state === 'dropped' || repliedAfter(origin.row, rows)) ? null : origin;
  }
  // Answered: a reply (or, for a pin, its reply on the pin) from that session after it.
  const answered = rows.some((row) => row.at >= origin.at
    && (row.kind === 'reply' || (origin.kind === 'pin' && row.kind === 'pinReply' && row.pinId === origin.row?.pinId))
    && (!origin.agent || (row.agent?.id === origin.agent.id
      && (!origin.sessionKey || !row.sessionKey || row.sessionKey === origin.sessionKey))));
  return answered ? null : origin;
}

/** The working line for a run that isn't a message's (a pin, an answer):
 * only what Nebula saw, an event from that session (any, for a pin) since. */
export function originStatus(origin: RunOrigin, now: number, activity: Readonly<Record<string, SessionActivity>>,
  label?: string): StatusLine {
  const events = origin.sessionKey ? [activity[origin.sessionKey]] : Object.values(activity);
  const event = events.filter((one): one is SessionActivity => Boolean(one) && one.at >= origin.at)
    .sort((a, b) => b.at - a.at)[0];
  return event && now - event.at < WORKING_SETTLE_MS ? { kind: 'working', text: workingLine(label, event.line) } : null;
}

/** When originStatus may next change by itself. */
export function nextOriginChange(origin: RunOrigin, now: number, activity: Readonly<Record<string, SessionActivity>>): number | null {
  const events = origin.sessionKey ? [activity[origin.sessionKey]] : Object.values(activity);
  const ends = events.filter((one): one is SessionActivity => Boolean(one) && one.at >= origin.at)
    .map((one) => one.at + WORKING_SETTLE_MS).filter((t) => t > now);
  return ends.length ? Math.min(...ends) : null;
}

/**
 * r61 A: the thread's items with the run's fold marked. While the latest
 * message waits on its session (or the session works on it), the actions
 * after the last row are that run's, and the status row is their fold's
 * header; with no actions yet, the status row stands alone at the end. The
 * fold keeps its id when the reply lands, so it stays open or shut as the
 * person left it, then reads "1 action" above the reply.
 */
export type RunItem<E> = ThreadItem<E> | { kind: 'run'; id: string; origin: RunOrigin; entries: E[] };

export function withRun<E extends { id: string; ts: number }>(items: readonly ThreadItem<E>[], run: RunOrigin | null): RunItem<E>[] {
  if (!run) return [...items];
  const last = items[items.length - 1];
  if (last && last.kind === 'actions' && last.entries.every((entry) => entry.ts >= run.at)) {
    return [...items.slice(0, -1), { kind: 'run', id: last.id, origin: run, entries: last.entries }];
  }
  return [...items, { kind: 'run', id: `run-${run.id}`, origin: run, entries: [] }];
}
