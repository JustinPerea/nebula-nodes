import { useUIStore } from '../store/uiStore';
import { keyBlockedByModal } from './canvasShortcutScope';

/**
 * When the command palette opens, shared by the palette (a deferred chunk,
 * components/CommandPalette.tsx) and its eager wrapper, which holds a ⌘K that
 * arrives before the chunk (components/DeferredPanels.tsx, lib/heldIntents.ts).
 */

/** The rail's palette button (WorkspaceRail.tsx) asks with this window event. */
export const COMMAND_PALETTE_OPEN_EVENT = 'nebula:command-palette-open';

/** ⌘K / Ctrl+K toggles the palette, except in the video editors, whose own ⌘K cuts at the playhead,
 * and while a modal dialog is open: its "Run canvas" would run behind the dialog (review 7, M-1).
 * The open palette is one (review 9, L-1): pass it as `palette`, and its own ⌘K still closes it
 * unless another modal dialog is on top of it. */
export function isPaletteHotkey(event: KeyboardEvent, palette: Element | null = null): boolean {
  if (!(event.metaKey || event.ctrlKey) || (event.key !== 'k' && event.key !== 'K')) return false;
  if (keyBlockedByModal(palette)) return false;
  const viewMode = useUIStore.getState().viewMode;
  return viewMode !== 'editor' && viewMode !== 'remotion-editor';
}

/** The rail's button opens it on the canvas only. */
export function paletteOpenRequestApplies(): boolean {
  return useUIStore.getState().viewMode === 'canvas';
}
