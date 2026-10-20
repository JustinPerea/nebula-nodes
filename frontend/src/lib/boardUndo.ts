import { create } from 'zustand';
import type { MoodboardOp } from './moodboardEdits';

/**
 * Undo in Moodboard Studio (moodboard canvas plan section 5.4).
 *
 * A step is one thing the person did: a drag that ended, a Set aside switch,
 * a note (typing joins one step until it is sent), a removal, a drop. Its ops
 * go into the draft's queue (lib/moodboardEdits) like any edit, and the Studio
 * sends each step as its own `/edits` batch, so the batch's `undo` (a
 * `restore` the server built from the board before and after) undoes exactly
 * that step and nothing typed beside it.
 *
 * Undo sends that `restore`; the server puts back each slice that is still
 * as the step left it and skips (and names) the rest, so an undo never
 * overwrites what an agent or another window changed since. Its own answer
 * carries the `restore` that redoes it, checked the same way.
 *
 * The stack lives per board draft (its key) and epoch, in memory: it goes
 * with the tab, as the plan says. Steps an agent or Analyze made join it in a
 * later part (PR9, PR10).
 */

export const BOARD_UNDO_CAP = 50;

export interface BoardUndoStep {
  id: string;
  /** What the person did, for the notice: "Moved #3", "Removed #1". */
  label: string;
  origin: 'self';
  /** The ops it queued. */
  ops: MoodboardOp[];
  /** Same-thing edits that join it while it waits (a note being typed). */
  joinKey?: string;
  /** The server's `undo.ops` for its batch, once it landed. */
  undo: MoodboardOp[] | null;
  /** The `undo` of its undo: redoing puts back what undoing took. */
  redo: MoodboardOp[] | null;
  state: 'pending' | 'saved';
}

export interface BoardUndoHistory {
  epoch: number;
  done: BoardUndoStep[];
  undone: BoardUndoStep[];
}

const EMPTY: BoardUndoHistory = Object.freeze({ epoch: -1, done: [], undone: [] }) as BoardUndoHistory;

// Which step queued an op. Ops are objects that stay the same through the
// queue and every rebase (lib/moodboardEdits keeps them), so the queue can be
// cut into one batch per step when it is sent.
const stepOfOp = new WeakMap<MoodboardOp, string>();

/** The queue cut into batches: each run of ops from one step, in order. Ops
 *  no step claims (a draft kept from before, a first save) go as their own. */
export function batchesOf(ops: MoodboardOp[]): Array<{ stepId: string | undefined; ops: MoodboardOp[] }> {
  const batches: Array<{ stepId: string | undefined; ops: MoodboardOp[] }> = [];
  for (const op of ops) {
    const stepId = stepOfOp.get(op);
    const last = batches[batches.length - 1];
    if (last && last.stepId === stepId) last.ops.push(op);
    else batches.push({ stepId, ops: [op] });
  }
  return batches;
}

let counter = 0;
const newStepId = () => `s${Date.now().toString(36)}${(counter += 1).toString(36)}`;

interface BoardUndoState {
  histories: Record<string, BoardUndoHistory>;
  /** The board's history at this epoch (empty when the draft moved on). */
  history: (key: string, epoch: number) => BoardUndoHistory;
  /** A new step for `ops` (already queued). With `joinKey`, an edit of the
   *  same thing joins the last step while that step is still waiting. */
  record: (key: string, epoch: number, label: string, ops: MoodboardOp[], joinKey?: string) => string;
  /** The step's batch landed: its undo is `undo` (before any earlier batch's, which it undoes after). */
  landed: (key: string, stepId: string, undo: MoodboardOp[]) => void;
  /** The step's batch was refused, or sent nothing: it is not on the board, so it can't be undone. */
  forget: (key: string, stepId: string) => void;
  /** The last step that can be undone, without taking it. */
  peek: (key: string, epoch: number) => BoardUndoStep | null;
  /** Take a step to undo: the last one, or `stepId` (a toast's Undo). */
  takeUndo: (key: string, epoch: number, stepId?: string) => BoardUndoStep | null;
  /** Its undo landed: what redoes it. */
  redone: (key: string, stepId: string, redo: MoodboardOp[] | null) => void;
  /** Take the last undone step to redo. */
  takeRedo: (key: string, epoch: number) => BoardUndoStep | null;
  /** The redo landed: what undoes it now. */
  reapplied: (key: string, stepId: string, undo: MoodboardOp[] | null) => void;
  /** Put a taken step back where it was (its write failed). */
  restoreTaken: (key: string, step: BoardUndoStep, to: 'done' | 'undone') => void;
  clear: (key: string) => void;
}

