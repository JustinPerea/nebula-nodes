import { useSyncExternalStore } from 'react';

/**
 * PR #204 round 18d (GM r31 layout M, GM r32 1, review 14): whether this window last heard that
 * the backend runs without the Commons. Set by any Commons call's 404 "Commons is disabled"
 * (lib/commonsApi, a load's or an action's) and by the capability answering off for a tab opened
 * on the Commons (hooks/useCommonsCapability). Cleared by any answer that proves the Commons is
 * on (round 18f, GM r35 2): a Commons call's answer other than that 404 (a 500, a 401) or a
 * gateway's with no reason, and the capability answering on. No answer proves nothing, so going
 * offline never brings the tabs back.
 */
let off = false;
const listeners = new Set<() => void>();

function set(next: boolean) {
  if (off === next) return;
  off = next;
  for (const listener of [...listeners]) listener();
}

export function noteCommonsOff(): void { set(true); }

/** GM r37, r39: why a Commons proposal's Review can't open while the Commons is off (the Updates
 * Review button's lock line, and lib/assetProposalReview's refusal). */
export const COMMONS_OFF_REVIEW_LINE = 'Commons is turned off because Nebula started without it. Restart Nebula with NEBULA_COMMONS_ENABLED=1 to review this proposal.';
export function noteCommonsAnswered(): void { set(false); }
export function commonsOffNow(): boolean { return off; }

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useCommonsOff(): boolean {
  return useSyncExternalStore(subscribe, commonsOffNow, commonsOffNow);
}

/**
 * PR #204 round 18f (GM r35 5): the Commons-off view opening into the Commons after a reconnect.
 * The capability hook marks where focus goes (the way back when it was there, else the heading),
 * and the Commons view reads the mark as it renders and clears it once it has shown (a render
 * React drops, as when part of the view is still loading, must not lose it): it moves focus there
 * and springs its sections in. A module mark, not state: the first view that shows takes it.
 */
export type CommonsOpeningFocus = 'back' | 'heading';

let openingPending: CommonsOpeningFocus | null = null;

export function markCommonsOpening(focus: CommonsOpeningFocus): void { openingPending = focus; }

export function peekCommonsOpening(): CommonsOpeningFocus | null { return openingPending; }

export function clearCommonsOpening(): void { openingPending = null; }
