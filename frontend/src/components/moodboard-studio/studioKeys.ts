/**
 * Moodboard Studio's own keys (plan section 5.4): Cmd+Z, Shift+Cmd+Z, Cmd+S
 * and, on the Board view, Delete and Shift+1. They listen on the document so
 * they work after a click on a card, the header or the canvas, and they
 * yield to anything that owns its keys: text fields (their own undo), dialogs,
 * and the chat panel, which mounts over the Studio too. Undo and redo yield
 * only to text boxes and dialogs.
 */
export function isStudioShortcutTarget(target: EventTarget | null, action?: StudioKey): boolean {
  if (!(target instanceof Element)) return true;
  if (target === document.body || target === document.documentElement) return true;
  if (isTextEntry(target)) return false;
  // Undo and redo yield only to a text box (Q83): on a slider, a switch, a
  // checkbox or a select, Cmd+Z is the Studio's, which has the step.
  const owns = action === 'undo' || action === 'redo' ? '[role="dialog"], [aria-modal="true"]'
    : 'input, textarea, select, [role="dialog"], [aria-modal="true"]';
  if (target.closest(owns)) return false;
  // The Updates chip and its card sit outside the Studio's tree (App mounts
  // them on every screen, Q107 a) but take no keys but Escape: focus there
  // leaves Cmd+Z the Studio's. Their open list is a dialog (above).
  return target.closest('.moodboard-studio-view, .agent-notes-chip, .agent-note-card') !== null;
}

// Inputs that take typing, so the browser keeps an undo for them.
const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

/** A text box (input, textarea, contenteditable): its own Cmd+Z undoes typing. */
export function isTextEntry(target: Element): boolean {
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  if (target.closest('textarea, [contenteditable]:not([contenteditable="false"])')) return true;
  const input = target.closest('input');
  return input !== null && TEXT_INPUTS.has((input.getAttribute('type') ?? '').toLowerCase());
}

export type StudioKey = 'undo' | 'redo' | 'save' | 'delete' | 'fit' | null;

/** What a keydown means to the Studio (before the target check). */
export function studioKey(event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>): StudioKey {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  if (mod && !event.altKey && key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (mod && !event.altKey && !event.shiftKey && key === 'y') return 'redo';
  if (mod && !event.altKey && !event.shiftKey && key === 's') return 'save';
  if (!mod && !event.altKey && (event.key === 'Delete' || event.key === 'Backspace')) return 'delete';
  if (!mod && !event.altKey && event.shiftKey && (event.code === 'Digit1' || event.key === '!')) return 'fit';
  return null;
}
