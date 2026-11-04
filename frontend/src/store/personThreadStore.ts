import { useMemo } from 'react';
import { create } from 'zustand';
import { wsClient, type AgentPresenceEvent } from '../lib/wsClient';
import { cursorLabel } from '../lib/agentCursorLabel';
import {
  countsAsReply,
  mergeRows,
  sanitizeListener,
  syncRows,
  sanitizeRow,
  sessionKeyOf,
  type ChannelListener,
  type SessionActivity,
  type ThreadRow,
} from '../lib/personThread';
import type { SendFailure } from '../lib/personThreadCompose';
import { useCanvasLock } from '../lib/canvasLock';
import { availability, type Availability } from '../lib/personThread';
import type { AnswerGoneCause } from '../lib/personThreadBox';
import { useUIStore } from './uiStore';

/**
 * The Message box's state (GM - Design r50, r55), loaded with the app so no
 * reply, listener change or session event is missed before the deferred box
 * (components/panels/MessageBox.tsx, in the Agent log's chunk) arrives.
 * The thread itself lives on the backend per project (services/person_thread.py):
 * this is the tab's copy, its draft and its one send in flight. Only what
 * the socket's events need is here (GM r70's budget): the draft's and the
 * send's code is lib/personThreadCompose.ts's, in the box's chunk.
 */

export interface PendingSend {
  clientId: string;
  text: string;
  to: string;
  nodeIds: string[];
  startedAt: number;
}

export interface SendFailureState {
  kind: SendFailure;
  /** Only for a failure that is neither the server's nor the listener's
   * (failureMessage's words). Those two get r50's lines, which the box
   * writes with the recipient's cursor label (r61 answer 3). */
  line: string | null;
  /** The failed send's id: Try again with the same words reuses it, so the server keeps one row. */
  clientId: string;
  text: string;
  /** The listener it was for. */
  to: string;
}

/** r61 answer 4: a question with no options, answered from the composer.
 * Sending answers it (question.answered), never a thread message. */
export interface AnsweringState {
  setId: string;
  questionId: string;
  question: string;
}

/** Why the "Answering" chip went while the person typed (GM r79.6, r89.3;
 * 'gone' for a set this tab no longer holds, GM r94.1).
 * `held`: the next Enter (or Send) only says so; the one after posts. */
export interface AnswerGone {
  cause: AnswerGoneCause;
  /** The asker's cursor label (the withdrawn line names it). */
  label: string;
  held: boolean;
}

interface PersonThreadState {
  projectId: string | null;
  rows: ThreadRow[];
  /** Every channel listener (PR A's channelListeners), oldest first. */
  listeners: ChannelListener[];
  /** The last event of each agent session (by cursor key): when, and its action line. */
  activity: Record<string, SessionActivity>;
  /** Kept in tab memory across collapse, view changes and failures (r50). */
  draft: string;
  /** The nodes riding along with this draft, picked when typing started. */
  contextIds: string[];
  /** The listener the person picked, when two or more listen. */
  chosen: string | null;
  /** Replies that came while the panel was closed. */
  unread: number;
  /** GM r100.3: replies saved in another project's thread (the message they
   * answer is there), by project: that thread's unread once it opens. */
  unreadElsewhere: Record<string, number>;
  /** The live region's latest words, once per reply. */
  announcement: { id: string; text: string } | null;
  pending: PendingSend | null;
  failure: SendFailureState | null;
  answering: AnsweringState | null;
  /** GM r79.6, r89.3: the question being answered went (withdrawn, or answered
   * or closed in another tab) with words in the draft: the composer's line. */
  answerGone: AnswerGone | null;
  removeContext: () => void;
  choose: (listenerId: string | null) => void;
  markRead: () => void;
  clearFailure: () => void;
  answer: (target: AnsweringState) => void;
  stopAnswering: () => void;
  reset: () => void;
}

const now = () => Date.now();

