import { useSyncExternalStore } from 'react';

/**
 * The app's one notice region holds one stack (GM - Design, 2026-10-23: "One
 * region, one stack, and nothing else draws toasts."). Each kind of item has
 * a slot in it, listed here top to bottom as the column draws them, so the
 * order never depends on which item mounted first. Bottom up: the canvas
 * notice (its Undo or Redo, an error) right above the bar; then a restore's
 * late count, above the newer notice it arrived after (GM - Design, round 4:
 * "With two notices showing, put the late line above the newer one, so the
 * notice with a button stays nearest the bar."); then a written line that
 * arrived while the canvas notice offers Undo or Redo (review 7, L3: it
 * never replaces the offer; the same rule puts it above); then the scenes'
 * stop lines, a state above every event (GM r28: one line per cause, never
 * pushed out); then the toasts about the person's own last action (an asset
 * moved to the trash, a board step, a pin that couldn't save, a project moved
 * to the trash), and a scene's clash prompt (GM r9 decision 2: it waits for
 * Keep mine or Use theirs); then the lines about the
 * app and the agents (the project an agent switched to, a project over the
 * save limit pausing or resuming its saves (Q118), the tab that isn't the
 * person's); then the proposal's run-later notice; and on top the proposal
 * bar ("The order from the bottom up is notices, then the proposal bar.").
 *
 * An item renders where its own state lives and portals into its slot
 * (InNoticeRegion), so it keeps its role, buttons, timers and hold.
 */
export const NOTICE_SLOTS = [
  'proposal',
  'run-later',
  'person-required',
  'project-switch',
  'save-paused',
  'project-home',
  'pin',
  'board',
  'asset-trash',
  'scene-clash',
  'scene-stop',
  'message',
  'late',
  'notice',
] as const;

export type NoticeSlot = (typeof NOTICE_SLOTS)[number];

const slots = new Map<NoticeSlot, HTMLElement>();
const listeners = new Set<() => void>();

/** The region registers each slot's box when it mounts, and null when it goes. */
export function setNoticeSlot(name: NoticeSlot, element: HTMLElement | null): void {
  if (element) {
    if (slots.get(name) === element) return;
    slots.set(name, element);
  } else if (!slots.delete(name)) {
    return;
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The slot's box in the mounted region, or null while no region is on screen. */
export function useNoticeSlot(name: NoticeSlot): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slots.get(name) ?? null, () => null);
}
