import { useEffect, useState } from 'react';
import { proposalHoldLine, type ProposalLedgerHold } from '../lib/ledgerHold';

/** The longest delay setTimeout takes (a larger one fires at once). */
const MAX_DELAY_MS = 2 ** 31 - 1;

/** The next local midnight after `at` (ms), from the Date constructor in local time, so a day
 * that is 23 or 25 hours long (DST) still ends at its own midnight. */
export function nextLocalMidnight(at: number): number {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
}

/**
 * The current time (ms), read again when `untilSeconds` (epoch seconds) arrives or changes, at the
 * next local midnight while it is ahead (so "tomorrow" becomes the time alone), and when it passes:
 * one timer, cleared on unmount and when `untilSeconds` changes, so what depends on it changes
 * without a reload. A delay past the timer's limit is clamped and set again when it fires.
 */
export function useNowUntil(untilSeconds: number | null | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  const [seen, setSeen] = useState(untilSeconds);
  // The hold may arrive or change after mount (the view loads): it is compared with the clock at
  // that moment, in this render, so an end already past never shows for a frame (review of
  // PR #242 round 2, L7).
  let current = now;
  if (seen !== untilSeconds) {
    // Read once per change of `untilSeconds` (the state update below makes the next render skip
    // this), so the result is the same however often React renders in between.
    // eslint-disable-next-line react-hooks/purity -- the check of PR #242 round 2 (L7) asks for the clock at this render
    current = Date.now();
    setSeen(untilSeconds);
    setNow(current);
  }
  const valid = typeof untilSeconds === 'number' && Number.isFinite(untilSeconds);
  // `now` re-runs this after each reading, so the next timer is set from it.
  useEffect(() => {
    if (!valid) return;
    const end = untilSeconds * 1000;
    if (now >= end) return;
    const at = Date.now();
    const delay = Math.max(0, Math.min(end, nextLocalMidnight(at)) - at);
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, MAX_DELAY_MS));
    return () => clearTimeout(timer);
  }, [valid, untilSeconds, now]);
  return current;
}

/** A proposal's hold sentence (the backend's `line`) while its hold is on, else null: the bar and
 * the Updates add it after their own line, and it goes at the hold's end without a reload. */
export function useHoldLine(hold: Partial<ProposalLedgerHold> | null | undefined): string | null {
  return proposalHoldLine(hold, useNowUntil(hold?.until));
}
