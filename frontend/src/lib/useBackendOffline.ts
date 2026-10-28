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
 * `disabled` is the action's own reason to be off. One helper, so every
 * studio reads the same. Its tooltip is `offlineTitle` below (the Cinema
 * studio's actions use it; GM - Design, PR #198 round 5).
 */
export function offlineAction(offline: boolean, disabled = false): {
  disabled: boolean; 'data-offline-disabled'?: ''; 'data-offline-neutral'?: '';
} {
  if (!offline) return { disabled };
  return { disabled: true, [OFFLINE_MARK]: '', [OFFLINE_NEUTRAL]: '' } as {
    disabled: true; 'data-offline-disabled': ''; 'data-offline-neutral': '' };
}

/**
 * The tooltip of an action disabled because Nebula is offline (GM - Design,
 * PR #198 round 5): "You can <verb> when Nebula reconnects." ("You can
 * generate when Nebula reconnects."), or, with no verb, the generic
 * "This works again when Nebula reconnects." Shared by every surface (#200
 * reads it too); the action's own title comes back once it reconnects.
 */
export const OFFLINE_RECONNECT_FALLBACK = 'This works again when Nebula reconnects.';

/** GM's verbs (PR #200 r2 item 4), each read as "You can <verb> when Nebula
 * reconnects.". Anything not listed reads OFFLINE_RECONNECT_FALLBACK; a text
 * field goes read-only with no tooltip (the offline banner says why). Run
 * history stays live while it shows runs already loaded; only a history that
 * needs the server to open reads `seeRunHistory`. */
export const OFFLINE_VERBS = {
  /** Generate shot, Generate N, Generate all. */
  generate: 'generate',
  /** Send to motion. */
  sendToMotion: 'send it to motion',
  /** + Add shot. */
  addShots: 'add shots',
  /** The shot arrows (and Alt + arrow keys, a drag). */
  reorderShots: 'reorder shots',
  /** The shot ×. */
  removeShots: 'remove shots',
  /** The canvas and toolbar Run. */
  runNodes: 'run nodes',
  /** Ask. */
  askAgents: 'ask agents',
  /** Delete. */
  deleteNodes: 'delete nodes',
  /** New project. */
  createProjects: 'create projects',
  /** Run history, only where opening it needs the server. */
  seeRunHistory: 'see run history',
  /** Run history's Rerun (GM, PR #200 r4 item 2). */
  rerun: 'rerun it',
} as const;
export type OfflineVerb = typeof OFFLINE_VERBS[keyof typeof OFFLINE_VERBS];
export function offlineReason(verb?: OfflineVerb): string {
  return verb ? `You can ${verb} when Nebula reconnects.` : OFFLINE_RECONNECT_FALLBACK;
}

/** A control's title: the offline reason while offline, else its own. */
export function offlineTitle(offline: boolean, verb: OfflineVerb | undefined, own?: string): string | undefined {
  return offline ? offlineReason(verb) : own;
}
