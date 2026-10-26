import { create } from 'zustand';
import { wsClient } from '../lib/wsClient';
import {
  dismissAgentNote,
  fetchAgentNotes,
  isUnread,
  markAgentNotesRead,
  sanitizeNote,
  sanitizeNotes,
  surfaceKey,
  type AgentNote,
  type AgentNotesEvent,
  type AgentNotesSurface,
} from '../lib/agentNotes';
import { failureMessage } from '../lib/errorCopy';

/**
 * Updates for every surface, keyed `canvas:<projectId>` and `board:<boardId>`.
 * Imported at startup (App.tsx) so no socket message is missed before the
 * corner's chunk lands; the corner itself is deferred (lib/deferredChunks.ts).
 */

export const EMPTY_LIST: SurfaceList = { notes: [], unread: 0, loaded: false };

export interface SurfaceList {
  /** Newest first. */
  notes: AgentNote[];
  /** The server's count of updates with no readAt and no dismissedAt. */
  unread: number;
  loaded: boolean;
}

/** What to outline, in whose colour; `delayMs` + i × `staggerMs` per node. */
export interface OutlineSpec {
  refs: string[];
  color: string;
  delayMs: number;
  staggerMs: number;
}

/** A row hovered in the list beats a Show, which beats a card that is up. */
export type OutlineSource = 'hover' | 'show' | 'card';
const OUTLINE_ORDER: readonly OutlineSource[] = ['hover', 'show', 'card'];

export interface Arrival {
  key: string;
  id: string;
}

interface AgentNotesState {
  canvasProjectId: string | null;
  lists: Record<string, SurfaceList>;
  /** Added updates (never a sync) waiting for their card to drop. */
  arrivals: Arrival[];
  outlines: Partial<Record<OutlineSource, OutlineSpec>>;
  error: string | null;
  /** Bumped by every canvas socket message, so a slower fetch never overwrites a newer push. */
  canvasSeq: number;
  /** The board whose Updates show now (Moodboard Studio on it, Q113 c), or
   *  null. Only its added updates drop a card; another board's just wait.
   *  Set, and its list loaded, by the deferred corner (lib/agentNotesBoard.ts). */
  boardInView: string | null;
  /** Per board, bumped by each of its socket messages (as `canvasSeq`). */
  boardSeq: Record<string, number>;
  apply: (event: AgentNotesEvent) => void;
  hydrateCanvas: () => Promise<void>;
  markRead: (surface: AgentNotesSurface, upTo?: string) => Promise<void>;
  markReadIds: (surface: AgentNotesSurface, ids: string[]) => Promise<void>;
  dismiss: (surface: AgentNotesSurface, id: string) => Promise<void>;
  takeArrivals: (key: string) => string[];
  setOutline: (source: OutlineSource, spec: OutlineSpec | null) => void;
  activeOutline: () => OutlineSpec | null;
  clearError: () => void;
  reset: () => void;
}

const EMPTY = EMPTY_LIST;

function countUnread(notes: AgentNote[]): number {
  return notes.filter(isUnread).length;
}

function keyFor(state: Pick<AgentNotesState, 'canvasProjectId'>, surface: AgentNotesSurface): string {
  return surface.kind === 'canvas'
    ? surfaceKey({ kind: 'canvas', projectId: state.canvasProjectId })
    : surfaceKey(surface);
}

function iso(ms: number): string {
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
}

function withList(
  lists: Record<string, SurfaceList>,
  key: string,
  update: (list: SurfaceList) => SurfaceList,
): Record<string, SurfaceList> {
  return { ...lists, [key]: update(lists[key] ?? EMPTY) };
}

function initialState() {
  return {
    canvasProjectId: null as string | null,
    lists: {} as Record<string, SurfaceList>,
    arrivals: [] as Arrival[],
    outlines: {} as Partial<Record<OutlineSource, OutlineSpec>>,
    error: null as string | null,
    canvasSeq: 0,
    boardInView: null as string | null,
    boardSeq: {} as Record<string, number>,
  };
}