function updateStep(history: BoardUndoHistory, stepId: string,
  update: (step: BoardUndoStep) => BoardUndoStep): BoardUndoHistory {
  return {
    ...history,
    done: history.done.map((step) => (step.id === stepId ? update(step) : step)),
    undone: history.undone.map((step) => (step.id === stepId ? update(step) : step)),
  };
}

export const useBoardUndoStore = create<BoardUndoState>((set, get) => {
  const at = (key: string, epoch: number): BoardUndoHistory => {
    const history = get().histories[key];
    return history && history.epoch === epoch ? history : { epoch, done: [], undone: [] };
  };
  const put = (key: string, history: BoardUndoHistory) => set((state) => ({ histories: { ...state.histories, [key]: history } }));
  const edit = (key: string, update: (history: BoardUndoHistory) => BoardUndoHistory) => {
    const history = get().histories[key];
    if (history) put(key, update(history));
  };
  return {
    histories: {},
    history: (key, epoch) => {
      const history = get().histories[key];
      return history && history.epoch === epoch ? history : EMPTY;
    },
    record: (key, epoch, label, ops, joinKey) => {
      const history = at(key, epoch);
      const last = history.done[history.done.length - 1];
      if (joinKey && last && last.state === 'pending' && last.joinKey === joinKey) {
        for (const op of ops) stepOfOp.set(op, last.id);
        put(key, updateStep(history, last.id, (step) => ({ ...step, label, ops: [...step.ops, ...ops] })));
        return last.id;
      }
      const id = newStepId();
      for (const op of ops) stepOfOp.set(op, id);
      const step: BoardUndoStep = { id, label, origin: 'self', ops, joinKey, undo: null, redo: null, state: 'pending' };
      put(key, { epoch, done: [...history.done, step].slice(-BOARD_UNDO_CAP), undone: [] });
      return id;
    },
    // A later batch of the same step is undone first: its restore expects the
    // board as that batch left it, and the earlier one's expects it before.
    landed: (key, stepId, undo) => edit(key, (history) => updateStep(history, stepId, (step) => ({
      ...step, state: 'saved', undo: undo.length ? [...undo, ...(step.undo ?? [])] : step.undo,
    }))),
    forget: (key, stepId) => edit(key, (history) => ({
      ...history,
      done: history.done.filter((step) => step.id !== stepId),
      undone: history.undone.filter((step) => step.id !== stepId),
    })),
    peek: (key, epoch) => {
      const history = get().history(key, epoch);
      const last = history.done[history.done.length - 1];
      return last && last.state === 'saved' && last.undo?.length ? last : null;
    },
    takeUndo: (key, epoch, stepId) => {
      const history = get().history(key, epoch);
      const step = stepId ? history.done.find((candidate) => candidate.id === stepId) : history.done[history.done.length - 1];
      if (!step || step.state !== 'saved' || !step.undo?.length) return null;
      put(key, { ...history, done: history.done.filter((candidate) => candidate !== step),
        undone: [...history.undone, step].slice(-BOARD_UNDO_CAP) });
      return step;
    },
    redone: (key, stepId, redo) => edit(key, (history) => updateStep(history, stepId, (step) => ({ ...step, redo }))),
    takeRedo: (key, epoch) => {
      const history = get().history(key, epoch);
      const step = history.undone[history.undone.length - 1];
      if (!step) return null;
      put(key, { ...history, undone: history.undone.slice(0, -1), done: [...history.done, step].slice(-BOARD_UNDO_CAP) });
      return step;
    },
    reapplied: (key, stepId, undo) => edit(key, (history) => updateStep(history, stepId, (step) => ({ ...step, undo }))),
    restoreTaken: (key, step, to) => edit(key, (history) => {
      const done = history.done.filter((candidate) => candidate.id !== step.id);
      const undone = history.undone.filter((candidate) => candidate.id !== step.id);
      return to === 'done' ? { ...history, done: [...done, step], undone } : { ...history, done, undone: [...undone, step] };
    }),
    clear: (key) => set((state) => {
      if (!state.histories[key]) return {};
      const histories = { ...state.histories };
      delete histories[key];
      return { histories };
    }),
  };
});
