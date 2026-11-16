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

  it('says a field step changed again, naming the field from its key (every step label and its sentence)', () => {
    const sentences: Record<string, [string, string]> = {
      name: ['Name', 'the name'], notes: ['Moodboard notes', 'the moodboard notes'], mode: ['Mode', 'the mode'],
      strength: ['Strength', 'the strength'], direction: ['Direction', 'the direction'], avoid: ['Avoid', 'the avoid'],
      pinnedColors: ['Pinned colors', 'the pinned colors'], clashMode: ['Clash mode', 'the clash mode'],
      colorChoices: ['Color choices', 'the color choices'], sendNotes: ['Send notes to generators', 'the send notes setting'],
      briefOverride: ['Your brief', 'the brief'], coverImageId: ['Made image 2 the cover', 'the cover'],
    };
    for (const [field, [label, said]] of Object.entries(sentences)) {
      expect(keptUndoLine(label, [{ part: 'fields', field, reason: 'changed since' }]), field)
        .toBe(`Nebula couldn’t undo “${label}” because ${said} changed again after that.`);
    }
    expect(keptUndoLine('Pinned colors', [{ part: 'fields', field: 'pinnedColors', reason: 'changed since' },
      { part: 'fields', field: 'colorChoices', reason: 'changed since' }]))
      .toBe('Nebula couldn’t undo “Pinned colors” because the pinned colors and the color choices changed again after that.');
    expect(keptUndoLine('Direction', [{ part: 'fields', reason: 'changed since' }])).toBeNull();
  });

  it('says an image was removed since', () => {
    expect(keptUndoLine('Weight of image 4', [{ part: 'image', reason: 'removed since', number: 4 }]))
      .toBe('Nebula couldn’t undo “Weight of image 4” because image 4 was removed after that.');
    expect(keptUndoLine('Set aside images 4 and 6', [{ reason: 'removed since', number: 6 }, { reason: 'removed since', number: 4 }]))
      .toBe('Nebula couldn’t undo “Set aside images 4 and 6” because images 4 and 6 were removed after that.');
    expect(keptUndoLine('x', [{ reason: 'changed since', number: 1 }, { reason: 'removed since', number: 2 }]))
      .toBe('Nebula couldn’t undo “x” because image 1 changed and image 2 was removed after that.');
  });

  it('is not a kept case for an empty list, an unnumbered image slice or another reason', () => {
    expect(keptUndoLine('Changed the direction', [])).toBeNull();
    expect(keptUndoLine('Changed the direction', [{ reason: 'changed since' }])).toBeNull();
    expect(keptUndoLine('Send notes to generators', [{ part: 'fields', reason: 'is the person’s to turn on' }])).toBeNull();
    expect(keptUndoLine('Direction', [{ part: 'fields', reason: 'can’t go back' }])).toBeNull();
    expect(keptUndoLine('x', [{ reason: 'can’t go back there', number: 1 }])).toBeNull();
  });
});
