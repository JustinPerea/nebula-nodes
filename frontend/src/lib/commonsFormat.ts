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

/** Present the local human as "You" while retaining stored actor IDs unchanged. */
export function actorLabel(actor: string): string {
  if (actor === 'human:justin') return 'You';
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
