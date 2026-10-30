/** GM r8 (4), PR #204: when "Saved" settled, kept across a remount (a demote or a promote
 * remounts the header), so a header that comes back long after the save shows it folded instead
 * of replaying the fold, which narrowed the header by its 41 px as it ran. */
let settledSince: number | null = null;
/** How far into its settle "Saved" is, as the animation delay that puts it there (≤ 0 ms). */
export function settleDelay(settled: boolean, now = Date.now()): string | undefined {
  if (!settled) { settledSince = null; return undefined; }
  if (settledSince === null) settledSince = now;
  return now > settledSince ? `${settledSince - now}ms` : undefined;
}
/** Tests: forget the last settle. */
export function resetSettleForTests(): void { settledSince = null; }
