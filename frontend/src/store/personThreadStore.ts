import { create } from 'zustand';
import { wsClient, type AgentPresenceEvent } from '../lib/wsClient';
import { cursorLabel } from '../lib/agentCursorLabel';
import {
  mergeRows,
  sanitizeListener,
  sanitizeRow,
  sessionKeyOf,
  type ChannelListener,
  type SessionActivity,
  type ThreadRow,
} from '../lib/personThread';
import type { SendFailure } from '../lib/personThreadCompose';
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
  /** The live region's latest words, once per reply. */
  announcement: { id: string; text: string } | null;
  pending: PendingSend | null;
  failure: SendFailureState | null;
  answering: AnsweringState | null;
  /** GM r79.6: the asker's label when it withdrew the question being answered (the composer's line). */
  withdrawn: string | null;
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
    announcement: null as { id: string; text: string } | null,
    pending: null as PendingSend | null,
    failure: null as SendFailureState | null,
    answering: null as AnsweringState | null,
    withdrawn: null as string | null,
  };
}

export const usePersonThreadStore = create<PersonThreadState>((set) => ({
  ...initial(),

  removeContext: () => set({ contextIds: [] }),

  choose: (listenerId) => set({ chosen: listenerId }),

  markRead: () => set({ unread: 0 }),

  clearFailure: () => set({ failure: null }),

  answer: (target) => set({ answering: target, withdrawn: null }),

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

/** "Claude replied. <text>": the reply's agent as its cursor names it. */
export function replyAnnouncement(row: ThreadRow): string {
  const name = row.agent ? cursorLabel(row.agent.name, row.session ?? null) : 'Claude';
  return `${name} replied. ${row.text ?? ''}`.trim();
}

/** New rows from the socket: merged; each new reply counts as unread (panel closed) and is announced once. */
export function receiveRows(projectId: string | null, incoming: ThreadRow[]): void {
  const state = usePersonThreadStore.getState();
  if (state.projectId !== null && projectId !== null && projectId !== state.projectId) return;
  const known = new Set(state.rows.map((row) => row.id));
  const replies = incoming.filter((row) => row.kind === 'reply' && !known.has(row.id));
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
    ? rows.filter((row) => row.kind === 'reply' && !known.has(row.id)).length : 0;
  usePersonThreadStore.setState({
    projectId,
    rows,
    // Another project's thread: nothing of the old one is unread.
    unread: same ? state.unread + missed : 0,
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

/** One event from an agent session: the "working" line reads it. */
export function noteActivity(event: AgentPresenceEvent): void {
  const key = sessionKeyOf(event.session);
  if (!key) return;
  const at = Number.isFinite(event.at) && event.at > 0 ? event.at : now();
  const state = usePersonThreadStore.getState();
  // GM r79.1: a reply's own cursor say ("Replied on …") is not an action.
  const say = typeof event.say === 'string' ? event.say.replace(/…$/, '').trim() : '';
  if (event.did?.verb?.startsWith('Replied') && say && state.rows.some((row) => row.kind === 'reply'
    && row.sessionKey === key && (row.text ?? '').startsWith(say))) return;
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