function initial() {
  return {
    projectId: null as string | null,
    rows: [] as ThreadRow[],
    listeners: [] as ChannelListener[],
    activity: {} as Record<string, SessionActivity>,
    draft: '',
    contextIds: [] as string[],
    chosen: null as string | null,
    unread: 0,
    unreadElsewhere: {} as Record<string, number>,
    announcement: null as { id: string; text: string } | null,
    pending: null as PendingSend | null,
    failure: null as SendFailureState | null,
    answering: null as AnsweringState | null,
    answerGone: null as AnswerGone | null,
  };
}

export const usePersonThreadStore = create<PersonThreadState>((set) => ({
  ...initial(),

  removeContext: () => set({ contextIds: [] }),

  choose: (listenerId) => set({ chosen: listenerId }),

  markRead: () => set({ unread: 0 }),

  clearFailure: () => set({ failure: null }),

  answer: (target) => set({ answering: target, answerGone: null }),

  stopAnswering: () => set({ answering: null }),

  reset: () => set(initial()),
}));

/** A terminal session listens on the channel (the chat bubble then reads "Personal agent"). */
export function terminalListening(state: Pick<PersonThreadState, 'listeners'>): boolean {
  return state.listeners.some((entry) => entry.state === 'listening');
}

function cleanRows(raw: unknown[]): ThreadRow[] {
  return raw.map(sanitizeRow).filter((row): row is ThreadRow => row !== null);
}

/** "Claude replied. <text>": the reply's (or pin answer's) agent as its cursor names it. */
export function replyAnnouncement(row: ThreadRow): string {
  const name = row.agent ? cursorLabel(row.agent.name, row.session ?? null) : 'Claude';
  return `${name} replied. ${row.text ?? ''}`.trim();
}

/** New rows from the socket: merged; each new reply (countsAsReply) counts as unread (panel closed) and is announced once. */
/** The reply ids counted unread in each other project, until that project's thread loads. */
const countedElsewhere = new Map<string, Set<string>>();

export function receiveRows(projectId: string | null, incoming: ThreadRow[]): void {
  const state = usePersonThreadStore.getState();
  if (state.projectId !== null && projectId !== null && projectId !== state.projectId) {
    // A reply in another project's thread (GM r100.3): unread there, once,
    // by its id (review 4 NIT-6: a re-sent copy, a newer rev, counts once).
    // Tied to the count: none held there (none yet, or read since) starts afresh.
    const seen = (projectId in state.unreadElsewhere && countedElsewhere.get(projectId)) || new Set<string>();
    countedElsewhere.set(projectId, seen);
    const count = incoming.filter((row) => countsAsReply(row) && !seen.has(row.id) && seen.add(row.id)).length;
    if (count > 0) {
      usePersonThreadStore.setState((s) => ({
        unreadElsewhere: { ...s.unreadElsewhere, [projectId]: (s.unreadElsewhere[projectId] ?? 0) + count },
      }));
    }
    return;
  }
  const known = new Set(state.rows.map((row) => row.id));
  const replies = incoming.filter((row) => countsAsReply(row) && !known.has(row.id));
  const open = useUIStore.getState().agentLogOpen;
  const latest = replies[replies.length - 1];
  usePersonThreadStore.setState({
    projectId: projectId ?? state.projectId,
    rows: mergeRows(state.rows, incoming),
    unread: open ? 0 : state.unread + replies.length,
    announcement: latest ? { id: latest.id, text: replyAnnouncement(latest) } : state.announcement,
  });
}

