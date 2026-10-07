import type { AnalysisState } from './commonsTypes';

export const STATE_LABELS: Record<AnalysisState, string> = {
  held: 'held', queued: 'queued', analyzing: 'analyzing', analysis_failed: 'failed', ready: 'ready',
};

/** Present the local human as "You" while retaining stored actor IDs unchanged. */
export function actorLabel(actor: string): string {
  if (actor === 'human:justin') return 'You';
  if (actor.startsWith('human:')) return actor.slice(6);
  if (actor === 'import:moodboard') return 'moodboard note';
  return actor;
}
