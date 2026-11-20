import { clockTime } from './clockTime';

// Date and time written out (design). Kept free of heavy imports: the first load pulls this in.

/** "November 20", or "November 20, 2025" when the year isn't the current one. The month is spelled
 *  out in English whatever the browser's locale: the written form is one form app-wide. */
export function writtenDay(date: Date, now: Date = new Date()): string {
  const name = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  return date.getFullYear() === now.getFullYear() ? name : `${name}, ${date.getFullYear()}`;
}

type Moment = string | number | Date | null | undefined;

/** The time of day alone, "3:00 AM" (design: no seconds). A value that isn't a date, and null and
 *  undefined, read ''. */
export function writtenTime(stored: Moment): string {
  const moment = new Date(stored ?? NaN);
  return Number.isNaN(+moment) ? '' : clockTime(moment);
}

/** Whether a stored "YYYY-MM-DD…" names a day that exists ("2026-02-30" does not): `new Date` rolls such a day into the next month, so the parts are checked first. A string with no date prefix passes (the caller's own parse decides). */
export function isRealCalendarDay(stored: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(stored);
  if (!match) return true;
  const [year, month, day] = [+match[1], +match[2], +match[3]];
  const check = new Date(Date.UTC(2000, month - 1, day));
  check.setUTCFullYear(year);
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}
