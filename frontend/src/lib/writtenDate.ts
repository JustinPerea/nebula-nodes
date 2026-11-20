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
