/** How long a project stays in Recently deleted, as the list says it
 * (GM r7 of PR #199, bug 2). */
const DAY_MS = 86_400_000;

/** Whole days left in Recently deleted (GM r7, bug 2): the window less the
 * whole days since the delete, so a project deleted today reads the whole
 * window (30), never 31. Counted from `deletedAt`, as durations: no time
 * zone or summer-time shift changes it, and a clock read before the delete
 * (the list opened, then a project deleted) can't add a day. */
export function daysLeft(deletedAt: string, purgeAt: string, now: number): number {
  const deleted = Date.parse(deletedAt);
  const purge = Date.parse(purgeAt);
  if (!Number.isFinite(purge)) return 0;
  if (!Number.isFinite(deleted) || purge <= deleted) {
    return Math.max(0, Math.ceil((purge - now) / DAY_MS));
  }
  const span = Math.round((purge - deleted) / DAY_MS);
  const elapsed = Math.floor(Math.max(0, now - deleted) / DAY_MS);
  return Math.max(0, Math.min(span, span - elapsed));
}

export function removalNote(deletedAt: string, purgeAt: string, now: number): string {
  const days = daysLeft(deletedAt, purgeAt, now);
  return days <= 1 ? 'Removed for good within a day' : `Removed for good in ${days} days`;
}
