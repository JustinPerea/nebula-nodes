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
import { failureMessage, markReadRefusedCopy } from '../lib/errorCopy';
import { clearLineOnPromote, isPersonRefusal, retryOnPromote } from '../lib/clearsOnPromote';
import { personUnconfirmed } from '../lib/personSession';
import { whenPerson } from '../lib/personWork';

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

/** What a read covers: every update up to `upTo` and older, every update (`all`), or just `ids`. */
interface ReadWanted {
  upTo?: string;
  ids?: string[];
}

/**
 * PR #204 round 13 (review 10 held-calls MEDIUM-1): the mark-read (POST …/agent-notes/read) is
 * the person's alone. On a tab that isn't connected as the person (held, demoted, or before the
 * socket's first answer) nothing is sent: one read per list waits, the newest `upTo` and every
 * id asked for, and goes once on the promote (lib/personWork whenPerson). No line: the updates
 * simply stay unread until the tab connects. A read refused after it went out (a demote while it
 * was in flight) joins the same wait.
 */
interface HeldRead {
  surface: AgentNotesSurface;
  all: boolean;
  upTo: string | null;
  ids: Set<string>;
}
const heldReads = new Map<string, HeldRead>();

/** Of two updates in a list (newest first), the newer; one that has left the list loses. */
function newerOf(key: string, a: string | null, b: string): string {
  if (a === null || a === b) return b;
  const notes = (useAgentNotesStore.getState().lists[key] ?? EMPTY).notes;
  const at = notes.findIndex((n) => n.id === a);
  const bt = notes.findIndex((n) => n.id === b);
  if (bt < 0) return at < 0 ? b : a;
  return at >= 0 && at < bt ? a : b;
}

/** Add a read to its list's wait (one per list key). */
function holdRead(surface: AgentNotesSurface, key: string, wanted: ReadWanted): void {
  const held = heldReads.get(key) ?? { surface, all: false, upTo: null, ids: new Set<string>() };
  if (wanted.ids) wanted.ids.forEach((id) => held.ids.add(id));
  else if (wanted.upTo) held.upTo = newerOf(key, held.upTo, wanted.upTo);
  else held.all = true;
  heldReads.set(key, held);
}

/** Send a list's waiting read, once: what is still unread of it, as one `upTo` (or all) read and
 * one read of the ids it doesn't cover. `retry` as sendRead's. */
function sendHeldRead(key: string, retry: boolean): void {
  const held = heldReads.get(key);
  heldReads.delete(key);
  if (!held) return;
  const state = useAgentNotesStore.getState();
  // Another project opened meanwhile: this list isn't the one on screen (its own open reads it).
  if (keyFor(state, held.surface) !== key) return;
  const notes = (state.lists[key] ?? EMPTY).notes;
  const at = held.all ? notes.length : held.upTo === null ? -1 : notes.findIndex((n) => n.id === held.upTo);
  if (held.all ? notes.some((n) => !n.readAt) : at >= 0 && notes.slice(at).some((n) => !n.readAt)) {
    void sendRead(held.surface, key, held.all ? {} : { upTo: held.upTo! }, retry);
  }
  const ids = [...held.ids].filter((id) => {
    const index = notes.findIndex((n) => n.id === id);
    return index >= 0 && (at < 0 || index < at) && !notes[index].readAt;
  });
  if (ids.length > 0) void sendRead(held.surface, key, { ids }, retry);
}

/**
 * Send a read; the Updates read only when the server says so (GM, #204 r3 item 1: the
 * header says "all read" for real or not at all), from its `ids` and count. On failure
 * nothing was read, so nothing changes but the line. A refusal only because this tab
 * isn't the person's: GM's line, gone on the promote, which sends the list's read once,
 * silently (`retry` false then: a second refusal adds no line).
 */
