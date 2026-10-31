import { create } from 'zustand';
import type { Viewport } from '@xyflow/react';

/**
 * Moodboard Studio's Board view (moodboard canvas PR5): which view the
 * Studio shows, and, per board draft, the selected cards and the camera.
 *
 * The board is a second React Flow canvas with its own provider (plan C1);
 * none of this touches the main canvas's stores (graphStore, uiStore's
 * canvasViewport or canvasZoomedOut). Selection lives here, not in the
 * board's React Flow store, so the side panel and the Studio's keys
 * (outside that provider) can read it.
 *
 * The Board / List switch is the viewer's own choice, kept in this browser
 * (localStorage, every read and write in try/catch: a private window or
 * blocked site data just falls back to List). List stays the default while
 * the Board view is a preview; PR6 makes Board the default.
 */

export type MoodboardView = 'board' | 'list';
export const MOODBOARD_VIEW_KEY = 'nebula:moodboard-view';
export const DEFAULT_MOODBOARD_VIEW: MoodboardView = 'list';

export function loadMoodboardView(): MoodboardView {
  try {
    const saved = window.localStorage.getItem(MOODBOARD_VIEW_KEY);
    return saved === 'board' || saved === 'list' ? saved : DEFAULT_MOODBOARD_VIEW;
  } catch {
    return DEFAULT_MOODBOARD_VIEW;
  }
}

function saveMoodboardView(view: MoodboardView): void {
  try {
    window.localStorage.setItem(MOODBOARD_VIEW_KEY, view);
  } catch {
    // Not kept for next time; this visit still switches.
  }
}

const sameIds = (a: readonly string[] | undefined, b: readonly string[]) =>
  a !== undefined && a.length === b.length && a.every((id, index) => id === b[index]);

/** The saved board Moodboard Studio has open: its id, its draft key, and its
 *  image ids in board order (an image's number is its place + 1, plan C7).
 *  The Updates corner reads it to show that board's own Updates (Q113 c). */
export interface StudioBoard {
  boardId: string;
  boardKey: string;
  imageIds: string[];
}

interface BoardCanvasState {
  view: MoodboardView;
  setView: (view: MoodboardView) => void;
  /** Selected cards (placement ids) per board draft key. */
  selection: Record<string, string[]>;
  setSelection: (boardKey: string, placementIds: string[]) => void;
  /** The camera per board draft key, for this visit: back to List and to Board keeps it. */
  viewports: Record<string, Viewport>;
  /** Whether that camera was where a whole-board fit left it (#209: a board kept
   *  fitted refits when its column resizes; components/moodboard-studio/boardFitFollow.ts). */
  fitted: Record<string, boolean>;
  setViewport: (boardKey: string, viewport: Viewport, fitted?: boolean) => void;
  /** Published by the Studio while it has a saved board open; null otherwise. */
  studioBoard: StudioBoard | null;
  setStudioBoard: (board: StudioBoard | null) => void;
  /** An Update's Show (Q113 c): the Studio on `boardId` selects these images'
   *  cards in the Board view and frames them. Taken (set to null) once handled. */
  showRequest: { boardId: string; imageIds: string[]; seq: number } | null;
  requestShow: (boardId: string, imageIds: string[]) => void;
  /** The Board view on `boardKey` springs its camera to these cards, then clears it. */
  frameRequest: { boardKey: string; placementIds: string[]; seq: number } | null;
  requestFrame: (boardKey: string, placementIds: string[]) => void;
}

let requestSeq = 0;
const sameBoard = (a: StudioBoard | null, b: StudioBoard | null) => (a === null || b === null
  ? a === b
  : a.boardId === b.boardId && a.boardKey === b.boardKey && sameIds(a.imageIds, b.imageIds));

export const useBoardCanvasStore = create<BoardCanvasState>((set, get) => ({
  view: loadMoodboardView(),
  setView: (view) => {
    saveMoodboardView(view);
    if (get().view !== view) set({ view });
  },
  selection: {},
  setSelection: (boardKey, placementIds) => {
    if (sameIds(get().selection[boardKey], placementIds)) return;
    set((state) => ({ selection: { ...state.selection, [boardKey]: placementIds } }));
  },
  viewports: {},
  fitted: {},
  setViewport: (boardKey, viewport, fitted = false) => set((state) => ({ viewports: { ...state.viewports,
    [boardKey]: { x: viewport.x, y: viewport.y, zoom: viewport.zoom } }, fitted: { ...state.fitted, [boardKey]: fitted } })),
  studioBoard: null,
  setStudioBoard: (board) => {
    if (!sameBoard(get().studioBoard, board)) set({ studioBoard: board });
  },
  showRequest: null,
  requestShow: (boardId, imageIds) => set({ showRequest: { boardId, imageIds: [...imageIds], seq: ++requestSeq } }),
  frameRequest: null,
  requestFrame: (boardKey, placementIds) => set({
    frameRequest: { boardKey, placementIds: [...placementIds], seq: ++requestSeq } }),
}));

const NO_SELECTION: string[] = [];

/** The board's selected cards (a stable empty list when none). */
export function useBoardSelection(boardKey: string): string[] {
  return useBoardCanvasStore((state) => state.selection[boardKey] ?? NO_SELECTION);
}
