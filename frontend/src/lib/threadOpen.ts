import { useProjectStore } from '../store/projectStore';
import { useUIStore } from '../store/uiStore';
import { writtenLine } from './errorCopy';
import { goToCanvas, onCanvas, whenReady } from './goToCanvas';

/**
 * Open on a reply's Update (GM r100.3: "Claude Code replied in “Coast”."):
 * open that project (the reply went to the thread of the message it
 * answers), go to its canvas, and open the Agent log with its thread, focus
 * on the log's header. Only the Updates corner, a deferred chunk, imports this.
 */
export async function openThreadIn(projectId: unknown): Promise<void> {
  if (typeof projectId !== 'string' || !projectId) throw writtenLine("This update's thread can't be opened from here.");
  if (useProjectStore.getState().activeProject?.id !== projectId) await useProjectStore.getState().open(projectId);
  if (useProjectStore.getState().activeProject?.id !== projectId) throw writtenLine("The project didn't open. Try again.");
  await goToCanvas();
  const header = () => document.querySelector<HTMLElement>('.agent-log__header');
  const ready = await whenReady(() => onCanvas() && header() !== null);
  if (!ready) throw writtenLine("The Agent log didn't open. Try again.");
  useUIStore.getState().openAgentLog();
  window.requestAnimationFrame(() => header()?.focus({ preventScroll: true }));
}
