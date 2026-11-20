import { clockTime } from './clockTime';

// Date and time written out (design). Kept free of heavy imports: the first load pulls this in.

/** "November 20", or "November 20, 2025" when the year isn't the current one. The month is spelled
 *  out in English whatever the browser's locale: the written form is one form app-wide. */
export function writtenDay(date: Date, now: Date = new Date()): string {
  const name = date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  return date.getFullYear() === now.getFullYear() ? name : `${name}, ${date.getFullYear()}`;
}

type Moment = string | number | Date | null | undefined;

/**
 * A stored moment written out with its time (design): "November 20, 3:00 AM", or
 * "November 20, 2025, 3:00 AM" when the year isn't the current one. Local time, no seconds, the clock
 * written "3:00 AM" in every locale (`clockTime`). A date with no time of day (`2026-11-20`) reads as
 * `writtenDate` does. A value that isn't a date reads as it came; null and undefined read ''.
 */
export function writtenDateTime(stored: Moment, now: Date = new Date()): string {
  if (stored == null) return '';
  // A date with no time is read as written, in local time: no moment to convert.
  const dateOnly = typeof stored === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored);
  const moment = new Date(dateOnly ? `${stored}T00:00` : stored);
  if (Number.isNaN(+moment)) return stored instanceof Date ? '' : String(stored);
  return dateOnly ? writtenDay(moment, now) : `${writtenDay(moment, now)}, ${clockTime(moment)}`;
}

/** The time of day alone, "3:00 AM" (design: no seconds). A value that isn't a date, and null and
 *  undefined, read ''. */
export function writtenTime(stored: Moment): string {
  const moment = new Date(stored ?? NaN);
  return Number.isNaN(+moment) ? '' : clockTime(moment);
}
