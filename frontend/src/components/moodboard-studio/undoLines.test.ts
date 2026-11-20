import { describe, expect, it } from 'vitest';
import { keptUndoLine, partialUndoLine, undoneLine } from './undoLines';

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
      name: ['Changed the name', 'the name'], notes: ['Changed the moodboard notes', 'the moodboard notes'],
      mode: ['Changed the mode', 'the mode'], strength: ['Changed the strength', 'the strength'],
      direction: ['Changed the direction', 'the direction'], avoid: ['Changed the avoid list', 'the avoid list'],
      pinnedColors: ['Changed the pinned colors', 'the pinned colors'], clashMode: ['Changed the clash mode', 'the clash mode'],
      colorChoices: ['Changed the color choices', 'the color choices'],
      sendNotes: ['Turned on “Moodboard notes to generators”', '“Moodboard notes to generators”'],
      briefOverride: ['Changed the brief', 'the brief'], coverImageId: ['Made image 2 the cover', 'the cover'],
    };
    for (const [field, [label, said]] of Object.entries(sentences)) {
      expect(keptUndoLine(label, [{ part: 'fields', field, reason: 'changed since' }]), field)
        .toBe(`Nebula couldn’t undo “${label.replace(/“/g, '‘').replace(/”/g, '’')}” because ${said} changed again after that.`);
    }
    expect(keptUndoLine('Changed the pinned colors', [{ part: 'fields', field: 'pinnedColors', reason: 'changed since' },
      { part: 'fields', field: 'colorChoices', reason: 'changed since' }]))
      .toBe('Nebula couldn’t undo “Changed the pinned colors” because the pinned colors and the color choices changed again after that.');
    expect(keptUndoLine('Changed the direction', [{ part: 'fields', reason: 'changed since' }])).toBeNull();
  });

  it('says an image was removed since', () => {
    expect(keptUndoLine('Weight of image 4', [{ part: 'image', reason: 'removed since', number: 4 }]))
      .toBe('Nebula couldn’t undo “Weight of image 4” because image 4 was removed after that.');
    expect(keptUndoLine('Set aside images 4 and 6', [{ reason: 'removed since', number: 6 }, { reason: 'removed since', number: 4 }]))
      .toBe('Nebula couldn’t undo “Set aside images 4 and 6” because images 4 and 6 were removed after that.');
    expect(keptUndoLine('x', [{ reason: 'changed since', number: 1 }, { reason: 'removed since', number: 2 }]))
      .toBe('Nebula couldn’t undo “x” because image 1 changed and image 2 was removed after that.');
  });

  it('says why a step can\u2019t go back, in the because form (design)', () => {
    expect(keptUndoLine('Changed the direction', [{ part: 'fields', field: 'direction', reason: 'is the person’s to change' }]))
      .toBe('Nebula couldn’t undo “Changed the direction” because only you can change the direction.');
    expect(keptUndoLine('Turned on “Moodboard notes to generators”', [{ part: 'fields', field: 'sendNotes', reason: 'is the person’s to turn on' }]))
      .toBe('Nebula couldn’t undo “Turned on ‘Moodboard notes to generators’” because only you can turn it on.');
    expect(keptUndoLine('Changed the pinned colors', [{ part: 'fields', field: 'pinnedColors', reason: 'can’t go back' }]))
      .toBe('Nebula couldn’t undo “Changed the pinned colors” because a pinned color that step used was removed after that.');
    expect(keptUndoLine('Changed the pinned colors', [{ part: 'fields', field: 'pinnedColors', reason: 'would undo a colour choice made since' }]))
      .toBe('Nebula couldn’t undo “Changed the pinned colors” because a color was chosen after that.');
    expect(keptUndoLine('Moved image 3', [{ part: 'cards', reason: 'can’t go back there', number: 3 }]))
      .toBe('Nebula couldn’t undo “Moved image 3” because its place on the moodboard was taken or removed after that.');
    expect(keptUndoLine('Added image 5', [{ part: 'image', reason: 'isn’t one of Nebula’s own files', number: 5 }]))
      .toBe('Nebula couldn’t undo “Added image 5” because image 5 isn’t one of Nebula’s own files.');
    expect(keptUndoLine('Changed the note on image 5', [{ part: 'settings', reason: 'changed since', number: 5, settings: ['notes'] }]))
      .toBe('Nebula couldn’t undo “Changed the note on image 5” because image 5’s note changed after that.');
  });

  it('names the undone and redone step with single quotes inside its double ones', () => {
    expect(undoneLine('undo', 'Turned on “Moodboard notes to generators”')).toBe('Undid “Turned on ‘Moodboard notes to generators’”');
    expect(undoneLine('redo', 'Changed the direction')).toBe('Redid “Changed the direction”');
  });

  it('is not a kept case for an empty list, an unnumbered image slice or another reason', () => {
    expect(keptUndoLine('Changed the direction', [])).toBeNull();
    expect(keptUndoLine('Changed the direction', [{ reason: 'changed since' }])).toBeNull();
    expect(keptUndoLine('Changed the direction', [{ part: 'fields', field: 'direction', reason: 'something else' }])).toBeNull();
    expect(keptUndoLine('x', [{ reason: 'is an image link from outside Nebula', number: 1 }])).toBeNull();
  });
});

