import { beforeEach, describe, expect, it } from 'vitest';
import type { MoodboardOp } from './moodboardEdits';
import { BOARD_UNDO_CAP, batchesOf, useBoardUndoStore } from './boardUndo';

// Undo in Moodboard Studio (plan section 5.4): one step per drag end, set
// aside toggle, note, removal or drop; each step goes to the board as its own
// batch, so the batch's `undo` undoes exactly that step.

const KEY = 'board-key';
const undo = useBoardUndoStore.getState;
const place = (placement: string, x = 0): MoodboardOp => ({ op: 'place', placement, x, y: 0 });
const restore = (tag: string) => [{ op: 'restore', slices: [{ part: 'card', tag }] }] as unknown as MoodboardOp[];

beforeEach(() => useBoardUndoStore.setState({ histories: {} }));

describe('steps', () => {
  it('records a step, and its batch landing gives it the undo', () => {
    const ops = [place('a', 10)];
    const id = undo().record(KEY, 1, 'Moved #1', ops);
    expect(undo().history(KEY, 1).done.map((step) => [step.label, step.state])).toEqual([['Moved #1', 'pending']]);
    expect(undo().peek(KEY, 1)).toBeNull();  // nothing to undo until the server has it
    undo().landed(KEY, id, restore('a'));
    expect(undo().peek(KEY, 1)).toMatchObject({ id, label: 'Moved #1', state: 'saved', undo: restore('a') });
  });

  it('typing one note joins its step until the step is sent', () => {
    const first = undo().record(KEY, 1, 'Note on #1', [{ op: 'note', image: 'i1', notes: 't' }], 'note:i1');
    const again = undo().record(KEY, 1, 'Note on #1', [{ op: 'note', image: 'i1', notes: 'te' }], 'note:i1');
    expect(again).toBe(first);
    undo().landed(KEY, first, restore('n'));
    const later = undo().record(KEY, 1, 'Note on #1', [{ op: 'note', image: 'i1', notes: 'tea' }], 'note:i1');
    expect(later).not.toBe(first);
    expect(undo().history(KEY, 1).done).toHaveLength(2);
  });

  it('a step sent in two batches (typed on while the first was saving) undoes the later batch first', () => {
    const id = undo().record(KEY, 1, 'Note on #1', [{ op: 'note', image: 'i1', notes: 't' }], 'note:i1');
    undo().record(KEY, 1, 'Note on #1', [{ op: 'note', image: 'i1', notes: 'tea' }], 'note:i1');
    undo().landed(KEY, id, restore('first'));
    undo().landed(KEY, id, restore('second'));
    expect(undo().peek(KEY, 1)?.undo).toEqual([...restore('second'), ...restore('first')]);
  });

  it('keeps the last 50 steps', () => {
    for (let i = 0; i < BOARD_UNDO_CAP + 5; i += 1) undo().record(KEY, 1, `Moved #${i}`, [place('a', i)]);
    const { done } = undo().history(KEY, 1);
    expect(done).toHaveLength(BOARD_UNDO_CAP);
    expect(done[0].label).toBe('Moved #5');
  });

  it('a new epoch (the draft was reset) starts an empty stack', () => {
    undo().record(KEY, 1, 'Moved #1', [place('a')]);
    expect(undo().history(KEY, 2).done).toEqual([]);
    undo().record(KEY, 2, 'Moved #2', [place('b')]);
    expect(undo().history(KEY, 2).done.map((step) => step.label)).toEqual(['Moved #2']);
    expect(undo().history(KEY, 1).done).toEqual([]);
  });

  it('undo then redo, and a new step clears what can be redone', () => {
    const id = undo().record(KEY, 1, 'Moved #1', [place('a', 5)]);
    undo().landed(KEY, id, restore('a'));
    const taken = undo().takeUndo(KEY, 1);
    expect(taken?.id).toBe(id);
    expect(undo().history(KEY, 1)).toMatchObject({ done: [], undone: [{ id }] });
    undo().redone(KEY, id, restore('r'));
    expect(undo().takeRedo(KEY, 1)).toMatchObject({ id, redo: restore('r') });
    undo().reapplied(KEY, id, restore('a2'));
    expect(undo().history(KEY, 1).done[0].undo).toEqual(restore('a2'));

    undo().takeUndo(KEY, 1);
    undo().record(KEY, 1, 'Moved #2', [place('b')]);
    expect(undo().history(KEY, 1).undone).toEqual([]);
  });

  it('a step whose batch was refused is dropped', () => {
    const id = undo().record(KEY, 1, 'Moved #1', [place('a')]);
    undo().forget(KEY, id);
    expect(undo().history(KEY, 1).done).toEqual([]);
  });

  it('clear forgets the board (a board switch or a delete)', () => {
    undo().record(KEY, 1, 'Moved #1', [place('a')]);
    undo().clear(KEY);
    expect(undo().history(KEY, 1).done).toEqual([]);
  });
});

describe('batches', () => {
  it('splits the queue into one batch per step, in queue order', () => {
    const a = [place('a')];
    const b = [{ op: 'setAside', image: 'i1', value: true } as MoodboardOp, { op: 'note', image: 'i1', notes: 'x' } as MoodboardOp];
    const loose: MoodboardOp = { op: 'weight', image: 'i2', value: 0.5 };
    const sa = undo().record(KEY, 1, 'Moved #1', a);
    const sb = undo().record(KEY, 1, 'Set aside #1', b);
    expect(batchesOf([...a, ...b, loose])).toEqual([
      { stepId: sa, ops: a }, { stepId: sb, ops: b }, { stepId: undefined, ops: [loose] }]);
  });

  it('a step that lost its op to a later edit of the same thing has nothing to send', () => {
    const early = { op: 'note', image: 'i1', notes: 'x' } as MoodboardOp;
    const late = { op: 'note', image: 'i1', notes: 'y' } as MoodboardOp;
    undo().record(KEY, 1, 'Note on #1', [early]);
    const moved = undo().record(KEY, 1, 'Moved #2', [place('b')]);
    undo().landed(KEY, moved, restore('b'));
    const sl = undo().record(KEY, 1, 'Note on #1', [late]);
    expect(batchesOf([late])).toEqual([{ stepId: sl, ops: [late] }]);
  });
});
