import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ChevronRight, X } from 'lucide-react';
import { AutoGrowTextarea } from '../AutoGrowTextarea';
import { ScrollFade } from '../ScrollFade';
import { AgentLogEntryRow } from './AgentLogEntryRow';
import { OFFLINE_LINE_ID } from '../BackendConnectionStatus';
import { usePersonThreadStore, type PendingSend } from '../../store/personThreadStore';
import { useAgentQuestionsStore } from '../../store/agentQuestionsStore';
import { useCanvasProposalsStore } from '../../store/canvasProposalsStore';
import { useGraphStore } from '../../store/graphStore';
import type { AgentLogEntry } from '../../store/agentLogStore';
import { useCanvasLock } from '../../lib/canvasLock';
import { cursorLabel, type SessionLike } from '../../lib/agentCursorLabel';
import { AGENT_FALLBACK_COLOR, agentLogTones } from '../../lib/agentCursorColor';
import { cardTitle } from '../../lib/worldLabsWaiting';
import { isCanvasShortcutTarget } from '../../lib/canvasShortcutScope';
import {
  COPIED_LINE,
  COPY_COMMAND,
  COPY_LABEL,
  MESSAGE_MAX,
  NEW_REPLY_PILL,
  NOT_CONNECTED_LINE,
  PIN_SHOW_EVENT,
  UPDATES_OPEN_EVENT,
  SENDING_AFTER_MS,
  SENDING_LINE,
  STOPPED_LISTENING_LINE,
  actionsLabel,
  availability,
  contextChipLabel,
  contextRemoveLabel,
  counterAnnouncement,
  counterLine,
  foldActions,
  messageStatus,
  nextStatusChange,
  repliedAfter,
  unreadLabel,
  type Availability,
  type ChannelListener,
  type ThreadAgent,
  type ThreadRow,
} from '../../lib/personThread';
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

/** Which listener gets the message, and whether the composer is locked. */
function useAvailability(): Availability {
  const listeners = usePersonThreadStore((s) => s.listeners);
  const chosen = usePersonThreadStore((s) => s.chosen);
  const activity = usePersonThreadStore((s) => s.activity);
  // The house rule (round22Surfaces): offline comes from the canvas lock.
  const { offline } = useCanvasLock();
  return useMemo(() => {
    const lastSeen = Object.fromEntries(Object.entries(activity).map(([key, value]) => [key, value.at]));
    return availability(listeners, offline, chosen, lastSeen);
  }, [listeners, offline, chosen, activity]);
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
    case 'pinReply': return { label: name, text: `replied on your note ${pinWhere(row, nodeName)}` };
  }
}

function pinWhere(row: ThreadRow, nodeName: (id: string) => string): string {
  return row.nodeId ? `on “${nodeName(row.nodeId)}”` : 'on the canvas';
}

function useNodeName(): (id: string) => string {
  const nodes = useGraphStore((s) => s.nodes);
  return (id: string) => cardTitle(nodes, id);
}

// -- the collapsed bar's preview line ------------------------------------------------