describe('the toast for an undo that put some parts back and kept others (design)', () => {
  const image = (number: number, extra: Record<string, unknown> = {}) => ({ part: 'image', reason: 'changed since', number, ...extra });

  it('names one image', () => {
    expect(partialUndoLine('undo', 'Changed the weight of image 5', [image(5)]))
      .toBe('Undid “Changed the weight of image 5” except image 5, which changed after that.');
  });

  it('names two and three images, with no serial comma', () => {
    expect(partialUndoLine('undo', 'Moved 2 images', [image(5), image(3)]))
      .toBe('Undid “Moved 2 images” except images 3 and 5, which changed after that.');
    expect(partialUndoLine('undo', 'Moved 3 images', [image(5), image(2), image(3)]))
      .toBe('Undid “Moved 3 images” except images 2, 3 and 5, which changed after that.');
  });

  it('counts from four images on', () => {
    expect(partialUndoLine('undo', 'Moved 4 images', [image(1), image(2), image(3), image(4)]))
      .toBe('Undid “Moved 4 images” except 4 images that changed after that.');
    expect(partialUndoLine('undo', 'x', [1, 2, 3, 4, 5, 6].map((n) => ({ part: 'card', reason: 'changed since', number: n }))))
      .toBe('Undid “x” except 6 images that changed after that.');
  });

  it('counts an image once, whatever the slices it has', () => {
    expect(partialUndoLine('undo', 'x', [image(5), { part: 'card', reason: 'changed since', number: 5 }]))
      .toBe('Undid “x” except image 5, which changed after that.');
    expect(partialUndoLine('undo', 'x', [image(1), image(2), image(3), image(3), image(2)]))
      .toBe('Undid “x” except images 1, 2 and 3, which changed after that.');
  });

  it('says “Redid” for a redo', () => {
    expect(partialUndoLine('redo', 'Moved image 5', [image(5)])).toBe('Redid “Moved image 5” except image 5, which changed after that.');
  });

  it('keeps the old toast (null) for any other mix', () => {
    expect(partialUndoLine('undo', 'x', [])).toBeNull();
    // a field
    expect(partialUndoLine('undo', 'x', [{ part: 'fields', field: 'direction', reason: 'changed since' }])).toBeNull();
    // a look
    expect(partialUndoLine('undo', 'x', [{ part: 'frame', reason: 'changed since' }])).toBeNull();
    // an image without a number
    expect(partialUndoLine('undo', 'x', [{ part: 'image', reason: 'changed since' }])).toBeNull();
    // a different reason
    expect(partialUndoLine('undo', 'x', [image(5, { reason: 'removed since' })])).toBeNull();
    expect(partialUndoLine('undo', 'x', [image(5), image(6, { reason: 'removed since' })])).toBeNull();
    // images and fields together
    expect(partialUndoLine('undo', 'x', [image(5), { part: 'fields', field: 'direction', reason: 'changed since' }])).toBeNull();
    // an image's settings
    expect(partialUndoLine('undo', 'x', [{ part: 'settings', reason: 'changed since', number: 5, settings: ['notes'] }])).toBeNull();
  });
});
