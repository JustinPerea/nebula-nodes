import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { AutoGrowTextarea } from '../AutoGrowTextarea';
import { ScrollFade } from '../ScrollFade';
import { AgentLogEntryRow } from './AgentLogEntryRow';
import { OFFLINE_LINE_ID } from '../BackendConnectionStatus';
import { useMessageAvailability, usePersonThreadStore, type AnsweringState, type PendingSend } from '../../store/personThreadStore';
import { SENDING_AFTER_MS, sendMessage, setDraft } from '../../lib/personThreadCompose';
import { ANSWER_TEXT_MAX, useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import { useGraphStore } from '../../store/graphStore';
import type { AgentLogEntry } from '../../store/agentLogStore';
import { useCanvasLock } from '../../lib/canvasLock';
import { cursorLabel, type SessionLike } from '../../lib/agentCursorLabel';
import { AGENT_FALLBACK_COLOR, agentLogTones } from '../../lib/agentCursorColor';
import { cardTitle } from '../../lib/worldLabsWaiting';
import { isCanvasShortcutTarget } from '../../lib/canvasShortcutScope';
import { springScrollTo } from '../../lib/scrollSpring';
import {
  MESSAGE_MAX,
  PIN_SHOW_EVENT,
  UPDATES_OPEN_EVENT,
  type ChannelListener,
  type ThreadAgent,
  type ThreadRow,
} from '../../lib/personThread';
import {
  ANSWERING_PREFIX,
  ANSWERING_REMOVE_LABEL,
  ANSWER_LABEL,
  COPIED_LINE,
  COPY_COMMAND,
  COPY_LABEL,
  NOT_CONNECTED_LINE,
  QUESTION_CLOSED_LINE,
  SENDING_LINE,
  SERVER_FAILED_LINE,
  actionsLabel,
  answerRows,
  answeredLine,
  answeredQuote,
  contextChipLabel,
  contextRemoveLabel,
  counterAnnouncement,
  counterLine,
  cutAtWord,
  cutParts,
  foldActions,
  listenerDroppedLine,
  messageStatus,
  nextOriginChange,
  nextStatusChange,
  oneLine,
  originStatus,
  pillFor,
  repliedAfter,
  runOrigin,
  statusLeadsRun,
  stoppedListeningLine,
  unreadLabel,
  withRun,
  answerGoneCause,
  answerGoneLine,
  availabilityLabel,
  type AnswerRow,
  type RunOrigin,
  type Availability,
  type StatusLine,
} from '../../lib/personThreadBox';
import '../../styles/messageBox.css';


const SAFE_COLOR = /^#[0-9a-fA-F]{6}$/;
const COPIED_MS = 2_000;

function tones(agent: ThreadAgent | undefined, session: SessionLike | null | undefined) {
  return agentLogTones(agent && SAFE_COLOR.test(agent.color) ? agent.color : AGENT_FALLBACK_COLOR, session ?? null);
}

function agentLabel(agent: ThreadAgent | undefined, session: SessionLike | null | undefined): string {
  return agent ? cursorLabel(agent.name, session ?? null) : 'Claude';
}

function shade(agent: ThreadAgent | undefined, session: SessionLike | null | undefined): CSSProperties {
  const tone = tones(agent, session);
  return { ['--msg-dot' as string]: tone.dot, ['--msg-name' as string]: tone.name };
}

function nodeNameList(ids: readonly string[]) {
  return (s: { nodes: { id: string; data?: { label?: unknown } }[] }) => ids.map((id) => cardTitle(s.nodes, id)).join('\u0000');
}

function useNodeNames(ids: readonly string[]): string[] {
  const joined = useGraphStore(nodeNameList(ids));
  return useMemo(() => (joined ? joined.split('\u0000') : []), [joined]);
}

/** A row's one-line words for the collapsed preview. */
function previewWords(row: ThreadRow, nodeName: (id: string) => string): { label: string; text: string } {
  const name = agentLabel(row.agent, row.session);
  switch (row.kind) {
    case 'message': return { label: 'You', text: row.text ?? '' };
    case 'reply': return { label: name, text: row.text ?? '' };
    case 'question': return { label: `${name} asks`, text: row.questions?.[0]?.text ?? '' };
    case 'proposal': return { label: name, text: 'proposed a change' };
    case 'note': return { label: name, text: 'left a note in Updates' };
    case 'pin': return { label: 'You', text: `left a note ${pinWhere(row, nodeName)}` };
    // GM r94: the collapsed log reads "Claude Code replied to your note".
    case 'pinReply': return { label: name, text: 'replied to your note' };
  }
}

function pinWhere(row: ThreadRow, nodeName: (id: string) => string): string {
  return row.nodeId ? `on “${nodeName(row.nodeId)}”` : 'on the canvas';
}

function useNodeName(): (id: string) => string {
  const nodes = useGraphStore((s) => s.nodes);
  return (id: string) => cardTitle(nodes, id);
}

/** GM r73 item 2: the person's typed answers, derived in this tab from the
 * question sets it holds (never a thread row: lib/personThreadBox answerRows). */
function useAnswerRows(rows: readonly ThreadRow[]): AnswerRow[] {
  const sets = useAgentQuestionsStore((s) => s.sets);
  return useMemo(() => answerRows(rows, sets), [rows, sets]);
}

/**
 * GM r73 item 3: words cut at a word boundary to their element's one line
 * (cutAtWord, the one cut the "Answering “…”" chip and "You answered “…”."
 * share). The element is a flex item that may shrink (min-width 0, overflow
 * hidden): with every word in it, its box is as wide as the line lets it be.
 * Each candidate's words are then written into its text node and measured
 * with a Range (fractional px: whole-px scroll widths round a fitting cut
 * out), and the text put back before the paint. The ellipsis renders after
 * the element, not in it (cutParts): Chrome lays out "s…" 0.42 px narrower
 * than it paints, so inside the element its own CSS ellipsis would take the
 * last letter; the room is the element's with every word in it plus that
 * ellipsis, if one shows. Measured again when `container` changes size
 * (the observer's first call too). Where nothing lays out (no widths), the
 * words show whole.
 */
function useWordCut(ref: RefObject<HTMLSpanElement | null>, text: string, container: string, inside?: string): string {
  const [shown, setShown] = useState(() => oneLine(text));
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const whole = oneLine(text);
      const node = element.firstChild;
      const range = typeof document.createRange === 'function' ? document.createRange() : null;
      if (!(node instanceof Text) || !range || typeof range.getBoundingClientRect !== 'function') {
        setShown(whole);
        return;
      }
      // A cut shown now has its ellipsis (and closers) after the element: that space is the cut's too.
      const tail = element.nextSibling;
      let tailWidth = 0;
      if (tail instanceof Text && tail.nodeValue?.startsWith('…')) {
        range.selectNodeContents(tail);
        tailWidth = range.getBoundingClientRect().width;
      }
      const before = node.nodeValue;
      node.nodeValue = whole;
      const room = element.getBoundingClientRect().width + tailWidth;
      const width = (candidate: string) => {
        node.nodeValue = candidate;
        range.selectNodeContents(node);
        return range.getBoundingClientRect().width;
      };
      // A cut's words in the element, its ellipsis and closers beside it: the two together within the room.
      const fits = (candidate: string) => {
        const parts = cutParts(candidate, whole);
        return (parts.ellipsis ? width(parts.words) + width(parts.ellipsis) : width(candidate)) <= room + 0.01;
      };
      const cut = room > 0 ? cutAtWord(whole, fits, inside) : whole;
      node.nodeValue = before;
      setShown(cut);
    };
    measure();
    const box = element.closest(container) ?? element.parentElement;
    if (!box || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => measure());
    observer.observe(box);
    return () => observer.disconnect();
  }, [ref, text, container, inside]);
  return shown;
}

