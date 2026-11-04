import { describe, expect, it } from 'vitest';
import { deleteForeverLine, emptyTrashLine, PROJECT_TRASH_NOTE, type GoesWith } from './projectPurgeCopy';

const goes = (over: Partial<GoesWith> = {}): GoesWith => ({ moodboards: [], characters: [], styles: [], ...over });

describe('what deleting a project for good also deletes', () => {
  it('the trash note always gives the full list', () => {
    expect(PROJECT_TRASH_NOTE).toBe('Deleted projects stay here for 30 days. Deleting one for good also deletes its moodboards, '
      + 'characters and styles. Generated files stay in your outputs folder.');
  });

  it('Delete forever, one kind: names one to three, a count from 4', () => {
    expect(deleteForeverLine(goes({ moodboards: ['Rivers'] }))).toBe('Its moodboard “Rivers” is deleted with it.');
    expect(deleteForeverLine(goes({ moodboards: ['Rivers', 'Tide'] }))).toBe('Its moodboards “Rivers” and “Tide” are deleted with it.');
    expect(deleteForeverLine(goes({ moodboards: ['Rivers', 'Tide', 'Salt'] })))
      .toBe('Its moodboards “Rivers”, “Tide” and “Salt” are deleted with it.');
    expect(deleteForeverLine(goes({ styles: ['a', 'b', 'c', 'd'] }))).toBe('Its 4 styles are deleted with it.');
  });

  it('Delete forever, a project with only characters', () => {
    expect(deleteForeverLine(goes({ characters: ['Mara'] }))).toBe('Its character “Mara” is deleted with it.');
  });

  it('Delete forever, two or three kinds: counts, no names, singular with 1, always "are"', () => {
    expect(deleteForeverLine(goes({ moodboards: ['a', 'b'], styles: ['s'] }))).toBe('Its 2 moodboards and 1 style are deleted with it.');
    expect(deleteForeverLine(goes({ moodboards: ['a', 'b'], characters: ['x', 'y', 'z'], styles: ['s'] })))
      .toBe('Its 2 moodboards, 3 characters and 1 style are deleted with it.');
    expect(deleteForeverLine(goes({ moodboards: ['a'], characters: ['x'] }))).toBe('Its 1 moodboard and 1 character are deleted with it.');
  });

  it('Delete forever, none of the three (or an older backend): no line', () => {
    expect(deleteForeverLine(goes())).toBeNull();
    expect(deleteForeverLine(undefined)).toBeNull();
  });

  it('Empty: the kinds present across the projects, no counts', () => {
    expect(emptyTrashLine([{ goesWith: goes({ characters: ['Mara', 'Jon'] }) }, { goesWith: goes() }]))
      .toBe('Their characters are deleted with them.');
    expect(emptyTrashLine([{ goesWith: goes({ styles: ['s'] }) }, { goesWith: goes({ moodboards: ['a'] }) }]))
      .toBe('Their moodboards and styles are deleted with them.');
    expect(emptyTrashLine([{ goesWith: goes({ moodboards: ['a'], characters: ['c'] }) }, { goesWith: goes({ styles: ['s'] }) }]))
      .toBe('Their moodboards, characters and styles are deleted with them.');
    expect(emptyTrashLine([{ goesWith: goes() }, {}])).toBeNull();
  });
});
