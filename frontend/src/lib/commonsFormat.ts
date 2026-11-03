import { analysisFailureIsNeutral } from './commonsAnalysisCopy';
import type { AnalysisState } from './commonsTypes';

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
