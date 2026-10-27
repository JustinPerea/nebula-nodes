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

/** The attribute a paid or saving action carries while it is disabled
 * offline: it drops its accent (orange Generate, Export) for the neutral
 * control look (App.css), as Run does on the canvas (GM, PR #198 r2). */
export const OFFLINE_NEUTRAL = 'data-offline-neutral';

/**
 * Spread on an action that saves or spends (GM, PR #198 r2: Cinema's
 * Generate shot, Generate N, Generate all and Add shot, Create's Generate,
 * Remotion's adds, REC and Export): disabled while offline, with the offline
 * mark (cursor, dimming, a press pulses the banner) and the neutral look.
 * `disabled` is the action's own reason to be off; the button keeps its own
 * title, as Run does. One helper, so every studio reads the same.
 */
export function offlineAction(offline: boolean, disabled = false): {
  disabled: boolean; 'data-offline-disabled'?: ''; 'data-offline-neutral'?: '';
} {
  if (!offline) return { disabled };
  return { disabled: true, [OFFLINE_MARK]: '', [OFFLINE_NEUTRAL]: '' } as {
    disabled: true; 'data-offline-disabled': ''; 'data-offline-neutral': '' };
}
