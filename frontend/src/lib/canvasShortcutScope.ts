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
 * Whether a modal dialog is shown (review 9, nit a): one inside a hidden,
 * inert or display:none ancestor is on the page but not in front of anyone,
 * so it never holds the keys.
 */
function isShown(dialog: Element): boolean {
  if (dialog.closest('[hidden], [inert]')) return false;
  const check = (dialog as Element & { checkVisibility?: () => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(dialog);
  for (let node: Element | null = dialog; node; node = node.parentElement) {
    if (getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

/** The modal dialogs shown, in page order. */
function shownModalDialogs(): Element[] {
  if (typeof document === 'undefined') return [];
  return [...document.querySelectorAll('[aria-modal="true"]')].filter(isShown);
}

/** The order a modal opened in (ModalPortal's `data-modal-layer`), or null for one outside a layer. */
function layerOf(dialog: Element): number | null {
  const value = dialog.closest('[data-modal-layer]')?.getAttribute('data-modal-layer');
  return value ? Number(value) : null;
}

/**
 * Whether a modal dialog is open anywhere in the app (the paid placeholder
 * confirm, a prompt, the keyboard shortcuts…). While one is, no key acts on
 * the graph behind it, wherever focus is: review 7, M-1 found focus could fall
 * to the page under an open confirm, and Cmd+Enter then ran the graph behind
 * it. Read from the page, so every dialog that says it is modal counts,
 * including ones added later.
 */
export function isModalDialogOpen(): boolean {
  return shownModalDialogs().length > 0;
}

/** The modal dialog on top, or null: the last one opened (review 9, nit b),
 * by ModalPortal's layers, wherever it sits on the page; a modal outside a
 * layer is above what comes before it on the page, as before. */
export function topModalDialog(): Element | null {
  let top: Element | null = null;
  for (const dialog of shownModalDialogs()) {
    const [mine, theirs] = [layerOf(dialog), top ? layerOf(top) : null];
    if (!top || mine === null || theirs === null || mine >= theirs) top = dialog;
  }
  return top;
}

/**
 * Whether a document- or window-wide key listener yields because a modal
 * dialog is open (review 8, L-d: one guard for every one of them, so no key
 * acts behind an open dialog, focus on the page included). With no `owner`
 * (the canvas, Moodboard Studio, the video editors, the rail), any open modal
 * dialog blocks it. With one (a dialog's or a popup's own Escape, Tab or
 * arrows: the element it belongs to), only a modal dialog on top that isn't
 * its own does: its own is the one it sits in, or the one it holds (the
 * tour's overlay holds its modal card).
 */
export function keyBlockedByModal(owner?: Element | null): boolean {
  const top = topModalDialog();
  if (!top) return false;
  return !(owner && (top.contains(owner) || owner.contains(top)));
}

export function isCanvasShortcutTarget(target: EventTarget | null): boolean {
  if (isModalDialogOpen()) return false;
  if (!(target instanceof Element)) return true;
  if (target === document.body || target === document.documentElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return false;
  if (target.closest('input, textarea, select, [role="dialog"], [aria-modal="true"]')) return false;
  return target.closest(CANVAS_OWNED) !== null;
}
