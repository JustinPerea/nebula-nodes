import { analysisFailureIsNeutral } from './commonsAnalysisCopy';
import { clockTime } from './clockTime';
import { capitalised, type AnalysisState, type Collection } from './commonsTypes';

export const STATE_LABELS: Record<AnalysisState, string> = {
  held: 'Held', queued: 'Queued', analyzing: 'Analyzing', analysis_failed: 'Failed', ready: 'Ready',
};

/** An asset's analysis badge: its label and `commons-badge--<modifier>`. A
 *  failure that isn't an error (too transparent: nothing broke) wears the
 *  neutral, muted badge and says "Not analyzed", never a red "failed"
 *  (GM r6 on #208, item 2). */
export function analysisBadge(state: AnalysisState | null | undefined, kind?: string | null): { label: string; modifier: string } {
  if (state === 'analysis_failed' && analysisFailureIsNeutral(kind)) return { label: 'Not analyzed', modifier: 'not-analyzed' };
  if (!state) return { label: '', modifier: '' };
  return { label: Object.hasOwn(STATE_LABELS, state) ? STATE_LABELS[state] : capitalised(state.replaceAll('_', ' ')), modifier: state };
}

/**
 * Present the local human as "You" while retaining stored actor IDs unchanged. "You" leads a
 * line (a comment's author); mid-sentence ("Added by you") pass `{ midSentence: true }`
 * (design). Other names read the same either way.
 */
export function actorLabel(actor: string | null | undefined, opts: { midSentence?: boolean } = {}): string {
  if (!actor) return '';
  if (actor === 'human:justin') return opts.midSentence ? 'you' : 'You';
  if (actor.startsWith('human:')) return actor.slice(6);
  if (actor === 'import:moodboard') return 'moodboard note';
  return actor;
}

/**
 * PR #204 round 18e (GM r33): a linked folder's own name, for "Linked “moodboards”. Scanning it
 * now.": the path's last segment, by either separator (macOS, Windows), ignoring trailing ones.
 * Never empty: a root ("/", "C:\") names itself.
 */
export function folderName(path: string): string {
  const whole = path.trim();
  const trimmed = whole.replace(/[\\/]+$/, '');
  if (!trimmed) return whole || path;
  return trimmed.split(/[\\/]/).at(-1) || trimmed;
}

/** GM r33, verbatim: the notice after a folder is linked; its full path goes in the title. */
export function linkedFolderNotice(path: string): string {
  return `Linked “${folderName(path)}”. Scanning it now.`;
}

/** PR #204 round 18f (review 15 MEDIUM-1, logic lens): a collection made while the list's re-read
 * failed joins the kept list (once), so Add to can show it. */
export function withCollection(list: readonly Collection[], created: Collection): Collection[] {
  return list.some((c) => c.id === created.id) ? [...list] : [...list, created];
}

const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A stored date written out (design): "November 20", with the year only when it isn't the current
 * one ("November 20, 2025"). A timestamp ('…T02:00:00Z', a comment's `created_at`) is the person's
 * local calendar day, and its year is compared with the local year, so a comment written on
 * December 31 in the evening doesn't read as January 1 of next year. A date with no time
 * (`2026-11-20`, a source's own date) is read as written: there is no moment to convert. A value
 * with no date in front is returned as it came.
 */
export function writtenDate(stored: string, now: Date = new Date()): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(stored);
  if (!match || !LONG_MONTHS[Number(match[2]) - 1]) return stored;
  let year = Number(match[1]);
  let month = Number(match[2]) - 1;
  let day = Number(match[3]);
  if (match[4]) {
    const moment = new Date(stored);
    if (!Number.isNaN(moment.getTime())) {
      year = moment.getFullYear();
      month = moment.getMonth();
      day = moment.getDate();
    }
  }
  const name = `${LONG_MONTHS[month]} ${day}`;
  return year === now.getFullYear() ? name : `${name}, ${year}`;
}

type Moment = string | number | Date | null | undefined;

function toMoment(stored: Moment): Date | null {
  if (stored === null || stored === undefined || stored === '') return null;
  const moment = stored instanceof Date ? stored : new Date(stored);
  return Number.isNaN(moment.getTime()) ? null : moment;
}

/**
 * A stored moment written out with its time (design): "November 20, 3:00 AM", or
 * "November 20, 2025, 3:00 AM" when the year isn't the current one. Local time, no seconds, the clock
 * written "3:00 AM" in every locale (`clockTime`). A date with no time of day (`2026-11-20`) reads as
 * `writtenDate` does. A value that isn't a date reads as it came; null and undefined read ''.
 */
export function writtenDateTime(stored: Moment, now: Date = new Date()): string {
  if (stored === null || stored === undefined) return '';
  if (typeof stored === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(stored)) return writtenDate(stored, now);
  const moment = toMoment(stored);
  if (!moment) return stored === '' ? '' : String(stored instanceof Date ? '' : stored);
  const year = moment.getFullYear();
  const day = `${LONG_MONTHS[moment.getMonth()]} ${moment.getDate()}${year === now.getFullYear() ? '' : `, ${year}`}`;
  return `${day}, ${clockTime(moment)}`;
}

/** The time of day alone, "3:00 AM" (design: no seconds). A value that isn't a date reads as it
 *  came; null and undefined read ''. */
export function writtenTime(stored: Moment): string {
  if (stored === null || stored === undefined) return '';
  const moment = toMoment(stored);
  if (!moment) return stored instanceof Date ? '' : String(stored);
  return clockTime(moment);
}

/** What a folder scan's summary counts are called, in the order they read. Keys are the backend's
 *  (`scan_folder` in backend/commons/folders.py). */
export const SCAN_COUNT_WORDS: Record<string, string> = {
  added: 'added',
  changed: 'changed',
  restored: 'restored',
  archived: 'archived',
  missing: 'missing',
  downloading: 'downloading',
  failed: 'failed',
  unchanged: 'unchanged',
};

/**
 * A folder scan's summary as a line (design): the count first, "3 added · 2 changed". Known keys
 * read in the order above; an unknown key follows as "<n> <key with spaces>". A zero is left out,
 * and when nothing is left the line reads "nothing new". `failed` arrives as a list of files, so
 * its length is the count. Flags and other non-counts are not shown. No summary reads
 * "Not scanned yet".
 */
export function scanSummaryText(summary: Record<string, unknown> | null | undefined): string {
  if (!summary) return 'Not scanned yet';
  const counts = new Map<string, number>();
  for (const [key, value] of Object.entries(summary)) {
    if (typeof value === 'number' && Number.isFinite(value)) counts.set(key, value);
    else if (Array.isArray(value)) counts.set(key, value.length);
  }
  const known = Object.keys(SCAN_COUNT_WORDS).filter((key) => counts.has(key));
  const unknown = [...counts.keys()].filter((key) => !Object.hasOwn(SCAN_COUNT_WORDS, key));
  const parts = [...known, ...unknown]
    .filter((key) => counts.get(key) !== 0)
    .map((key) => `${counts.get(key)} ${Object.hasOwn(SCAN_COUNT_WORDS, key) ? SCAN_COUNT_WORDS[key] : key.replace(/_/g, ' ')}`);
  return parts.length > 0 ? parts.join(' · ') : 'nothing new';
}