async function sendRead(surface: AgentNotesSurface, key: string, wanted: ReadWanted, retry = true): Promise<void> {
  const { getState, setState } = useAgentNotesStore;
  if (personUnconfirmed()) {
    // Not connected as the person: nothing goes, and no line (round 13).
    holdRead(surface, key, wanted);
    whenPerson(`agentNotes.read:${key}`, () => sendHeldRead(key, true));
    return;
  }
  try {
    const result = await (wanted.ids ? markAgentNotesRead(surface, undefined, wanted.ids) : markAgentNotesRead(surface, wanted.upTo));
    if (keyFor(getState(), surface) !== key) return;
    const read = new Set(Array.isArray(result.ids) ? result.ids : []);
    const at = new Date().toISOString();
    setState((state) => ({
      lists: withList(state.lists, key, (list) => {
        const notes = list.notes.map((n) => (read.has(n.id) && !n.readAt ? { ...n, readAt: at } : n));
        return { ...list, notes, unread: typeof result.unread === 'number' ? result.unread : countUnread(notes) };
      }),
    }));
  } catch (error) {
    if (!retry) return;
    const line = isPersonRefusal(error) ? markReadRefusedCopy() : failureMessage(error, "Couldn't mark the notes read.");
    setState({ error: line });
    // Refused only because this tab isn't connected as the person: gone on the promote (GM, #204 r3).
    clearLineOnPromote(error, () => getState().error, line, () => setState({ error: null })); // clears-on-promote: notes.read
    if (isPersonRefusal(error)) holdRead(surface, key, wanted);
    retryOnPromote(error, `agentNotes.read:${key}`, () => { // clears-on-promote: notes.read-retry
      sendHeldRead(key, false);
    });
    // (A board's list is read again by the corner when this error shows.)
    if (surface.kind === 'canvas') void getState().hydrateCanvas();
  }
}

/** Tests: forget the reads waiting for the promote. */
export function forgetHeldReadsForTests(): void {
  heldReads.clear();
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
    // The cards go (the list is open); the Updates read when the server says (sendRead).
    set((state) => ({ arrivals: state.arrivals.filter((a) => a.key !== key) }));
    await sendRead(surface, key, upTo ? { upTo } : {});
  },

  markReadIds: async (surface, ids) => {
    if (ids.length === 0) return;
    const key = keyFor(get(), surface);
    const wanted = new Set(ids);
    set((state) => ({ arrivals: state.arrivals.filter((a) => !wanted.has(a.id)) }));
    await sendRead(surface, key, { ids });
  },

  dismiss: async (surface, id) => {
    const key = keyFor(get(), surface);
    const before = (get().lists[key] ?? EMPTY).notes.find((n) => n.id === id);
    if (!before) return;
    const now = new Date().toISOString();
    set((state) => ({
      arrivals: state.arrivals.filter((a) => a.id !== id),
      // Review 5 LOW-8 (round 7): the header's unread count is the server's (GM r4), never the
      // tab's hope: the note greys at once, the count waits for the answer.
      lists: withList(state.lists, key, (list) => ({
        ...list, notes: list.notes.map((n) => (n.id === id ? { ...n, dismissedAt: n.dismissedAt ?? now } : n)),
      })),
    }));
    try {
      const answer = await dismissAgentNote(surface, id);
      if (typeof answer?.unread === 'number' && Number.isFinite(answer.unread)) {
        const unread = answer.unread;
        set((state) => ({ lists: withList(state.lists, key, (list) => ({ ...list, unread })) }));
      }
    } catch (error) {
      const line = failureMessage(error, "Couldn't dismiss the note.");
      clearLineOnPromote(error, () => get().error, line, () => set({ error: null })); // clears-on-promote: notes.dismiss
      set((state) => ({
        error: line,
        // The note back as it was; the count was never the tab's to change.
        lists: withList(state.lists, key, (list) => ({ ...list, notes: list.notes.map((n) => (n.id === id ? before : n)) })),
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
  reset: () => {
    heldReads.clear();
    set(initialState());
  },
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
