import { useSyncExternalStore } from 'react';

/**
 * The fold's count carried in an Undo notice's own row (GM - Design, PR #216
 * r8): "Moved “Hero shot” · Undo · 3 more", where "3 more" is a trailing
 * text button that opens the stack. The notice region decides which notice
 * carries it (lib/noticeStackPlace.ts `moreHost`) and writes it here; the
 * notice renders the button through NoticeMoreInline, after its Undo, so
 * the keyboard reaches the name, Undo, then "3 more".
 */
export interface NoticeMoreState {
  /** The notice carrying it (the region's item), or null. */
  host: HTMLElement | null;
  count: number;
  expanded: boolean;
}

const EMPTY: NoticeMoreState = { host: null, count: 0, expanded: false };
let state = EMPTY;
let toggle: () => void = () => {};
const listeners = new Set<() => void>();

export function setNoticeMore(next: NoticeMoreState): void {
  const value = next.host ? next : EMPTY;
  if (value.host === state.host && value.count === state.count && value.expanded === state.expanded) return;
  state = value;
  listeners.forEach((listener) => listener());
}

/** The region's own toggle (the same as its "more" row's click). */
export function setNoticeMoreToggle(fn: () => void): void {
  toggle = fn;
}

export function toggleNoticeMore(): void {
  toggle();
}

export function getNoticeMore(): NoticeMoreState {
  return state;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNoticeMore(): NoticeMoreState {
  return useSyncExternalStore(subscribe, getNoticeMore, getNoticeMore);
}