export function MessagePreview() {
  const rows = usePersonThreadStore((s) => s.rows);
  const unread = usePersonThreadStore((s) => s.unread);
  const pending = usePersonThreadStore((s) => s.pending);
  const nodeName = useNodeName();
  const latest = rows[rows.length - 1];
  if (pending) {
    return (
      <div className="message-box__preview" data-person="">
        <span className="message-box__preview-name">You</span>
        <span className="message-box__preview-text">{pending.text}</span>
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

function MessageStatus({ row, rows }: { row: ThreadRow; rows: readonly ThreadRow[] }) {
  const key = row.to?.sessionKey ?? null;
  const activity = usePersonThreadStore((s) => (key ? s.activity[key] ?? null : null));
  const [until, setUntil] = useState<number | null>(null);
  const now = useNow(until);
  const replied = repliedAfter(row, rows);
  const status = messageStatus(row, now, { replied, activity });
  const next = replied ? null : nextStatusChange(row, now, activity);
  if (next !== until) setUntil(next);
  if (!status) return null;
  return (
    <div className={`message-box__status message-box__status--${status.kind}`} style={shade(row.to?.agent, row.to?.session)}>
      {(status.kind === 'waiting' || status.kind === 'working') && <span className="message-box__breath" aria-hidden="true" />}
      <span>{status.text}</span>
    </div>
  );
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
  const questions = entry?.view.questions ?? row.questions ?? [];
  const open = entry?.view.status === 'open' && Boolean(entry.answerKey);
  const answers = entry?.view.answers ?? null;
  // One single-choice question: a click is the answer (r50's mock). Anything
  // more keeps its picks until Send, as the Agents panel's form does.
  // (A question that also takes words keeps them for the Agents panel's form.)
  const oneClick = questions.length === 1 && !questions[0].multiple && questions[0].options.length > 0;
  const needsForm = questions.some((question) => question.options.length === 0);
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
        const picked = open ? drafts?.[question.id]?.choices ?? [] : answers?.find((a) => a.questionId === question.id)?.choices ?? [];
        return (
          <div key={question.id} className="message-box__question" role="group" aria-label={question.text}>
            <p className="message-box__text">{question.text}</p>
            {question.options.length > 0 && (
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
      {open && needsForm && (
        <button type="button" className="message-box__show"
          onClick={() => {
            // Words only: the Agents panel's form takes them (the Updates list holds it).
            window.dispatchEvent(new CustomEvent(UPDATES_OPEN_EVENT));
            useAgentQuestionsStore.getState().openForm(setId);
          }}>
          Answer
        </button>
      )}
      {open && !oneClick && !needsForm && (
        <button type="button" className="message-box__show" aria-disabled={busy || undefined}
          onClick={() => { if (!busy) void useAgentQuestionsStore.getState().send(setId); }}>
          Send answers
        </button>
      )}
      {error && <p className="message-box__line message-box__line--failed">{error}</p>}
    </div>
  );
}

function RowView({ row, rows, nodeName }: { row: ThreadRow; rows: readonly ThreadRow[]; nodeName: (id: string) => string }) {
  const proposalOpen = useCanvasProposalsStore((s) => Boolean(row.proposalId && s.proposals[row.proposalId]));
  const name = agentLabel(row.agent, row.session);
  switch (row.kind) {
    case 'message':
      return (
        <div className="message-box__row message-box__row--you">
          <div className="message-box__who">You</div>
          <p className="message-box__text">{row.text}</p>
          <MessageStatus row={row} rows={rows} />
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
            {row.kind === 'pin' ? `You left a note ${pinWhere(row, nodeName)}` : `${name} replied on your note ${pinWhere(row, nodeName)}`}
          </div>
          {row.text && <p className="message-box__text">{row.text}</p>}
          <ShowButton onShow={() => window.dispatchEvent(new CustomEvent(PIN_SHOW_EVENT, { detail: { pinId: row.pinId } }))} />
        </div>
      );
  }
}

function ActionsRow({ entries }: { entries: AgentLogEntry[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="message-box__actions">
      <button type="button" className="message-box__fold" aria-expanded={open} aria-controls={listId}
        onClick={() => setOpen((value) => !value)}>
        <ChevronRight className="message-box__fold-icon" size={12} strokeWidth={1.75} aria-hidden="true" focusable="false" />
        {actionsLabel(entries.length)}
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
  const [pill, setPill] = useState(false);
  // Rows here when the panel opened just are; later ones enter on the spring.
  const [firstIds] = useState(() => new Set(rows.map((row) => row.id)));
  // The tab's own send shows as its pending row until it settles.
  const shownRows = useMemo(() => rows.filter((row) => !(pending && row.clientId === pending.clientId)), [rows, pending]);
  const items = useMemo(() => foldActions(shownRows, entries.filter((entry) => entry.source === 'agent')), [shownRows, entries]);
  const lastId = shownRows[shownRows.length - 1]?.id ?? '';
  // r50: a new row while the person reads further up shows "New reply" instead of scrolling.
  const [seenLastId, setSeenLastId] = useState(lastId);
  if (seenLastId !== lastId) {
    setSeenLastId(lastId);
    if (!atBottom && lastId) setPill(true);
  }

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, []);

  // r50: new rows scroll into view only when the thread is already at the bottom.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom) element.scrollTop = element.scrollHeight;
  }, [lastId, pending, atBottom]);

  // A row that grows (its state line, an opened "3 actions") or a thread that
  // shrinks (the composer's chip, the panel's spring) keeps a thread read at
  // the bottom at the bottom.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      if (pinned.current) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    if (list.current) observer.observe(list.current);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    const bottom = element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX;
    pinned.current = bottom;
    setAtBottom(bottom);
    if (bottom) setPill(false);
  }

  function jumpDown() {
    const element = scroller.current;
    if (!element) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    element.scrollTo({ top: element.scrollHeight, behavior: reduce ? 'auto' : 'smooth' });
    pinned.current = true;
    setAtBottom(true);
    setPill(false);
  }

  return (
    <div className="message-box__thread-wrap">
      <ScrollFade ref={scroller} className="agent-log__body message-box__thread" onScroll={onScroll}>
        <ol ref={list} className="message-box__rows" aria-label="Messages with Claude">
          {items.map((item) => (
            <li key={item.kind === 'row' ? item.row.id : item.id}
              className={item.kind === 'row' && !firstIds.has(item.row.id) ? 'message-box__item message-box__row--enter' : 'message-box__item'}>
              {item.kind === 'row'
                ? <RowView row={item.row} rows={shownRows} nodeName={nodeName} />
                : <ActionsRow entries={item.entries} />}
            </li>
          ))}
          {pending && <li className="message-box__item"><PendingRow key={pending.clientId} pending={pending} /></li>}
        </ol>
      </ScrollFade>
      {pill && (
        <button type="button" className="message-box__pill" onClick={jumpDown}>{NEW_REPLY_PILL}</button>
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

export function MessageComposer({ expanded }: { expanded: boolean }) {
  const draft = usePersonThreadStore((s) => s.draft);
  const contextIds = usePersonThreadStore((s) => s.contextIds);
  const pending = usePersonThreadStore((s) => s.pending);
  const failure = usePersonThreadStore((s) => s.failure);
  const state = useAvailability();
  const names = useNodeNames(contextIds);
  const field = useRef<HTMLTextAreaElement | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const lineId = useId();
  const counterId = useId();
  const [focused, setFocused] = useState(false);
  const [announced, setAnnounced] = useState('');
  const [lengthBefore, setLengthBefore] = useState(draft.length);
  if (lengthBefore !== draft.length) {
    setLengthBefore(draft.length);
    const words = counterAnnouncement(lengthBefore, draft.length);
    if (words) setAnnounced(words);
    else if (counterLine(draft.length) === null && announced) setAnnounced('');
  }

  const ready = state.kind === 'ready';
  const recipientName = ready ? agentLabel(state.recipient.agent, state.recipient.session) : 'Claude';
  const label = `Message ${recipientName}`;
  const counter = counterLine(draft.length);
  const lockLine = state.kind === 'notConnected' ? NOT_CONNECTED_LINE : state.kind === 'stopped' ? STOPPED_LISTENING_LINE : null;
  // Offline: the app's own row says it (the house pattern), no line here.
  const described = [state.kind === 'offline' ? OFFLINE_LINE_ID : lockLine || failure ? lineId : null, counter ? counterId : null]
    .filter(Boolean).join(' ') || undefined;
  const canSend = ready && !pending && draft.trim().length > 0 && draft.length <= MESSAGE_MAX;

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

  function send() {
    if (!canSend || state.kind !== 'ready') return;
    void usePersonThreadStore.getState().send(state.recipient.listenerId);
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
      {contextIds.length > 0 && (
        <div className="message-box__context">
          <span className="message-box__context-label">{contextChipLabel(names)}</span>
          <button type="button" className="message-box__context-remove" aria-label={contextRemoveLabel(names)}
            onClick={() => usePersonThreadStore.getState().removeContext()}>
            <X size={11} strokeWidth={1.75} aria-hidden="true" focusable="false" />
          </button>
        </div>
      )}
      <div className="message-box__field-row" data-locked={!ready || undefined}>
        {ready && state.listening.length >= 2 && <RecipientChip state={state} />}
        <AutoGrowTextarea
          textareaRef={field}
          className="message-box__field"
          rows={1}
          value={draft}
          placeholder={label}
          aria-label={label}
          aria-disabled={!ready || undefined}
          aria-describedby={described}
          maxLength={MESSAGE_MAX}
          readOnly={false}
          onChange={(event) => usePersonThreadStore.getState().setDraft(event.target.value, selectedIds)}
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
      {(lockLine || failure) && state.kind !== 'offline' && (
        <div className={`message-box__line${failure && !lockLine ? ' message-box__line--failed' : ''}`}>
          <span id={lineId}>{lockLine ?? failure?.line}</span>
          {state.kind === 'notConnected' && <CopyCommand />}
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
