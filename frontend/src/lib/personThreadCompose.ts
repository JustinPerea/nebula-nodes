/**
 * The Message box's composer half (GM r70's budget): the draft and the send,
 * the one API call. Only the deferred box (components/panels/MessageBox.tsx,
 * in the Agent log's chunk) sends, so none of this rides in the entry; the
 * store it writes to (store/personThreadStore.ts) is loaded with the app.
 */
import { apiRequest } from './apiRequest';
import { RequestFailedError, failureMessage } from './errorCopy';
import { MESSAGE_MAX, mergeRows, sanitizeRow, type ThreadRow } from './personThread';
import { usePersonThreadStore, type PendingSend } from '../store/personThreadStore';

/** The heading a failed send is read under (apiRequest's, failureMessage's). */
export const SEND_HEADING = "Couldn’t send your message.";

/** The Sending… threshold and hold (r50: after 300 ms, held at least 400 ms). */
export const SENDING_AFTER_MS = 300;
export const SENDING_HOLD_MS = 400;

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

const now = () => Date.now();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The draft, kept in tab memory (r50); the nodes selected when typing
 * starts ride along, and an emptied draft lets them go. */
export function setDraft(text: string, selectedIds?: () => string[]): void {
  usePersonThreadStore.setState((state) => {
    const draft = text.slice(0, MESSAGE_MAX);
    let contextIds = state.contextIds;
    if (!draft.trim()) contextIds = [];
    else if (!state.draft.trim() && contextIds.length === 0 && selectedIds) contextIds = selectedIds().slice(0, 20);
    return { draft, contextIds };
  });
}

/** Sends the draft to a listener: one send in flight; a failure brings the
 * draft back (r50: kept across failures), unless another was begun. */
export async function sendMessage(to: string): Promise<boolean> {
  const state = usePersonThreadStore.getState();
  if (state.pending) return false;
  const text = state.draft.trim();
  if (!text || text.length > MESSAGE_MAX) return false;
  const clientId = state.failure && state.failure.text === text ? state.failure.clientId : newClientId();
  const pending: PendingSend = { clientId, text, to, nodeIds: state.contextIds, startedAt: now() };
  usePersonThreadStore.setState({ pending, failure: null, draft: '', contextIds: [] });
  let row: ThreadRow;
  try {
    row = await postMessage({ text, to, nodeIds: pending.nodeIds, clientId });
  } catch (error) {
    const kind = sendFailure(error);
    usePersonThreadStore.setState((current) => ({
      pending: null,
      failure: { kind, line: kind === 'other' ? otherFailureLine(error) : null, clientId, text, to },
      draft: current.draft.trim() ? current.draft : text,
      contextIds: current.draft.trim() ? current.contextIds : pending.nodeIds,
    }));
    return false;
  }
  const wait = sendingSettleDelay(pending.startedAt, now());
  if (wait > 0) await sleep(wait);
  usePersonThreadStore.setState((current) => ({ pending: null, rows: mergeMissing(current.rows, [row]) }));
  return true;
}
