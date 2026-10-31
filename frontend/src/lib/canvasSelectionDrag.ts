/**
 * A drag-select on the canvas (Canvas.tsx: onSelectionStart, onSelectionEnd).
 * While one is on, the unpinned Inspector stays open over the drag's
 * momentary empty selection; when it ends with nothing selected, the
 * Inspector closes (GM PR #205 r16 item 5; graphStore listens). Its own
 * module, so the canvas's handlers reach no store code.
 */
let dragging = false;
const endListeners = new Set<() => void>();

export function noteCanvasSelectionDrag(active: boolean): void {
  dragging = active;
  if (!active) for (const listener of [...endListeners]) listener();
}

export function isCanvasSelectionDragging(): boolean {
  return dragging;
}

export function onCanvasSelectionDragEnd(listener: () => void): () => void {
  endListeners.add(listener);
  return () => { endListeners.delete(listener); };
}
