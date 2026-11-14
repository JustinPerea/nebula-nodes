import { useEffect, useState } from 'react';
import { holdOn, proposalHoldLine, type ProposalLedgerHold } from '../lib/ledgerHold';

/** The longest delay setTimeout takes (a larger one fires at once). */
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * The current time (ms), read again once when `untilSeconds` (epoch seconds) arrives or changes and
 * once when it passes: one timer for the end, cleared on unmount, so what depends on it changes
 * without a reload. A delay past the timer's limit is clamped and set again when it fires.
 */
export function useNowUntil(untilSeconds: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const valid = typeof untilSeconds === 'number' && Number.isFinite(untilSeconds);
  // The hold may arrive after mount (the view loads): catch up the moment it does.
  useEffect(() => {
    if (!valid) return;
    const timer = setTimeout(() => setNow(Date.now()), 0);
    return () => clearTimeout(timer);
  }, [valid, untilSeconds]);
  // `now` re-runs this after a clamped timer fires early.
  useEffect(() => {
    if (!valid) return;
    const delay = untilSeconds * 1000 - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, MAX_DELAY_MS));
    return () => clearTimeout(timer);
  }, [valid, untilSeconds, now]);
  return now;
}

/** True while the current time is before `untilSeconds`, false after (and with no time). */
export function useBefore(untilSeconds: number | null | undefined): boolean {
  return holdOn({ until: untilSeconds as number }, useNowUntil(untilSeconds));
}

/** A proposal's hold sentence (the backend's `line`) while its hold is on, else null: the bar and
 * the Updates add it after their own line, and it goes at the hold's end without a reload. */
export function useHoldLine(hold: Partial<ProposalLedgerHold> | null | undefined): string | null {
  return proposalHoldLine(hold, useNowUntil(hold?.until));
}
