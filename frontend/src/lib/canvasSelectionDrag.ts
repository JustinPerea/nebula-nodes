/**
 * A drag-select on the canvas (Canvas.tsx: onSelectionStart, onSelectionEnd).
 * While one is on, the unpinned Inspector stays open over the drag's
 * momentary empty selection; when it ends with nothing selected, the
 * Inspector closes (GM PR #205 r16 item 5; graphStore listens). Its own
 * module, so the canvas's handlers reach no store code.
 *
 * React Flow ends a drag only from the pane's own pointerup. Every other way
 * a drag ends ends it here too (review 8 of PR #205, lines-inspector NIT-2),
 * so the flag can't stay on and keep the Inspector open at none:
 * - a pointerup of the main button the pane never saw (anywhere on the page);
 * - a pointercancel (the browser took the pointer);
 * - the window losing focus;
 * - the canvas unmounting mid-drag (Canvas.tsx's cleanup).
 * Escape doesn't end React Flow's box: it keeps selecting until the button
 * comes up, and that pointerup ends it here.
 */
let dragging = false;
const endListeners = new Set<() => void>();

const WINDOW_ENDS = ['pointerup', 'pointercancel', 'blur'] as const;
const endFromWindow = (event: Event) => {
  // React Flow's own end is the main button's pointerup; another button's
  // leaves the box going.
  if (event.type === 'pointerup' && (event as PointerEvent).button !== 0) return;
  noteCanvasSelectionDrag(false);
};

function watchWindow(on: boolean): void {
  for (const type of WINDOW_ENDS) {
    if (on) window.addEventListener(type, endFromWindow);
    else window.removeEventListener(type, endFromWindow);
  }
}

export function noteCanvasSelectionDrag(active: boolean): void {
  if (active === dragging) return;
  dragging = active;
  watchWindow(active);
  if (!active) for (const listener of [...endListeners]) listener();
}

export function isCanvasSelectionDragging(): boolean {
  return dragging;
}

export function onCanvasSelectionDragEnd(listener: () => void): () => void {
  endListeners.add(listener);
  return () => { endListeners.delete(listener); };
}
