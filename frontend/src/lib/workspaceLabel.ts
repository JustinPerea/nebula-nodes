import type { ViewMode } from '../store/uiStore';

const LABELS: Record<ViewMode, string> = {
  canvas: 'Canvas', editor: 'Video editor', 'remotion-editor': 'Composition',
  'cinema-editor': 'Cinema', 'character-editor': 'Character', 'moodboard-editor': 'Moodboard',
  create: 'Create', 'brand-showcase': 'Brand showcase', commons: 'Commons',
};

export function workspaceLabel(view: ViewMode): string { return LABELS[view]; }