/** Send a read and take the server's count back; on failure, reload the list. */
async function sendRead(
  surface: AgentNotesSurface,
  key: string,
  send: () => Promise<{ unread: number }>,
): Promise<void> {
  const { getState, setState } = useAgentNotesStore;
  try {
    const result = await send();
    if (keyFor(getState(), surface) !== key || typeof result.unread !== 'number') return;
    setState((state) => ({ lists: withList(state.lists, key, (list) => ({ ...list, unread: result.unread })) }));
  } catch (error) {
    setState({ error: failureMessage(error, "Couldn't mark the notes read.") });
    // (A board's list is read again by the corner when this error shows.)
    if (surface.kind === 'canvas') void getState().hydrateCanvas();
  }
}

export const useAgentNotesStore = create<AgentNotesState>((set, get) => ({
  ...initialState(),

  apply: (event) => {
    const isCanvas = event.surface === 'canvas';
    if (!isCanvas && typeof event.boardId !== 'string') return;
    const projectId = typeof event.projectId === 'string' ? event.projectId : null;
    const key = isCanvas ? surfaceKey({ kind: 'canvas', projectId }) : surfaceKey({ kind: 'board', boardId: event.boardId! });
    const serverUnread = typeof event.unread === 'number' && Number.isFinite(event.unread) ? event.unread : null;

    if (isCanvas) set((state) => ({ canvasSeq: state.canvasSeq + 1 }));
    else set((state) => ({ boardSeq: { ...state.boardSeq, [key]: (state.boardSeq[key] ?? 0) + 1 } }));
    set((state) => {
      const switched = isCanvas && projectId !== state.canvasProjectId;
      const canvasProjectId = isCanvas ? projectId : state.canvasProjectId;
      // Another project's cards never drop over this one.
      const arrivals = switched ? state.arrivals.filter((a) => !a.key.startsWith('canvas:')) : state.arrivals;

      if (event.op === 'sync') {
        const notes = sanitizeNotes(event.notes);
        return {
          canvasProjectId,
          arrivals,
          lists: { ...state.lists, [key]: { notes, unread: serverUnread ?? countUnread(notes), loaded: true } },
        };
      }

      if (event.op === 'added') {
        const note = sanitizeNote(event.note);
        if (!note) return { canvasProjectId, arrivals };
        const removed = new Set(Array.isArray(event.removed) ? event.removed : []);
        const current = state.lists[key] ?? EMPTY;
        const seen = current.notes.some((n) => n.id === note.id);
        const notes = [note, ...current.notes.filter((n) => n.id !== note.id && !removed.has(n.id))];
        // A board's card drops only while that board is on screen; its
        // update still waits in the list, unread, for when it is opened.
        const shown = isCanvas || event.boardId === state.boardInView;
        return {
          canvasProjectId,
          lists: { ...state.lists, [key]: { notes, unread: serverUnread ?? countUnread(notes), loaded: current.loaded } },
          arrivals: seen || !isUnread(note) || !shown
            ? arrivals.filter((a) => !removed.has(a.id))
            : [...arrivals.filter((a) => !removed.has(a.id)), { key, id: note.id }],
        };
      }

      if (event.op === 'read') {
        const ids = new Set(Array.isArray(event.ids) ? event.ids : []);
        const at = iso(event.at);
        return {
          canvasProjectId,
          arrivals: arrivals.filter((a) => !ids.has(a.id)),
          lists: withList(state.lists, key, (list) => {
            const notes = list.notes.map((n) => (ids.has(n.id) && !n.readAt ? { ...n, readAt: at } : n));
            return { ...list, notes, unread: serverUnread ?? countUnread(notes) };
          }),
        };
      }

      // dismissed / acted: the server sends the update as it now is.
      const note = sanitizeNote(event.note);
      const ids = new Set([...(Array.isArray(event.ids) ? event.ids : []), ...(note ? [note.id] : [])]);
      const at = iso(event.at);
      return {
        canvasProjectId,
        arrivals: arrivals.filter((a) => !ids.has(a.id)),
        lists: withList(state.lists, key, (list) => {
          const notes = list.notes.map((n) => {
            if (note && n.id === note.id) return note;
            if (!ids.has(n.id)) return n;
            return event.op === 'dismissed' ? { ...n, dismissedAt: n.dismissedAt ?? at } : { ...n, actedAt: n.actedAt ?? at };
          });
          return { ...list, notes, unread: serverUnread ?? countUnread(notes) };
        }),
      };
    });
  },

  hydrateCanvas: async () => {
    const seq = get().canvasSeq;
    try {
      const listing = await fetchAgentNotes({ kind: 'canvas' });
      // The socket said something newer while this was in flight: keep that.
      if (get().canvasSeq !== seq) return;
      get().apply({
        type: 'agentNotes', surface: 'canvas', op: 'sync', projectId: listing.projectId ?? null,
        notes: listing.notes, unread: listing.unread, at: Date.now(),
      });
    } catch {
      // The socket's sync on (re)connect heals this.
    }
  },

  markRead: async (surface, upTo) => {
    const key = keyFor(get(), surface);
    const now = new Date().toISOString();
    set((state) => ({
      arrivals: state.arrivals.filter((a) => a.key !== key),
      lists: withList(state.lists, key, (list) => {
        // Newest first: everything from `upTo` down is read.
        const start = upTo ? list.notes.findIndex((n) => n.id === upTo) : 0;
        if (start < 0) return list;
        const notes = list.notes.map((n, index) => (index >= start && !n.readAt ? { ...n, readAt: now } : n));
        return { ...list, notes, unread: countUnread(notes) };
      }),
    }));
    await sendRead(surface, key, () => markAgentNotesRead(surface, upTo));
  },

  markReadIds: async (surface, ids) => {
    if (ids.length === 0) return;
    const key = keyFor(get(), surface);
    const wanted = new Set(ids);
    const now = new Date().toISOString();
    set((state) => ({
      arrivals: state.arrivals.filter((a) => !wanted.has(a.id)),
      lists: withList(state.lists, key, (list) => {
        const notes = list.notes.map((n) => (wanted.has(n.id) && !n.readAt ? { ...n, readAt: now } : n));
        return { ...list, notes, unread: countUnread(notes) };
      }),
    }));
    await sendRead(surface, key, () => markAgentNotesRead(surface, undefined, ids));
  },

  dismiss: async (surface, id) => {
    const key = keyFor(get(), surface);
    const before = (get().lists[key] ?? EMPTY).notes.find((n) => n.id === id);
    if (!before) return;
    const now = new Date().toISOString();
    set((state) => ({
      arrivals: state.arrivals.filter((a) => a.id !== id),
      lists: withList(state.lists, key, (list) => {
        const notes = list.notes.map((n) => (n.id === id ? { ...n, dismissedAt: n.dismissedAt ?? now } : n));
        return { ...list, notes, unread: countUnread(notes) };
      }),
    }));
    try {
      await dismissAgentNote(surface, id);
    } catch (error) {
      set((state) => ({
        error: failureMessage(error, "Couldn't dismiss the note."),
        lists: withList(state.lists, key, (list) => {
          const notes = list.notes.map((n) => (n.id === id ? before : n));
          return { ...list, notes, unread: countUnread(notes) };
        }),
      }));
    }
  },

  takeArrivals: (key) => {
    const mine = get().arrivals.filter((a) => a.key === key);
    if (mine.length === 0) return [];
    set((state) => ({ arrivals: state.arrivals.filter((a) => a.key !== key) }));
    return mine.map((a) => a.id);
  },

  setOutline: (source, spec) => set((state) => {
    const outlines = { ...state.outlines };
    if (spec && spec.refs.length > 0) outlines[source] = spec;
    else delete outlines[source];
    return { outlines };
  }),

  activeOutline: () => {
    const { outlines } = get();
    for (const source of OUTLINE_ORDER) {
      const spec = outlines[source];
      if (spec) return spec;
    }
    return null;
  },

  clearError: () => set({ error: null }),
  reset: () => set(initialState()),
}));

/** The open project's list (the main canvas's surface). */
export function selectCanvasList(state: Pick<AgentNotesState, 'canvasProjectId' | 'lists'>): SurfaceList {
  return state.lists[surfaceKey({ kind: 'canvas', projectId: state.canvasProjectId })] ?? EMPTY;
}

/** The outline to draw now, for selectors (hover > show > card). */
export function selectActiveOutline(state: Pick<AgentNotesState, 'outlines'>): OutlineSpec | null {
  for (const source of OUTLINE_ORDER) {
    const spec = state.outlines[source];
    if (spec) return spec;
  }
  return null;
}

wsClient.subscribe((event) => {
  if (event.type === 'agentNotes') useAgentNotesStore.getState().apply(event);
});
