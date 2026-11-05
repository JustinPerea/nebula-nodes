import { create } from 'zustand';
import { failureCopy, type FailureCopy } from '../lib/errorCopy';
import {
  READING_FAILED_HEADING, fetchBoardReading, startBoardReading, stopBoardReading, undoBoardReading,
  type BoardReadingRun, type BoardReadingState, type ReadingRoute,
} from '../lib/boardReading';

/**
 * Read the board (lib/boardReading.ts) in Moodboard Studio: each board's
 * reading as the server last said, the read under way, and which part of the
 * Board view's side panel shows (Settings or Reading, GM section 1).
 *
 * The server owns the reading and the run; this only mirrors them. A run's
 * start, landing, failure and stop come on the socket (boardReadingRun), a
 * board save as storedAssetChanged, and a reconnect reads it all again
 * (useBoardReadingSync in components/moodboard-studio/BoardReadingPanel).
 */

export type BoardPanelTab = 'settings' | 'reading';

export interface BoardReadingEntry {
  state: BoardReadingState | null;
  loadError: FailureCopy | null;
  /** A start, stop or undo the server refused (a lock, a read already running). */
  actionError: FailureCopy | null;
  busy: 'start' | 'stop' | 'undo' | null;
  /** When `state.run` came, so the timer counts on from its elapsedMs without trusting two clocks. */
  runAt: number;
}

/** A read that landed over an earlier one: the Studio's "Replaced the reading · Undo" toast. */
export interface ReplacedReading {
  boardId: string;
  readingId: string;
  seq: number;
}

interface BoardReadingStoreState {
  boards: Record<string, BoardReadingEntry>;
  tab: BoardPanelTab;
  setTab: (tab: BoardPanelTab) => void;
  replaced: ReplacedReading | null;
  clearReplaced: () => void;
  load: (boardId: string) => Promise<void>;
  start: (boardId: string, route?: 'auto' | ReadingRoute) => Promise<void>;
  stop: (boardId: string) => Promise<void>;
  undo: (boardId: string, readingId: string) => Promise<void>;
  /** The socket's word on a run. */
  takeRun: (boardId: string, run: BoardReadingRun) => void;
}

const EMPTY: BoardReadingEntry = { state: null, loadError: null, actionError: null, busy: null, runAt: 0 };
let seq = 0;
/** The newest load per board: an older answer that lands later is dropped. */
const loads: Record<string, number> = {};

export const useBoardReadingStore = create<BoardReadingStoreState>((set, get) => {
  const entry = (boardId: string) => get().boards[boardId] ?? EMPTY;
  const put = (boardId: string, patch: Partial<BoardReadingEntry>) =>
    set((state) => ({ boards: { ...state.boards, [boardId]: { ...(state.boards[boardId] ?? EMPTY), ...patch } } }));

  return {
    boards: {},
    tab: 'settings',
    setTab: (tab) => { if (get().tab !== tab) set({ tab }); },
    replaced: null,
    clearReplaced: () => set({ replaced: null }),

    load: async (boardId) => {
      const ticket = (loads[boardId] = (loads[boardId] ?? 0) + 1);
      const before = entry(boardId).state?.reading?.id ?? null;
      try {
        const next = await fetchBoardReading(boardId);
        if (loads[boardId] !== ticket) return;
        put(boardId, { state: next, loadError: null, runAt: Date.now() });
        // A read that landed over an earlier one, seen by this tab: offer Undo.
        const now = next.reading?.id ?? null;
        if (before && now && now !== before && next.hasPrevious && next.run?.readingId === now) {
          set({ replaced: { boardId, readingId: now, seq: ++seq } });
        }
      } catch (error) {
        if (loads[boardId] !== ticket) return;
        put(boardId, { loadError: failureCopy(error, { heading: "Couldn't load the reading." }) });
      }
    },

    start: async (boardId, route = 'auto') => {
      if (entry(boardId).busy) return;
      put(boardId, { busy: 'start', actionError: null });
      try {
        const { run } = await startBoardReading(boardId, route);
        get().takeRun(boardId, run);
        put(boardId, { busy: null });
      } catch (error) {
        put(boardId, { busy: null, actionError: failureCopy(error, { heading: READING_FAILED_HEADING }) });
        void get().load(boardId);
      }
    },

    stop: async (boardId) => {
      if (entry(boardId).busy) return;
      put(boardId, { busy: 'stop', actionError: null });
      try {
        await stopBoardReading(boardId);
        put(boardId, { busy: null });
      } catch (error) {
        put(boardId, { busy: null, actionError: failureCopy(error, { heading: "Couldn't stop the read." }) });
      }
      void get().load(boardId);
    },

    undo: async (boardId, readingId) => {
      if (entry(boardId).busy) return;
      put(boardId, { busy: 'undo', actionError: null });
      try {
        await undoBoardReading(boardId, readingId);
        put(boardId, { busy: null });
      } catch (error) {
        put(boardId, { busy: null, actionError: failureCopy(error, { heading: "Couldn't put the earlier reading back." }) });
      }
      void get().load(boardId);
    },

    takeRun: (boardId, run) => {
      const current = entry(boardId);
      const state = current.state;
      // An older run's word after a newer one started is dropped.
      if (state?.run && state.run.id !== run.id && state.run.status === 'running' && run.startedAt < state.run.startedAt) return;
      if (state) put(boardId, { state: { ...state, run }, runAt: Date.now() });
      // A landed read changes the reading itself: read it all again.
      if (run.status !== 'running' || !state) void get().load(boardId);
    },
  };
});

/** This board's entry (a stable empty one before the first load). */
export function useBoardReading(boardId: string | null): BoardReadingEntry {
  return useBoardReadingStore((state) => (boardId ? state.boards[boardId] : undefined) ?? EMPTY);
}

/** Whether a read is running on this board (the Reading switch's activity dot). */
export function useReadingRunning(boardId: string | null): boolean {
  return useBoardReadingStore((state) => Boolean(boardId) && state.boards[boardId!]?.state?.run?.status === 'running');
}