export function receiveSync(projectId: string | null, rows: ThreadRow[]): void {
  const state = usePersonThreadStore.getState();
  const same = projectId === state.projectId;
  // A reply that landed while the socket was down (review 1, LOW-3) counts as
  // unread with the panel closed; a burst after a reconnect isn't spoken.
  const known = new Set(state.rows.map((row) => row.id));
  const missed = same && state.rows.length > 0 && !useUIStore.getState().agentLogOpen
    ? rows.filter((row) => countsAsReply(row) && !known.has(row.id)).length : 0;
  const { [projectId ?? '']: waiting = 0, ...elsewhere } = state.unreadElsewhere;
  usePersonThreadStore.setState({
    projectId,
    // The same thread again (a reconnect, a stale hello): merged, never replaced (LOW-4).
    rows: same ? syncRows(state.rows, rows) : rows,
    // Another project's thread: nothing of the old one is unread, but what
    // came for this one while another was open is (GM r100.3).
    unread: same ? state.unread + missed : useUIStore.getState().agentLogOpen ? 0 : waiting,
    unreadElsewhere: same ? state.unreadElsewhere : elsewhere,
  });
}

/** Bubble forms that never reach the thread (GM r79.2): "changed 1", "moved 2", "no change"... */
const TERSE = /\b(?:added|connected|changed|renamed|moved|removed|disconnected) \d|\bmade \d+ ready\b|^\d+ placeholders?\b|^no change$/;

/** An event's words for the working line (GM r79.2): its say, else its log,
 * else its did line as the Agent log words it ("Changed “Hero shot”"); never
 * a terse summary. */
export function activityLine(event: AgentPresenceEvent): string | null {
  for (const raw of [event.say, event.log]) {
    const line = typeof raw === 'string' ? raw.trim() : '';
    if (line && !TERSE.test(line)) return line;
  }
  const did = event.did;
  if (!did?.verb) return null;
  return did.label ? `${did.verb} “${did.label}”` : did.verb;
}

function oneSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** One event from an agent session: the "working" line reads it. */
export function noteActivity(event: AgentPresenceEvent): void {
  const key = sessionKeyOf(event.session);
  if (!key) return;
  const at = Number.isFinite(event.at) && event.at > 0 ? event.at : now();
  const state = usePersonThreadStore.getState();
  // GM r79.1: a reply's own cursor say ("Replied on …") is not an action. The
  // say is the reply's first sentence with its whitespace collapsed (review 2
  // LOW-3: "Made  it warmer."), so both sides are compared collapsed.
  const say = typeof event.say === 'string' ? oneSpace(event.say.replace(/…$/, '')) : '';
  if (event.did?.verb?.startsWith('Replied') && say && state.rows.some((row) => row.kind === 'reply'
    && row.sessionKey === key && oneSpace(row.text ?? '').startsWith(say))) return;
  const said = activityLine(event);
  const previous = state.activity[key];
  if (previous && previous.at > at) return;
  usePersonThreadStore.setState((state) => ({
    activity: { ...state.activity, [key]: { at, line: said || previous?.line || null } },
  }));
}

wsClient.subscribe((event) => {
  if (event.type === 'personThread') {
    const rows = cleanRows(Array.isArray(event.rows) ? event.rows : []);
    const projectId = typeof event.projectId === 'string' ? event.projectId : null;
    if (event.change === 'sync') receiveSync(projectId, rows);
    else receiveRows(projectId, rows);
  } else if (event.type === 'channelListeners') {
    const listeners = (Array.isArray(event.listeners) ? event.listeners : [])
      .map(sanitizeListener).filter((entry): entry is ChannelListener => entry !== null);
    usePersonThreadStore.setState((state) => ({
      listeners,
      chosen: state.chosen && listeners.some((entry) => entry.listenerId === state.chosen && entry.state === 'listening')
        ? state.chosen : null,
    }));
  } else if (event.type === 'agentPresence') {
    noteActivity(event);
  }
});

// Opening the panel reads every reply (r50: "Opening the panel clears it").
useUIStore.subscribe((state, previous) => {
  if (state.agentLogOpen && !previous.agentLogOpen && usePersonThreadStore.getState().unread > 0) {
    usePersonThreadStore.getState().markRead();
  }
});

/** Which listener gets a message, and whether the composer is locked: the
 * Message box's, and the shortcut sheet's "/" label (GM r94.2), one source. */
export function useMessageAvailability(): Availability {
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

