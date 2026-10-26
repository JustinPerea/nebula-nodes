import { useUIStore } from '../store/uiStore';
import { isModalDialogOpen } from './canvasShortcutScope';

/**
 * When the command palette opens, shared by the palette (a deferred chunk,
 * components/CommandPalette.tsx) and its eager wrapper, which holds a ⌘K that
 * arrives before the chunk (components/DeferredPanels.tsx, lib/heldIntents.ts).
 */

/** The rail's palette button (WorkspaceRail.tsx) asks with this window event. */
export const COMMAND_PALETTE_OPEN_EVENT = 'nebula:command-palette-open';

/** ⌘K / Ctrl+K toggles the palette, except in the video editors, whose own ⌘K cuts at the playhead,
 * and while a modal dialog is open: its "Run graph" would run behind the dialog (review 7, M-1). */
export function isPaletteHotkey(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || (event.key !== 'k' && event.key !== 'K')) return false;
  if (isModalDialogOpen()) return false;
  const viewMode = useUIStore.getState().viewMode;
  return viewMode !== 'editor' && viewMode !== 'remotion-editor';
}

/** The rail's button opens it on the canvas only. */
export function paletteOpenRequestApplies(): boolean {
  return useUIStore.getState().viewMode === 'canvas';
}