// -- the collapsed bar's preview line ------------------------------------------------

export function MessagePreview() {
  const rows = usePersonThreadStore((s) => s.rows);
  const unread = usePersonThreadStore((s) => s.unread);
  const pending = usePersonThreadStore((s) => s.pending);
  const nodeName = useNodeName();
  const answers = useAnswerRows(rows);
  const latest = rows[rows.length - 1];
  const latestAnswer = answers[answers.length - 1];
  // A typed answer after the last row is the latest thing (r73).
  const answerLast = latestAnswer && (!latest || latestAnswer.at >= latest.at) ? latestAnswer : null;
  if (pending || answerLast) {
    return (
      <div className="message-box__preview" data-person="">
        <span className="message-box__preview-name">You</span>
        <span className="message-box__preview-text">{pending ? pending.text : answerLast?.text}</span>
        {unread > 0 && <span className="message-box__badge" aria-label={unreadLabel(unread)} role="img">{unread}</span>}
      </div>
    );
  }
  if (!latest) return null;
  const words = previewWords(latest, nodeName);
  const person = latest.kind === 'message' || latest.kind === 'pin';
  return (
    <div className="message-box__preview" style={person ? undefined : shade(latest.agent, latest.session)}
      data-person={person || undefined}>
      {!person && <span className="message-box__dot" aria-hidden="true" />}
      <span className="message-box__preview-name">{words.label}</span>
      <span className="message-box__preview-text">{words.text}</span>
      {unread > 0 && <span className="message-box__badge" aria-label={unreadLabel(unread)} role="img">{unread}</span>}
    </div>
  );
}

// -- the expanded thread --------------------------------------------------------------

function useNow(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 5);
    return () => window.clearTimeout(timer);
  }, [until, now]);
  return now;
}

/** A message's state line (r50's table) under its recipient's cursor label (r61). */
function useMessageStatus(row: ThreadRow | null, rows: readonly ThreadRow[]): StatusLine {
  const key = row?.to?.sessionKey ?? null;
  const activity = usePersonThreadStore((s) => (key ? s.activity[key] ?? null : null));
  const [until, setUntil] = useState<number | null>(null);
  const now = useNow(until);
  if (!row) {
    if (until !== null) setUntil(null);
    return null;
  }
  const replied = repliedAfter(row, rows);
  const next = replied ? null : nextStatusChange(row, now, activity);
  if (next !== until) setUntil(next);
  return messageStatus(row, now, { replied, activity, label: agentLabel(row.to?.agent, row.to?.session) });
}

function StatusView({ status, row, origin }: { status: StatusLine; row?: ThreadRow; origin?: RunOrigin }) {
  if (!status) return null;
  const style = origin ? shade(origin.agent ?? undefined, origin.session) : shade(row?.to?.agent, row?.to?.session);
  return (
    <div className={`message-box__status message-box__status--${status.kind}`} style={style}>
      {(status.kind === 'waiting' || status.kind === 'working') && <span className="message-box__breath" aria-hidden="true" />}
      <span>{status.text}</span>
    </div>
  );
}

function MessageStatus({ row, rows }: { row: ThreadRow; rows: readonly ThreadRow[] }) {
  return <StatusView status={useMessageStatus(row, rows)} row={row} />;
}

