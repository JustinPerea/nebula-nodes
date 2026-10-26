/**
 * Canvas shortcuts (⌘Z, ⌘=, ⇧1, ⌘C…) listen on the document so they keep
 * working after you click Run, a rail button or the header. They still yield
 * to anything that owns its own keys: text fields, dialogs, and panels like
 * chat or the inspector, where ⌘A or ⌘C mean the panel's text, not the graph.
 * None acts while a modal dialog is open (isModalDialogOpen).
 */
const CANVAS_OWNED = [
  '.canvas-wrapper',
  '.toolbar',
  '.workspace-rail',
  '.workspace-header--canvas',
  '.panel-launcher--chat',
  // The Updates chip and its card (on every screen, Q107 a) keep no keys of
  // their own but Escape; their open list is a dialog, which does.
  '.agent-notes-chip',
  '.agent-note-card',
  // The app's notice region (NoticeRegion): the proposal bar, the canvas
  // notices and every toast portal in there, outside .canvas-wrapper. They
  // keep no keys of their own (Review focuses the bar), so focus there leaves
  // Cmd+Z, Shift+1 and Cmd+Enter the canvas's. A field in it still yields (above).
  '.notice-region',
].join(', ');

/**
 * Whether a modal dialog is open anywhere in the app (the paid placeholder
 * confirm, a prompt, the keyboard shortcuts…). While one is, no key acts on
 * the graph behind it, wherever focus is: review 7, M-1 found focus could fall
 * to the page under an open confirm, and Cmd+Enter then ran the graph behind
 * it. Read from the page, so every dialog that says it is modal counts,
 * including ones added later.
 */
export function isModalDialogOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null;
}

export function isCanvasShortcutTarget(target: EventTarget | null): boolean {
  if (isModalDialogOpen()) return false;
  if (!(target instanceof Element)) return true;
  if (target === document.body || target === document.documentElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return false;
  if (target.closest('input, textarea, select, [role="dialog"], [aria-modal="true"]')) return false;
  return target.closest(CANVAS_OWNED) !== null;
}
