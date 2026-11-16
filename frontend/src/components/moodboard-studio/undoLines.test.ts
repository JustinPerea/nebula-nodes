import { describe, expect, it } from 'vitest';
import { keptUndoLine, undoneLine } from './undoLines';

describe('the undo and redo toasts’ words (design r160 and r161)', () => {
  it('have no colon: the step’s label sits in curly quotes', () => {
    expect(undoneLine('undo', 'Made image 3 the cover')).toBe('Undid “Made image 3 the cover”');
    expect(undoneLine('redo', 'Made image 3 the cover')).toBe('Redid “Made image 3 the cover”');
  });

  it('say one sentence for a kept undo, the add included, and never “Undid”', () => {
    const changed = [{ part: 'image', reason: 'changed since', number: 5 }];
    expect(keptUndoLine('Added image 5', changed)).toBe('Nebula couldn’t undo “Added image 5” because image 5 changed after that.');
    expect(keptUndoLine('Set aside image 2', [{ reason: 'changed since', number: 2 }]))
      .toBe('Nebula couldn’t undo “Set aside image 2” because image 2 changed after that.');
    expect(keptUndoLine('Moved image 3', [{ reason: 'changed since', number: 3 }, { reason: 'changed since', number: 3 }]))
      .toBe('Nebula couldn’t undo “Moved image 3” because image 3 changed after that.');
  });

  it('names several images once each, in order', () => {
    const two = [{ reason: 'changed since', number: 6 }, { reason: 'changed since', number: 5 }];
    expect(keptUndoLine('Added images 5 and 6', two)).toBe('Nebula couldn’t undo “Added images 5 and 6” because images 5 and 6 changed after that.');
    expect(keptUndoLine('x', [...two, { reason: 'changed since', number: 9 }])).toContain('images 5, 6 and 9 changed after that.');
  });

  it('is not the kept case for a slice that is not an image that changed since', () => {
    expect(keptUndoLine('Changed the direction', [])).toBeNull();
    expect(keptUndoLine('Changed the direction', [{ reason: 'changed since' }])).toBeNull();
    expect(keptUndoLine('Removed image 1', [{ reason: 'removed since', number: 1 }])).toBeNull();
    expect(keptUndoLine('x', [{ reason: 'changed since', number: 1 }, { reason: 'removed since', number: 2 }])).toBeNull();
  });
});
