import type { ViewMode } from '../store/uiStore';

const LABELS: Record<ViewMode, string> = {
  canvas: 'Canvas', editor: 'Video editor', 'remotion-editor': 'Composition',
  'cinema-editor': 'Cinema', 'character-editor': 'Character', 'moodboard-editor': 'Moodboard',
  create: 'Creator Studio', 'brand-showcase': 'Brand showcase', commons: 'Commons',
};

export function workspaceLabel(view: ViewMode): string { return LABELS[view]; }

/**
 * PR #204 round 18d follow-up (GM r33 3): where a screen's back button goes, and what it says, from
 * one place so the two never disagree. With a project open it goes back to the screen the person
 * came from ("← Canvas"); with none open (the Commons-off view after a reload) it goes to the
 * Projects home and says so ("← Projects", its accessible name starting "Projects").
 */
export interface BackTarget { label: string; ariaLabel: string; toProjects: boolean }
export function backTarget(returnView: ViewMode, projectOpen: boolean): BackTarget {
  if (!projectOpen) return { label: 'Projects', ariaLabel: 'Projects', toProjects: true };
  const label = workspaceLabel(returnView);
  return { label, ariaLabel: `Back to ${label}`, toProjects: false };
}