/** GM r79.3: the working line of a run a pin or an answer started (a
 * message's is useMessageStatus's). Only working: Nebula never sees whether
 * a pin or an answer was taken, so there is no "Waiting". */
function useOriginStatus(origin: RunOrigin | null): { status: StatusLine; who: RunOrigin | null } {
  const activity = usePersonThreadStore((s) => s.activity);
  const listeners = usePersonThreadStore((s) => s.listeners);
  const [until, setUntil] = useState<number | null>(null);
  const now = useNow(until);
  const live = origin && origin.kind !== 'message' ? origin : null;
  const next = live ? nextOriginChange(live, now, activity) : null;
  if (next !== until) setUntil(next);
  if (!live) return { status: null, who: null };
  // A pin reaches every listener: the line names (and is shaded as) the session that acted.
  let who = live;
  if (!live.agent) {
    const acted = listeners.filter((entry) => entry.sessionKey && (activity[entry.sessionKey]?.at ?? 0) >= live.at)
      .sort((a, b) => (activity[b.sessionKey ?? '']?.at ?? 0) - (activity[a.sessionKey ?? '']?.at ?? 0))[0];
    if (acted) who = { ...live, agent: acted.agent, session: acted.session };
  }
  return { status: originStatus(live, now, activity, who.agent ? agentLabel(who.agent, who.session) : undefined), who };
}

function ShowButton({ onShow, label = 'Show', disabled = false }: { onShow: () => void; label?: string; disabled?: boolean }) {
  return (
    <button type="button" className="message-box__show" onClick={onShow} aria-disabled={disabled || undefined}
      title={disabled ? 'It’s closed' : undefined}>
      {label}
    </button>
  );
}

