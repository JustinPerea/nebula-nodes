import { useProjectStore } from '../store/projectStore';
import { usePersonThreadStore } from '../store/personThreadStore';
import { useUIStore } from '../store/uiStore';
import { writtenLine } from './errorCopy';
import { goToCanvas, onCanvas, whenReady } from './goToCanvas';

/** An unnamed project, as the person reads it (GM r108 d; person_thread.UNTITLED). */
export const UNTITLED = 'Untitled';

/** GM r108 string 6: the because form, with the real reason; "Try again."
 * only when trying again can help. */
export function threadOpenLine(what: string, why: string, retry: boolean, unlock?: string): string {
  // A lock says what unlocks it (GM r115 b); a passing failure says Try again.
  return `Nebula couldn’t open ${what} because ${why}.${unlock ? ` ${unlock}` : ''}${retry ? ' Try again.' : ''}`;
}

const THIS_THREAD = 'this thread';
const AGENT_LOG = 'the Agent log';
const quoted = (name: string | null | undefined) => `“${(name ?? '').trim() || UNTITLED}”`;

/** The reply row Open focuses (GM r108 D2), once its thread is on screen. */
function replyRow(replyId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.message-box__thread [data-row-id="${CSS.escape(replyId)}"]`);
}

/**
 * Open on a reply's Update (GM r100.3: "Claude Code replied in “Coast”."):
 * open that project (the reply went to the thread of the message it
 * answers), go to its canvas, open the Agent log and focus the reply's row
 * (GM r108 D2: its ring sits inside the log's scroll area, never on the
 * header). Only the Updates corner, a deferred chunk, imports this.
 */
export async function openThreadIn(projectId: unknown, replyId?: unknown): Promise<void> {
  if (typeof projectId !== 'string' || !projectId) {
    throw writtenLine(threadOpenLine(THIS_THREAD, 'this Update doesn’t say which project it’s in', false));
  }
  if (useProjectStore.getState().activeProject?.id !== projectId) await useProjectStore.getState().open(projectId);
  const projects = useProjectStore.getState();
  if (projects.activeProject?.id !== projectId) {
    const listed = projects.projects.find((project) => project.id === projectId);
    const trashed = projects.trash.find((project) => project.id === projectId);
    if (trashed) throw writtenLine(threadOpenLine(THIS_THREAD, 'its project is in Recently deleted', false, 'Restore the project to open it.'));
    if (!listed) throw writtenLine(threadOpenLine(THIS_THREAD, 'its project was deleted for good', false));
    throw writtenLine(threadOpenLine(quoted(listed.name), 'it didn’t finish loading', true));
  }
  await goToCanvas();
  const header = () => document.querySelector<HTMLElement>('.agent-log__header');
  if (!await whenReady(() => onCanvas() && header() !== null)) {
    throw writtenLine(threadOpenLine(AGENT_LOG, 'the canvas didn’t finish loading', true));
  }
  useUIStore.getState().openAgentLog();
  const id = typeof replyId === 'string' && replyId ? replyId : null;
  if (id === null) {
    // An Update from before replies were named: the log, focus on its header.
    window.requestAnimationFrame(() => header()?.focus({ preventScroll: true }));
    return;
  }
  const loaded = () => usePersonThreadStore.getState().projectId === projectId;
  if (!await whenReady(() => replyRow(id) !== null || (loaded() && !usePersonThreadStore.getState().rows.some((row) => row.id === id)))) {
    throw writtenLine(threadOpenLine(AGENT_LOG, 'its thread didn’t finish loading', true));
  }
  const row = replyRow(id);
  if (!row) throw writtenLine(threadOpenLine(THIS_THREAD, 'it was deleted', false));
  focusRow(row);
}

/** Focus a thread row from code: reachable only while it has focus, so a
 * click on its text afterwards never rings it. */
export function focusRow(row: HTMLElement): void {
  row.tabIndex = -1;
  row.dataset.focusTarget = '';
  row.addEventListener('blur', () => {
    row.removeAttribute('tabindex');
    delete row.dataset.focusTarget;
  }, { once: true });
  if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' });
  row.focus({ preventScroll: true });
}
