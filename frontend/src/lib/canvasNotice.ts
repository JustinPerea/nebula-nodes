/**
 * A written line as the canvas notice, where a window.alert used to stop the
 * whole canvas (error copy round 3f, GM - Design: "Every error alert becomes
 * a canvas notice (non-blocking, dismissable) ... A native alert stops the
 * whole canvas over something that needs no answer."). Every screen shows it
 * in the app's one notice region (components/NoticeRegion.tsx), above every
 * panel. 'error' is announced as an alert; 'info' (an import's notes) as a status.
 *
 * Sent as a window event that the graph store turns into its notice
 * (graphStore.notify), so a deferred module such as lib/graphFile.ts can say
 * it without importing the store.
 */
export const CANVAS_NOTICE_EVENT = 'nebula:canvas-notice';

export interface CanvasNoticeDetail {
  text: string;
  tone: 'error' | 'info';
}

export function showNotice(text: string, tone: 'error' | 'info' = 'error'): void {
  // Empty: a write refused while offline, which says nothing (round 15).
  if (typeof window === 'undefined' || !text) return;
  window.dispatchEvent(new CustomEvent<CanvasNoticeDetail>(CANVAS_NOTICE_EVENT, { detail: { text, tone } }));
}
