import { analysisFailureIsNeutral } from './commonsAnalysisCopy';
import type { AnalysisState, Collection } from './commonsTypes';

export const STATE_LABELS: Record<AnalysisState, string> = {
  held: 'held', queued: 'queued', analyzing: 'analyzing', analysis_failed: 'failed', ready: 'ready',
};

/** An asset's analysis badge: its label and `commons-badge--<modifier>`. A
 *  failure that isn't an error (too transparent: nothing broke) wears the
 *  neutral, muted badge and says "Not analyzed", never a red "failed"
 *  (GM r6 on #208, item 2). */
export function analysisBadge(state: AnalysisState, kind?: string | null): { label: string; modifier: string } {
  if (state === 'analysis_failed' && analysisFailureIsNeutral(kind)) return { label: 'Not analyzed', modifier: 'not-analyzed' };
  return { label: STATE_LABELS[state], modifier: state };
}

/**
 * Present the local human as "You" while retaining stored actor IDs unchanged. "You" leads a
 * line (a comment's author); mid-sentence ("Added by you") pass `{ midSentence: true }`
 * (design). Other names read the same either way.
 */
export function actorLabel(actor: string, opts: { midSentence?: boolean } = {}): string {
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
