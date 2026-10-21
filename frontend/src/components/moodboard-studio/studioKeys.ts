/**
 * Moodboard Studio's own keys (plan section 5.4): Cmd+Z, Shift+Cmd+Z, Cmd+S
 * and, on the Board view, Delete and Shift+1. They listen on the document so
 * they work after a click on a card, the header or the canvas, and they
 * yield to anything that owns its keys: text fields (their own undo), dialogs,
 * and the chat panel, which mounts over the Studio too.
 */
export function isStudioShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target === document.body || target === document.documentElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return false;
  if (target.closest('input, textarea, select, [role="dialog"], [aria-modal="true"]')) return false;
  return target.closest('.moodboard-studio-view') !== null;
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
