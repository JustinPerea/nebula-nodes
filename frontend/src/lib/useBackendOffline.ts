import { useSyncExternalStore } from 'react';
import { isBackendOffline, subscribeBackendConnection } from './backendConnection';

/**
 * Whether Nebula is offline, for read-only cues (round 14 of PR #114).
 *
 * Round 15: read-only is React state, not DOM patching. Every control that
 * edits reads this and renders `disabled` itself (with `offlineMark`), so a
 * reconnect simply re-renders it, and nothing watches the DOM (review 14,
 * H1: the old MutationObserver re-triggered itself and froze the tab).
 */
export function useBackendOffline(): boolean {
  return useSyncExternalStore(subscribeBackendConnection, isBackendOffline, isBackendOffline);
}

/** The attribute a control disabled because Nebula is offline carries: the
 * not-allowed cursor and the dimming (App.css), and a press on it pulses the
 * banner (BackendConnectionStatus). */
export const OFFLINE_MARK = 'data-offline-disabled';

/** Spread on a control that edits: the offline mark while offline. */
export function offlineMark(offline: boolean): { 'data-offline-disabled'?: '' } {
  return offline ? { [OFFLINE_MARK]: '' } as { 'data-offline-disabled': '' } : {};
}
