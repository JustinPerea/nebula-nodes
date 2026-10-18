import { create } from 'zustand';
import type { ArrangeDirection, ArrangeRequest } from '../lib/arrangeEdit';

/**
 * Agent edits waiting for this canvas to lay out their new nodes. graphSync
 * carries the backend's full list every time, so this store only mirrors it
 * (services/canvas_arrange.py; ArrangeController does the work).
 */
interface ArrangeState {
  pending: ArrangeRequest[];
  /** Requests this tab is done with: it wrote them, another tab won, or it gave up. */
  finished: string[];
  setPending: (raw: unknown) => void;
  markFinished: (id: string) => void;
}

/**
 * True while this tab still has an arrange to measure. The canvas then
 * renders every node, even off screen (onlyRenderVisibleElements is off),
 * because a node that isn't rendered has no size to lay out by.
 */
export function selectMeasuring(state: Pick<ArrangeState, 'pending' | 'finished'>): boolean {
  return state.pending.some((request) => !state.finished.includes(request.id));
}

function cleanRequests(raw: unknown): ArrangeRequest[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): ArrangeRequest[] => {
    if (!item || typeof item !== 'object') return [];
    const { id, nodeIds, direction, gap } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !Array.isArray(nodeIds)) return [];
    const ids = nodeIds.filter((nodeId): nodeId is string => typeof nodeId === 'string');
    if (ids.length === 0) return [];
    return [{
      id,
      nodeIds: ids,
      direction: (direction === 'down' ? 'down' : 'right') as ArrangeDirection,
      gap: typeof gap === 'number' && Number.isFinite(gap) && gap >= 0 ? gap : 120,
    }];
  });
}

export const useArrangeStore = create<ArrangeState>((set, get) => ({
  pending: [],
  finished: [],
  setPending: (raw) => {
    const next = cleanRequests(raw);
    const now = get().pending;
    // Keep the same array when nothing changed, so watchers don't restart on every sync.
    if (JSON.stringify(next) === JSON.stringify(now)) return;
    // Forget finished ids the backend no longer lists, so the list stays small.
    const open = new Set(next.map((request) => request.id));
    set({ pending: next, finished: get().finished.filter((id) => open.has(id)) });
  },
  markFinished: (id) => {
    if (get().finished.includes(id)) return;
    set({ finished: [...get().finished, id] });
  },
}));
