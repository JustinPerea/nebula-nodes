import { useSyncExternalStore } from 'react';

/**
 * PR #204 round 18d (GM r31 layout M, GM r32 1, review 14): whether this window last heard that
 * the backend runs without the Commons. Set by any Commons call's 404 "Commons is disabled"
 * (lib/commonsApi, a load's or an action's) and by the capability answering off for a tab opened
 * on the Commons (hooks/useCommonsCapability). Cleared only when a Commons call answers OK, so
 * going offline (no answer) never brings the tabs back.
 */
let off = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (off === next) return;
  off = next;
  for (const listener of [...listeners]) listener();
}

export function noteCommonsOff(): void { set(true); }
export function noteCommonsAnswered(): void { set(false); }
export function commonsOffNow(): boolean { return off; }

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCommonsOff(): boolean {
  return useSyncExternalStore(subscribe, commonsOffNow, commonsOffNow);
}