function QuestionRow({ row }: { row: ThreadRow }) {
  const entry = useAgentQuestionsStore((s) => (row.questionId ? s.sets[row.questionId] : undefined));
  const drafts = useAgentQuestionsStore((s) => (row.questionId ? s.drafts[row.questionId] : undefined));
  const busy = useAgentQuestionsStore((s) => (row.questionId ? s.busy[row.questionId] : false));
  const error = useAgentQuestionsStore((s) => (row.questionId ? s.errors[row.questionId] : undefined));
  const answeringHere = usePersonThreadStore((s) => Boolean(row.questionId && s.answering?.setId === row.questionId));
  const questions = entry?.view.questions ?? row.questions ?? [];
  const open = entry?.view.status === 'open' && Boolean(entry.answerKey);
  // GM r79.5: the set this tab holds, else the outcome kept with the row, so
  // "You chose …" survives any reload.
  const closed = entry && entry.view.status !== 'open' ? entry.view : row.outcome;
  // r61 answer 4: once answered, the row drops its buttons for a quiet line.
  const answered = closed?.status === 'answered' ? answeredLine(closed.answers ?? []) : null;
  // GM r70: typed words on one line, cut inside their curly quotes.
  const typed = closed?.status === 'answered' ? answeredQuote(closed.answers ?? []) : null;
  // GM r79.5: not open and no answer known (withdrawn, dismissed, or an
  // outcome Nebula no longer has): no buttons, the neutral line.
  const shut = !open && !answered;
  // One single-choice question: a click is the answer (r50's mock). Anything
  // more keeps its picks until Send, as the Agents panel's form does.
  const oneClick = questions.length === 1 && !questions[0].multiple && questions[0].options.length > 0;
  // r61 answer 4: one question with no options is answered from the composer.
  // A set that mixes one with others keeps the Agents panel's form.
  const fromComposer = questions.length === 1 && questions[0].options.length === 0;
  const needsForm = !fromComposer && questions.some((question) => question.options.length === 0);
  const setId = row.questionId ?? '';
  function pick(questionId: string, option: string) {
    if (!open || busy) return;
    const store = useAgentQuestionsStore.getState();
    store.toggleChoice(setId, questionId, option);
    if (oneClick) void store.send(setId);
  }
  return (
    <div className="message-box__card" style={shade(row.agent, row.session)}>
      <div className="message-box__who"><span className="message-box__dot" aria-hidden="true" />{agentLabel(row.agent, row.session)} asks</div>
      {questions.map((question) => {
        const picked = open ? drafts?.[question.id]?.choices ?? [] : closed?.answers?.find((a) => a.questionId === question.id)?.choices ?? [];
        return (
          <div key={question.id} className="message-box__question" role="group" aria-label={question.text}>
            <p className="message-box__text">{question.text}</p>
            {!answered && !shut && question.options.length > 0 && (
              <div className="message-box__options">
                {question.options.map((option) => (
                  <button key={option} type="button" className="message-box__option"
                    aria-pressed={picked.includes(option)} aria-disabled={!open || busy || undefined}
                    onClick={() => pick(question.id, option)}>
                    {option}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {answered && (typed
        ? <TypedAnswerLine before={typed.before} words={typed.words} after={typed.after} afterCut={typed.afterCut} />
        : <p className="message-box__answered">{answered}</p>)}
      {shut && <p className="message-box__answered">{QUESTION_CLOSED_LINE}</p>}
      {open && fromComposer && (
        <button type="button" className="message-box__show" aria-pressed={answeringHere}
          onClick={() => usePersonThreadStore.getState().answer({ setId, questionId: questions[0].id, question: questions[0].text })}>
          {ANSWER_LABEL}
        </button>
      )}
      {open && needsForm && (
        <button type="button" className="message-box__show"
          onClick={() => {
            // Words beside choices: the Agents panel's form takes them (the Updates list holds it).
            window.dispatchEvent(new CustomEvent(UPDATES_OPEN_EVENT));
            useAgentQuestionsStore.getState().openForm(setId);
          }}>
          {ANSWER_LABEL}
        </button>
      )}
      {open && !oneClick && !needsForm && !fromComposer && (
        <button type="button" className="message-box__show" aria-disabled={busy || undefined}
          onClick={() => { if (!busy) void useAgentQuestionsStore.getState().send(setId); }}>
          Send answers
        </button>
      )}
      {error && <p className="message-box__line message-box__line--failed">{error}</p>}
    </div>
  );
}

/** GM r70/r73: "You answered “…”." on one line, the words cut at a word inside
 * the quotes. GM r94: whole words that end in . ? or ! take no period after
 * the quote; cut words end in the ellipsis, so the period stays. */
function TypedAnswerLine({ before, words, after, afterCut }: { before: string; words: string; after: string; afterCut: string }) {
  const wordsRef = useRef<HTMLSpanElement | null>(null);
  const cut = cutParts(useWordCut(wordsRef, words, '.message-box__answered--typed', '“'), words);
  return (
    <p className="message-box__answered message-box__answered--typed">
      {before}<span ref={wordsRef} className="message-box__answered-words">{cut.words}</span>{cut.ellipsis}{cut.ellipsis ? afterCut : after}
    </p>
  );
}

/** GM r73 item 2: the person's typed answer as a You row (display only; see answerRows). */
function AnswerRowView({ answer }: { answer: AnswerRow }) {
  return (
    <div className="message-box__row message-box__row--you" data-answer="">
      <div className="message-box__who">You</div>
      <p className="message-box__text">{answer.text}</p>
    </div>
  );
}

function RowView({ row, rows, nodeName, inRun }: {
  row: ThreadRow;
  rows: readonly ThreadRow[];
  nodeName: (id: string) => string;
  /** The run's status leads its fold at the end of the thread (r61 A). */
  inRun: boolean;
}) {
  const proposalOpen = useCanvasProposalsStore((s) => Boolean(row.proposalId && s.proposals[row.proposalId]));
  const name = agentLabel(row.agent, row.session);
  switch (row.kind) {
    case 'message':
      return (
        <div className="message-box__row message-box__row--you">
          <div className="message-box__who">You</div>
          <p className="message-box__text">{row.text}</p>
          {!inRun && <MessageStatus row={row} rows={rows} />}
        </div>
      );
    case 'reply':
      return (
        <div className="message-box__row" style={shade(row.agent, row.session)}>
          <div className="message-box__who"><span className="message-box__dot" aria-hidden="true" />{name}</div>
          <p className="message-box__text">{row.text}</p>
        </div>
      );
    case 'question':
      return <QuestionRow row={row} />;
    case 'proposal':
      return (
        <div className="message-box__row message-box__row--ref" style={shade(row.agent, row.session)}>
          <div className="message-box__who"><span className="message-box__dot" aria-hidden="true" />{name} proposed a change</div>
          {/* The card stays the only place to Accept or Reject (r50). */}
          <ShowButton disabled={!proposalOpen}
            onShow={() => { if (row.proposalId && proposalOpen) useCanvasProposalsStore.getState().focus(row.proposalId); }} />
        </div>
      );
    case 'note':
      return (
        <div className="message-box__row message-box__row--ref" style={shade(row.agent, row.session)}>
          <div className="message-box__who"><span className="message-box__dot" aria-hidden="true" />{name} left a note in Updates</div>
          <ShowButton onShow={() => window.dispatchEvent(new CustomEvent(UPDATES_OPEN_EVENT, { detail: { noteId: row.noteId } }))} />
        </div>
      );
    case 'pin':
    case 'pinReply':
      return (
        <div className="message-box__row message-box__row--ref"
          style={row.kind === 'pinReply' ? shade(row.agent, row.session) : undefined}>
          <div className="message-box__who">
            {row.kind === 'pinReply' && <span className="message-box__dot" aria-hidden="true" />}
            {row.kind === 'pin' ? `You left a note ${pinWhere(row, nodeName)}` : `${name} replied to your note${row.nodeId ? ` ${pinWhere(row, nodeName)}` : ''}`}
          </div>
          {row.text && <p className="message-box__text">{row.text}</p>}
          <ShowButton onShow={() => window.dispatchEvent(new CustomEvent(PIN_SHOW_EVENT, { detail: { pinId: row.pinId } }))} />
        </div>
      );
  }
}

/**
 * The actions between two rows, folded: "3 actions" (r50). r61 A: the run
 * going on now leads with its status ("› Claude is working · Cooler sky"),
 * which opens to that run's actions; when the reply lands it settles to
 * "› 1 action" above the reply, keeping its place and whether it was open.
 */
function ActionsFold({ entries, status, origin }: { entries: AgentLogEntry[]; status?: StatusLine; origin?: RunOrigin }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const lead = status && statusLeadsRun(status) ? status : null;
  // GM r89.5: the chip's one line cut at a word by the shared cut, its closers kept ("on “Hero…”").
  const wordsRef = useRef<HTMLSpanElement | null>(null);
  const text = lead ? lead.text : actionsLabel(entries.length);
  const cut = cutParts(useWordCut(wordsRef, text, '.message-box__actions'), text);
  if (entries.length === 0) {
    // The run's status with nothing to fold yet: the last row on its own.
    return lead && origin ? <StatusView status={lead} origin={origin} /> : null;
  }
  return (
    <div className="message-box__actions">
      {/* GM r70: the same bordered chip working and settled; only its words
          and the breathing dot change, so settling never moves the row. */}
      <button type="button" className="message-box__fold"
        aria-expanded={open} aria-controls={listId}
        style={lead && origin ? shade(origin.agent ?? undefined, origin.session) : undefined}
        onClick={() => setOpen((value) => !value)}>
        <ChevronRight className="message-box__fold-icon" size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" />
        {lead && <span className="message-box__breath" aria-hidden="true" />}
        <span className="message-box__fold-text">
          <span ref={wordsRef} className="message-box__fold-words">{cut.words}</span>{cut.ellipsis}
        </span>
      </button>
      {open && (
        <ul id={listId} className="agent-log__list message-box__action-list">
          {entries.map((entry) => <AgentLogEntryRow key={entry.id} entry={entry} />)}
        </ul>
      )}
    </div>
  );
}

/** The tab's own send until it settles: "Sending…" after 300 ms (keyed by the send, so each starts hidden). */
function PendingRow({ pending }: { pending: PendingSend }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), Math.max(0, pending.startedAt + SENDING_AFTER_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pending]);
  return (
    <div className="message-box__row message-box__row--you message-box__row--enter" data-pending="">
      <div className="message-box__who">You</div>
      <p className="message-box__text">{pending.text}</p>
      {shown && <div className="message-box__status message-box__status--sending">{SENDING_LINE}</div>}
    </div>
  );
}

const AT_BOTTOM_PX = 24;

export function MessageThread({ entries }: { entries: AgentLogEntry[] }) {
  const rows = usePersonThreadStore((s) => s.rows);
  const pending = usePersonThreadStore((s) => s.pending);
  const nodeName = useNodeName();
  const scroller = useRef<HTMLElement | null>(null);
  const list = useRef<HTMLOListElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  // The same, for the resize observer below (it reads it outside render).
  const pinned = useRef(true);
  const [pill, setPill] = useState<{ id: string; label: string } | null>(null);
  // The size at the last scroll event: a scroll the reflow caused (a narrower
  // window rewraps the rows) never unpins a thread read at the bottom (live-ux L2).
  const size = useRef({ height: 0, client: 0 });
  const answers = useAnswerRows(rows);
  const sets = useAgentQuestionsStore((s) => s.sets);
  // Rows here when the panel opened just are; later ones enter on the spring.
  const [firstIds] = useState(() => new Set([...rows.map((row) => row.id), ...answers.map((answer) => answer.id)]));
  // The tab's own send shows as its pending row until it settles.
  const shownRows = useMemo(() => rows.filter((row) => !(pending && row.clientId === pending.clientId)), [rows, pending]);
  // GM r79.3: every deliberate wake (a message, a pin, an answer) gets the working fold.
  const run = useMemo(() => runOrigin(shownRows, answers, sets), [shownRows, answers, sets]);
  const messageStatusLine = useMessageStatus(run?.kind === 'message' ? run.row : null, shownRows);
  const other = useOriginStatus(run);
  const runStatus = run?.kind === 'message' ? messageStatusLine : other.status;
  const runWho = run?.kind === 'message' ? run : other.who;
  // r61 A: while the run's session works on it (or, for a message, it waits
  // on it), its status leads the run's fold at the end, so the newest thing is last.
  const leads = statusLeadsRun(runStatus);
  const items = useMemo(() => {
    const folded = foldActions(shownRows, entries.filter((entry) => entry.source === 'agent'), answers);
    return withRun(folded, leads ? runWho : null);
  }, [shownRows, entries, runWho, leads, answers]);
  const lastRow = shownRows[shownRows.length - 1];
  const lastAnswer = answers[answers.length - 1];
  const answerIsLast = Boolean(lastAnswer && (!lastRow || lastAnswer.at >= lastRow.at));
  const lastId = answerIsLast ? lastAnswer.id : lastRow?.id ?? '';
  // GM r79.4: the pill only for agent rows addressed to the person (replies,
  // questions, proposals, Updates notes), naming the newest unseen; never
  // the person's own rows, their answers or a fold.
  const newest = useMemo(() => [...shownRows].reverse().find((row) => pillFor(row) !== null) ?? null, [shownRows]);
  const [seenNewest, setSeenNewest] = useState(newest?.id ?? '');
  if (seenNewest !== (newest?.id ?? '')) {
    setSeenNewest(newest?.id ?? '');
    if (!atBottom && newest) setPill({ id: newest.id, label: pillFor(newest) ?? '' });
  }

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
    if (element) size.current = { height: element.scrollHeight, client: element.clientHeight };
  }, []);

  // GM r100.2: the person's own send always brings the thread to their sent
  // row (the newest, with any failure line under it), on the scroll spring
  // (a jump under reduced motion), wherever they had scrolled. The pill
  // stays for agent rows only. Pinned from the start, so the row's state
  // line and a failure line growing under it stay in view.
  // Declared before r50's jump below, so a send's commit springs and never jumps.
  const springing = useRef<(() => void) | null>(null);
  const sending = pending?.clientId ?? null;
  const [seenSending, setSeenSending] = useState(sending);
  if (seenSending !== sending) {
    setSeenSending(sending);
    if (sending !== null) {
      setAtBottom(true);
      setPill(null);
    }
  }
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || sending === null) return;
    pinned.current = true;
    springing.current?.();
    let landed = false;
    const stop = springScrollTo(element, () => element.scrollHeight - element.clientHeight, () => {
      landed = true;
      springing.current = null;
      size.current = { height: element.scrollHeight, client: element.clientHeight };
    });
    // A jump (reduced motion) has landed already: nothing is springing.
    springing.current = landed ? null : stop;
  }, [sending]);
  useEffect(() => () => springing.current?.(), []);

  // r50: new rows scroll into view only when the thread is already at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current;
    // While the send's spring runs it reaches the bottom itself (r100.2).
    if (element && atBottom && !springing.current) element.scrollTop = element.scrollHeight;
    if (element) size.current = { height: element.scrollHeight, client: element.clientHeight };
  }, [lastId, pending, atBottom]);

  // A row that grows (its state line, an opened "3 actions") or a thread that
  // shrinks (the composer's chip, the panel's spring) keeps a thread read at
  // the bottom at the bottom.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (pinned.current && !springing.current) element.scrollTop = element.scrollHeight;
      size.current = { height: element.scrollHeight, client: element.clientHeight };
    });
    observer.observe(element);
    if (list.current) observer.observe(list.current);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const element = scroller.current;
    if (!element || springing.current) return;  // the spring moves it, not the person
    const resized = size.current.height > 0
      && (element.scrollHeight !== size.current.height || element.clientHeight !== size.current.client);
    size.current = { height: element.scrollHeight, client: element.clientHeight };
    if (pinned.current && resized) {
      // The reflow moved it, not the person: keep it at the bottom.
      element.scrollTop = element.scrollHeight;
      return;
    }
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX;
    pinned.current = bottom;
    setAtBottom(bottom);
    if (bottom) setPill(null);
  }

  // GM r79.4: the pill jumps to the row it names.
  function jumpTo(id: string) {
    const element = scroller.current;
    if (!element) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const target = element.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
    } else {
      element.scrollTo({ top: element.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    }
    setPill(null);
  }

  return (
    <div className="message-box__thread-wrap">
      <ScrollFade ref={scroller} className="agent-log__body message-box__thread" onScroll={onScroll}>
        <ol ref={list} className="message-box__rows" aria-label="Messages with Claude">
          {items.map((item) => (
            <li key={item.kind === 'row' ? item.row.id : item.kind === 'answer' ? item.answer.id : item.id}
              data-row-id={item.kind === 'row' ? item.row.id : undefined}
              className={(item.kind === 'row' && !firstIds.has(item.row.id)) || (item.kind === 'answer' && !firstIds.has(item.answer.id))
                ? 'message-box__item message-box__row--enter' : 'message-box__item'}>
              {item.kind === 'row'
                ? <RowView row={item.row} rows={shownRows} nodeName={nodeName}
                  inRun={leads && run?.kind === 'message' && item.row.id === run.id} />
                : item.kind === 'answer'
                  ? <AnswerRowView answer={item.answer} />
                  : item.kind === 'run'
                    ? <ActionsFold entries={item.entries} status={runStatus} origin={item.origin} />
                    : <ActionsFold entries={item.entries} />}
            </li>
          ))}
          {pending && <li className="message-box__item"><PendingRow key={pending.clientId} pending={pending} /></li>}
        </ol>
      </ScrollFade>
      {pill && (
        <button type="button" className="message-box__pill" onClick={() => jumpTo(pill.id)}>{pill.label}</button>
      )}
    </div>
  );
}

