import { clockTime } from './clockTime';
import { isRealCalendarDay, writtenDay } from './writtenDate';

// Its own module: the first load pulls in writtenDay and writtenTime, and most callers of this one are lazy.

type Moment = string | number | Date | null | undefined;

/**
 * A stored moment written out with its time (design): "November 20, 3:00 AM", or
 * "November 20, 2025, 3:00 AM" when the year isn't the current one. Local time, no seconds, the clock
 * written "3:00 AM" in every locale (`clockTime`). A date with no time of day (`2026-11-20`) reads as
 * `writtenDate` does. A value that isn't a date reads as it came; null and undefined read ''.
 */
export function writtenDateTime(stored: Moment, now: Date = new Date()): string {
  if (stored == null) return '';
  // An impossible day ("2026-02-30") would roll into the next month: it reads as it came.
  if (typeof stored === 'string' && !isRealCalendarDay(stored)) return stored;
  // A date with no time is read as written, in local time: no moment to convert.
  const dateOnly = typeof stored === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored);
  const moment = new Date(dateOnly ? `${stored}T00:00` : stored);
  if (Number.isNaN(+moment)) return stored instanceof Date ? '' : String(stored);
  return writtenDay(moment, now) + (dateOnly ? '' : `, ${clockTime(moment)}`);
}
