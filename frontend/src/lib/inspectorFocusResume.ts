/**
 * The one case the Inspector takes keyboard focus on its own: a confirmed
 * next-step picker (ConnectionPopup) unmounted its focused choice and opened
 * the Inspector on the node it made. Any other way the Inspector's node
 * changes (an Undo or a Redo bringing a node back, a click, an agent) leaves
 * focus where it is (review 6 of PR #205, inspector-pin MEDIUM-1; GM r13
 * item 5). The picker asks for it once; it lapses if no Inspector takes it
 * soon after, so a later Undo never inherits it.
 */
const RESUME_WINDOW_MS = 2000;
let askedAt: number | null = null;

export function resumeInspectorFocus(): void {
  askedAt = Date.now();
}

/** True once, within the window, after the picker asked. */
export function takeInspectorFocusResume(): boolean {
  const asked = askedAt !== null && Date.now() - askedAt <= RESUME_WINDOW_MS;
  askedAt = null;
  return asked;
}

/** Whether the picker's ask is still waiting (it isn't consumed). */
export function inspectorFocusResumeWaiting(): boolean {
  return askedAt !== null && Date.now() - askedAt <= RESUME_WINDOW_MS;
}