// -- the composer ------------------------------------------------------------------------

function RecipientChip({ state }: { state: Extract<Availability, { kind: 'ready' }> }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const wrap = useRef<HTMLDivElement | null>(null);
  const recipient = state.recipient;
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as globalThis.Node | null)) setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  function pick(entry: ChannelListener) {
    usePersonThreadStore.getState().choose(entry.listenerId);
    setOpen(false);
  }
  return (
    <div className="message-box__recipient" ref={wrap}>
      <button type="button" className="message-box__recipient-chip" style={shade(recipient.agent, recipient.session)}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? menuId : undefined}
        aria-label={`To ${agentLabel(recipient.agent, recipient.session)}. Choose who gets it`}
        onClick={() => setOpen((value) => !value)}>
        <span className="message-box__dot" aria-hidden="true" />
        <span className="message-box__recipient-name">{agentLabel(recipient.agent, recipient.session)}</span>
      </button>
      {open && (
        <div id={menuId} role="menu" className="message-box__menu"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>
          {state.listening.map((entry) => (
            <button key={entry.listenerId} type="button" role="menuitemradio"
              aria-checked={entry.listenerId === recipient.listenerId} className="message-box__menu-item"
              style={shade(entry.agent, entry.session)} onClick={() => pick(entry)}>
              <span className="message-box__dot" aria-hidden="true" />
              {agentLabel(entry.agent, entry.session)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function CopyCommand() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);
  async function copy() {
    try {
      // The command only: the token stays in the file it names (never the clipboard).
      await navigator.clipboard.writeText(COPY_COMMAND);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <>
      <button type="button" className="message-box__show" onClick={() => void copy()}>{COPY_LABEL}</button>
      <span className="message-box__copied" aria-live="polite">{copied ? COPIED_LINE : ''}</span>
    </>
  );
}

/** The composer's live region: "Claude replied. <text>", once per reply. */
function ReplyAnnouncer() {
  const announcement = usePersonThreadStore((s) => s.announcement);
  const [spoken, setSpoken] = useState<{ id: string; text: string } | null>(null);
  const [seen] = useState(() => announcement?.id ?? null);
  if (announcement && announcement.id !== seen && announcement.id !== spoken?.id) setSpoken(announcement);
  return <div className="message-box__announce" aria-live="polite" aria-atomic="true">{spoken?.text ?? ''}</div>;
}

/** The asking agent's cursor label, from its question row. */
function askerLabel(setId: string): string {
  const asked = usePersonThreadStore.getState().rows.find((row) => row.kind === 'question' && row.questionId === setId);
  return agentLabel(asked?.agent, asked?.session);
}

/** The listener's cursor label, by id (a send's recipient may have gone). */
function listenerLabel(listeners: readonly ChannelListener[], listenerId: string | null | undefined): string {
  const entry = listenerId ? listeners.find((one) => one.listenerId === listenerId) : undefined;
  return entry ? agentLabel(entry.agent, entry.session) : 'Claude';
}

/** r61 answer 4: "Answering “<the question on one line>”", with × Remove. */
function AnsweringChip({ answering }: { answering: AnsweringState }) {
  // GM r73: cut at a word, the ellipsis inside the quotes (the shared cut).
  const quoteRef = useRef<HTMLSpanElement | null>(null);
  const cut = cutParts(useWordCut(quoteRef, answering.question, '.message-box__composer', '“'), answering.question);
  return (
    <div className="message-box__context message-box__context--answering">
      <span className="message-box__context-label">
        {ANSWERING_PREFIX} “<span ref={quoteRef} className="message-box__context-quote">{cut.words}</span>{cut.ellipsis}”
      </span>
      <button type="button" className="message-box__context-remove" aria-label={ANSWERING_REMOVE_LABEL}
        onClick={() => usePersonThreadStore.getState().stopAnswering()}>
        <X size={11} strokeWidth={1.75} aria-hidden="true" focusable="false" />
      </button>
    </div>
  );
}

export function MessageComposer({ expanded }: { expanded: boolean }) {
  const draft = usePersonThreadStore((s) => s.draft);
  const contextIds = usePersonThreadStore((s) => s.contextIds);
  const pending = usePersonThreadStore((s) => s.pending);
  const failure = usePersonThreadStore((s) => s.failure);
  const listeners = usePersonThreadStore((s) => s.listeners);
  const answering = usePersonThreadStore((s) => s.answering);
  const answerGone = usePersonThreadStore((s) => s.answerGone);
  // The question still open here (answered elsewhere, the chip goes).
  const answerOpen = useAgentQuestionsStore((s) => {
    const entry = answering ? s.sets[answering.setId] : undefined;
    return Boolean(entry && entry.view.status === 'open' && entry.answerKey);
  });
  // Why it went: withdrawn, answered or closed (none for a set this tab no longer holds: 'gone').
  const goneCause = useAgentQuestionsStore((s) => answerGoneCause(answering ? s.sets[answering.setId]?.view.status : undefined));
  const answerBusy = useAgentQuestionsStore((s) => Boolean(answering && s.busy[answering.setId]));
  const state = useMessageAvailability();
  const names = useNodeNames(contextIds);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const lineId = useId();
  const counterId = useId();
  const [focused, setFocused] = useState(false);
  const [announced, setAnnounced] = useState('');
  const [lengthBefore, setLengthBefore] = useState(draft.length);
  // Answering a question takes its own limit (an answer's words), not a message's.
  const answeringNow = answering && answerOpen ? answering : null;
  const max = answeringNow ? ANSWER_TEXT_MAX : MESSAGE_MAX;
  if (lengthBefore !== draft.length) {
    setLengthBefore(draft.length);
    const words = counterAnnouncement(lengthBefore, draft.length, max);
    if (words) setAnnounced(words);
    else if (counterLine(draft.length, max) === null && announced) setAnnounced('');
  }

  // The sets this tab closed itself: a send or a dismiss (the composer's or
  // the Agents panel's) in flight as the set closed. Those get no "another
  // tab" line; the composer's own send says what happened (sendAnswer).
  const closedHere = useRef(new Set<string>());
  useEffect(() => useAgentQuestionsStore.subscribe((next, previous) => {
    for (const [id, entry] of Object.entries(next.sets)) {
      if (entry.view.status !== 'open' && previous.sets[id]?.view.status === 'open' && previous.busy[id]) closedHere.current.add(id);
    }
  }), []);

  // The chip goes, the draft stays. GM r79.6, r89.3: withdrawn, or answered or
  // closed in another tab while the person typed, the composer names why, and
  // the next Enter only says so (answerGone.held): the one after posts the
  // words as a message. A set this tab no longer holds holds the same way,
  // with a line true whatever the cause (GM r94.1, F13): typed answer text
  // never goes out as a public message on one silent Enter. Answered or
  // closed from this tab: no line.
  useEffect(() => {
    if (!answering || answerOpen) return;
    const store = usePersonThreadStore.getState();
    store.stopAnswering();
    if (closedHere.current.has(answering.setId) || !store.draft.trim()) return;
    usePersonThreadStore.setState({ answerGone: { cause: goneCause ?? 'gone', label: askerLabel(answering.setId), held: true } });
  }, [answering, answerOpen, goneCause]);

  // "Answer" on a question row brings the person here (r61 answer 4).
  const answeringId = answeringNow?.questionId ?? null;
  useEffect(() => {
    if (!answeringId) return;
    returnTo.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement : null;
    field.current?.focus();
  }, [answeringId]);

  const { offline } = useCanvasLock();
  const ready = state.kind === 'ready';
  // An answer goes to the question, not to a listener: only offline locks it.
  const live = answeringNow ? !offline : ready;
  // GM r89.4: one label for the field and the lock line, as the agent's rows name it.
  const agentName = availabilityLabel(state);
  const label = `Message ${agentName}`;
  const counter = counterLine(draft.length, max);
  // r61 answer 3: the product by name, a session by its cursor label.
  const lockLine = answeringNow ? null
    : state.kind === 'notConnected' ? NOT_CONNECTED_LINE
      : state.kind === 'stopped' ? stoppedListeningLine(agentName) : null;
  const failureText = answeringNow || !failure ? null
    : failure.kind === 'server' ? SERVER_FAILED_LINE
      : failure.kind === 'stopped' ? listenerDroppedLine(listenerLabel(listeners, failure.to))
        : failure.line ?? SERVER_FAILED_LINE;
  // GM r79.6, r89.3: neutral, until the words go or the draft is cleared.
  const goneText = !answeringNow && answerGone && draft.trim() ? answerGoneLine(answerGone) : null;
  const lineText = lockLine ?? failureText ?? goneText;
  // Offline: the app's own row says it (the house pattern), no line here.
  const described = [state.kind === 'offline' ? OFFLINE_LINE_ID : lineText ? lineId : null, counter ? counterId : null]
    .filter(Boolean).join(' ') || undefined;
  const canSend = answeringNow
    ? live && !answerBusy && draft.trim().length > 0 && draft.length <= max
    : ready && !pending && draft.trim().length > 0 && draft.length <= MESSAGE_MAX;

  // r50: "/" focuses the composer from anywhere on the canvas, unless a text field has focus.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      if (!isCanvasShortcutTarget(event.target)) return;
      event.preventDefault();
      returnTo.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
        ? document.activeElement : null;
      field.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  async function sendAnswer(target: AnsweringState) {
    const text = usePersonThreadStore.getState().draft.trim();
    const questions = useAgentQuestionsStore.getState();
    questions.setText(target.setId, target.questionId, text);
    // A failure shows on the question's row (its own line); the words stay here.
    if (await questions.send(target.setId)) {
      usePersonThreadStore.setState((current) => (current.draft.trim() === text
        ? { draft: '', contextIds: [], answering: null, answerGone: null } : { answering: null, answerGone: null }));
      return;
    }
    // GM r79.6's race: the set closed first (withdrawn, or answered or closed
    // in another tab) and nothing went out. The line names why; this Enter
    // was the one that showed it, so the next one posts.
    const status = useAgentQuestionsStore.getState().sets[target.setId]?.view.status;
    if (status === 'open') return; // still open: its failure shows on the question's row
    const cause = answerGoneCause(status) ?? 'gone';
    usePersonThreadStore.setState((current) => ({ answering: null,
      answerGone: current.draft.trim() ? { cause, label: askerLabel(target.setId), held: false } : null }));
  }

  function send() {
    if (!canSend) return;
    if (answeringNow) {
      void sendAnswer(answeringNow);
      return;
    }
    if (state.kind !== 'ready') return;
    // GM r89.3: the first Enter after the chip went only says why (the line,
    // spoken); the next posts the words as a message.
    if (goneText && answerGone?.held) {
      usePersonThreadStore.setState({ answerGone: { ...answerGone, held: false } });
      setAnnounced(goneText);
      return;
    }
    usePersonThreadStore.setState({ answerGone: null });
    void sendMessage(state.recipient.listenerId);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      // The draft stays; focus goes back where it came from.
      const back = returnTo.current;
      returnTo.current = null;
      field.current?.blur();
      if (back && back.isConnected) back.focus({ preventScroll: true });
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  function selectedIds(): string[] {
    return useGraphStore.getState().nodes.filter((node) => node.selected).map((node) => node.id);
  }

  return (
    <div className={`message-box__composer${expanded ? ' message-box__composer--expanded' : ''}`}>
      {answeringNow && <AnsweringChip answering={answeringNow} />}
      {!answeringNow && contextIds.length > 0 && (
        <div className="message-box__context">
          <span className="message-box__context-label">{contextChipLabel(names)}</span>
          <button type="button" className="message-box__context-remove" aria-label={contextRemoveLabel(names)}
            onClick={() => usePersonThreadStore.getState().removeContext()}>
            <X size={11} strokeWidth={1.75} aria-hidden="true" focusable="false" />
          </button>
        </div>
      )}
      {/* r61 B: locked, its chrome dims as the locked opener's does (messageBox.css). */}
      <div className="message-box__field-row" data-locked={!live || undefined}>
        {!answeringNow && ready && state.listening.length >= 2 && <RecipientChip state={state} />}
        <AutoGrowTextarea
          textareaRef={field}
          className="message-box__field"
          rows={1}
          value={draft}
          placeholder={label}
          aria-label={label}
          aria-disabled={!live || undefined}
          aria-describedby={described}
          maxLength={max}
          readOnly={false}
          onChange={(event) => {
            setDraft(event.target.value, answeringNow ? undefined : selectedIds);
            // A cleared draft is a new start: no line, no held Enter.
            if (!event.target.value.trim() && answerGone) usePersonThreadStore.setState({ answerGone: null });
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {draft.trim() || focused || expanded ? (
          <button type="button" className="message-box__send" aria-disabled={!canSend || undefined} onClick={send}>Send</button>
        ) : (
          <kbd className="message-box__key" aria-hidden="true">/</kbd>
        )}
      </div>
      {lineText && state.kind !== 'offline' && (
        <div className={`message-box__line${failureText && !lockLine ? ' message-box__line--failed' : ''}`}>
          <span id={lineId}>{lineText}</span>
          {state.kind === 'notConnected' && !answeringNow && <CopyCommand />}
          {!lockLine && failure?.kind === 'server' && (
            <button type="button" className="message-box__show" aria-disabled={!canSend || undefined} onClick={send}>Try again</button>
          )}
        </div>
      )}
      {counter && <span id={counterId} className="message-box__counter">{counter}</span>}
      <span className="message-box__announce" aria-live="polite" aria-atomic="true">{announced}</span>
      <ReplyAnnouncer />
    </div>
  );
}
