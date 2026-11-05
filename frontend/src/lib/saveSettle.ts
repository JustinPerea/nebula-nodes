import { useMemo } from 'react';

/** GM r8 (4), PR #204: when "Saved" settled, kept across a remount, so a header that comes back
 * long after the save shows it folded instead of replaying the fold, which narrowed the header by
 * its 41 px as it ran. Round 8 (review 6 LOW-2): what remounts the header is a screen change
 * (Canvas to Creator Studio mounts a new one); a demote or a promote re-renders it in place. */
let settledSince: number | null = null;
/** How far into its settle "Saved" is, as the animation delay that puts it there (≤ 0 ms). */
export function settleDelay(settled: boolean, now = Date.now()): string | undefined {
  if (!settled) { settledSince = null; return undefined; }
  if (settledSince === null) settledSince = now;
  return now > settledSince ? `${settledSince - now}ms` : undefined;
}
/**
 * The delay, taken once when the header mounts and again only when `settled` changes (review 6
 * LOW-1). Read on every render, a new negative delay moved the running fold to twice as far
 * along, so a re-render during the 2.6 s fold made "Saved" vanish in a frame.
 */
export function useSettleDelay(settled: boolean): string | undefined {
  return useMemo(() => settleDelay(settled), [settled]);
}
/** Tests: forget the last settle. */
export function resetSettleForTests(): void { settledSince = null; }
