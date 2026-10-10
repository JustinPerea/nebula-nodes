/**
 * Canvas shortcuts (⌘Z, ⌘=, ⇧1, ⌘C…) listen on the document so they keep
 * working after you click Run, a rail button or the header. They still yield
 * to anything that owns its own keys: text fields, dialogs, and panels like
 * chat or the inspector, where ⌘A or ⌘C mean the panel's text, not the graph.
 */
const CANVAS_OWNED = [
  '.canvas-wrapper',
  '.toolbar',
  '.workspace-rail',
  '.workspace-header--canvas',
  '.panel-launcher--chat',
].join(', ');

export function isCanvasShortcutTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return true;
  if (target === document.body || target === document.documentElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return false;
  if (target.closest('input, textarea, select, [role="dialog"], [aria-modal="true"]')) return false;
  return target.closest(CANVAS_OWNED) !== null;
}
