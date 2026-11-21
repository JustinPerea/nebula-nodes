import { describe, expect, it } from 'vitest';
import { imageStepWords, keptUndoLine, lookNameInLine, partialUndoLine, undoneLine } from './undoLines';

describe('the undo and redo toasts’ words', () => {
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
  const image = (number: number, extra: Record<string, unknown> = {}) => ({ part: 'image', reason: 'changed since', number, numberBefore: number, ...extra });

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
    expect(partialUndoLine('undo', 'x', [1, 2, 3, 4, 5, 6].map((n) => ({ part: 'card', reason: 'changed since', number: n, numberBefore: n }))))
      .toBe('Undid “x” except 6 images that changed after that.');
  });

  it('counts an image once, whatever the slices it has', () => {
    expect(partialUndoLine('undo', 'x', [image(5), { part: 'card', reason: 'changed since', number: 5, numberBefore: 5 }]))
      .toBe('Undid “x” except image 5, which changed after that.');
    expect(partialUndoLine('undo', 'x', [image(1), image(2), image(3), image(3), image(2)]))
      .toBe('Undid “x” except images 1, 2 and 3, which changed after that.');
  });

  it('says “Redid” for a redo', () => {
    expect(partialUndoLine('redo', 'Moved image 5', [image(5)])).toBe('Redid “Moved image 5” except image 5, which changed after that.');
  });

  const field = (name: string, extra: Record<string, unknown> = {}) => ({ part: 'fields', field: name, reason: 'changed since', ...extra });
  const look = (id: string) => ({ part: 'frame', frame: id, reason: 'changed since' });
  const names: Record<string, string> = { f1: 'Dusk', f2: 'Noon' };
  const lookName = (id: string) => names[id];
  const removedImage = (number: number) => image(number, { reason: 'removed since' });

  it('names a field by its noun', () => {
    expect(partialUndoLine('undo', 'Changed the strength', [field('direction')]))
      .toBe('Undid “Changed the strength” except the direction, which changed after that.');
    expect(partialUndoLine('undo', 'x', [field('mode'), field('strength')]))
      .toBe('Undid “x” except the mode and the strength, which changed after that.');
    expect(partialUndoLine('undo', 'x', [field('sendNotes')]))
      .toBe('Undid “x” except “Moodboard notes to generators”, which changed after that.');
  });

  it('names a look by its quoted name', () => {
    expect(partialUndoLine('undo', 'Moved 2 looks', [look('f1')], lookName)).toBe('Undid “Moved 2 looks” except “Dusk”, which changed after that.');
    expect(partialUndoLine('undo', 'x', [look('f1'), look('f2')], lookName)).toBe('Undid “x” except “Dusk” and “Noon”, which changed after that.');
  });

  it('names one of an image’s settings, and several of one image', () => {
    const settings = (number: number, keys: string[]) => ({ part: 'settings', reason: 'changed since', number, numberBefore: number, settings: keys });
    expect(partialUndoLine('undo', 'x', [settings(5, ['notes'])])).toBe('Undid “x” except image 5’s note, which changed after that.');
    expect(partialUndoLine('undo', 'x', [settings(5, ['notes', 'weight'])])).toBe('Undid “x” except image 5’s note and weight, which changed after that.');
    expect(partialUndoLine('undo', 'x', [settings(5, ['notes']), settings(5, ['weight'])])).toBe('Undid “x” except image 5’s note and weight, which changed after that.');
    expect(partialUndoLine('undo', 'x', [settings(5, ['privateNote']), settings(6, ['weight'])]))
      .toBe('Undid “x” except image 5’s private note and image 6’s weight, which changed after that.');
  });

  it('names an image removed after the step', () => {
    expect(partialUndoLine('undo', 'x', [removedImage(5)])).toBe('Undid “x” except image 5, which was removed after that.');
    expect(partialUndoLine('undo', 'x', [removedImage(5), removedImage(3)])).toBe('Undid “x” except images 3 and 5, which were removed after that.');
    expect(partialUndoLine('undo', 'x', [removedImage(5), removedImage(3), removedImage(4)])).toBe('Undid “x” except images 3, 4 and 5, which were removed after that.');
    expect(partialUndoLine('undo', 'x', [1, 2, 3, 4].map(removedImage))).toBe('Undid “x” except 4 images that were removed after that.');
  });

  it('counts an image with no number', () => {
    expect(partialUndoLine('undo', 'x', [{ part: 'image', reason: 'changed since' }])).toBe('Undid “x” except 1 image, which changed after that.');
    expect(partialUndoLine('undo', 'x', [{ part: 'image', reason: 'changed since' }, { part: 'image', reason: 'removed since' }]))
      .toBe('Undid “x” except 2 images, which changed or were removed after that.');
    expect(partialUndoLine('undo', 'x', [{ part: 'image', reason: 'removed since' }])).toBe('Undid “x” except 1 image, which was removed after that.');
  });

  it('puts the field first, then looks, then images', () => {
    expect(partialUndoLine('undo', 'x', [image(5), image(3), field('direction')]))
      .toBe('Undid “x” except the direction and images 3 and 5, which changed after that.');
    expect(partialUndoLine('undo', 'x', [image(5), look('f1'), field('direction'), field('mode')], lookName))
      .toBe('Undid “x” except the direction, the mode, “Dusk” and image 5, which changed after that.');
    expect(partialUndoLine('undo', 'x', [1, 2, 3, 4].map((n) => image(n)).concat(field('direction') as never)))
      .toBe('Undid “x” except the direction and 4 images, which changed after that.');
  });

  describe('a kept image is named only when the undo left its number alone', () => {
    const moved = (number: number, numberBefore: number) => ({ part: 'image', reason: 'changed since', number, numberBefore });

    it('names it when its number is the same before and after, and the label gives that number', () => {
      expect(partialUndoLine('undo', 'Added images 5, 6 and 7', [moved(5, 5)]))
        .toBe('Undid “Added images 5, 6 and 7” except image 5, which changed after that.');
    });

    it('says "one of them" when the undo renumbered it', () => {
      expect(partialUndoLine('undo', 'Added images 5, 6 and 7', [moved(5, 6)]))
        .toBe('Undid “Added images 5, 6 and 7” except one of them, which changed after that.');
    });

    it('drops the number when the label lists another one for it', () => {
      expect(partialUndoLine('undo', 'Added images 5, 6 and 7', [moved(4, 4)]))
        .toBe('Undid “Added images 5, 6 and 7” except one of them, which changed after that.');
      expect(partialUndoLine('undo', 'Added 6 images', [moved(4, 4)])).toBe('Undid “Added 6 images” except image 4, which changed after that.');
    });

    it('says "2 of them" for two or more, in numerals', () => {
      expect(partialUndoLine('undo', 'Added images 5, 6 and 7', [moved(5, 6), moved(6, 7)]))
        .toBe('Undid “Added images 5, 6 and 7” except 2 of them, which changed after that.');
      expect(partialUndoLine('undo', 'Added 6 images', [moved(1, 2), moved(2, 3), moved(3, 4), moved(4, 5)]))
        .toBe('Undid “Added 6 images” except 4 of them, which changed after that.');
    });

    it('never mixes a named image and a count: one renumbered image makes them all a count', () => {
      expect(partialUndoLine('undo', 'Added images 5, 6 and 7', [moved(5, 5), moved(5, 7)]))
        .toBe('Undid “Added images 5, 6 and 7” except one of them, which changed after that.');
      expect(partialUndoLine('undo', 'Added images 5, 6 and 7', [moved(5, 5), moved(6, 8)]))
        .toBe('Undid “Added images 5, 6 and 7” except 2 of them, which changed after that.');
    });

    it('takes the count form for a payload without numberBefore', () => {
      expect(partialUndoLine('undo', 'Added images 5, 6 and 7', [{ part: 'image', reason: 'changed since', number: 5 }]))
        .toBe('Undid “Added images 5, 6 and 7” except one of them, which changed after that.');
    });

    it('keeps a removed image’s number, and counts a removed image beside a renumbered one', () => {
      expect(partialUndoLine('undo', 'x', [moved(5, 6), removedImage(3)]))
        .toBe('Undid “x” except 2 of them, which changed or were removed after that.');
    });

    it('keeps "images" beside a field', () => {
      expect(partialUndoLine('undo', 'x', [moved(5, 6), field('direction')]))
        .toBe('Undid “x” except the direction and 1 image, which changed after that.');
    });
  });

  it('says changed or were removed when both are kept', () => {
    expect(partialUndoLine('undo', 'x', [image(3), removedImage(5)])).toBe('Undid “x” except images 3 and 5, which changed or were removed after that.');
    expect(partialUndoLine('undo', 'x', [1, 2, 3].map((n) => image(n)).concat(removedImage(4))))
      .toBe('Undid “x” except 4 images that changed or were removed after that.');
    expect(partialUndoLine('undo', 'x', [field('direction'), removedImage(5)])).toBe('Undid “x” except the direction and image 5, which changed or were removed after that.');
  });

  it('counts an image once, and a removal beats a change', () => {
    expect(partialUndoLine('undo', 'x', [image(5), removedImage(5)])).toBe('Undid “x” except image 5, which was removed after that.');
  });

  it('keeps the old toast (null) for any other mix', () => {
    expect(partialUndoLine('undo', 'x', [])).toBeNull();
    // a field the table doesn't know, or kept for another reason
    expect(partialUndoLine('undo', 'x', [{ part: 'fields', reason: 'changed since' }])).toBeNull();
    expect(partialUndoLine('undo', 'x', [field('direction', { reason: 'is the person’s to change' })])).toBeNull();
    // a switch only the person turns on, a colour choice made since, a card that can't go back there
    expect(partialUndoLine('undo', 'x', [field('sendNotes', { reason: 'is the person’s to turn on' })])).toBeNull();
    expect(partialUndoLine('undo', 'x', [field('pinnedColors', { reason: 'would undo a colour choice made since' })])).toBeNull();
    expect(partialUndoLine('undo', 'x', [field('pinnedColors', { reason: 'can’t go back' })])).toBeNull();
    expect(partialUndoLine('undo', 'x', [image(5, { part: 'cards', reason: 'can’t go back there' })])).toBeNull();
    expect(partialUndoLine('undo', 'x', [image(5), image(6, { reason: 'can’t go back there' })])).toBeNull();
    expect(partialUndoLine('undo', 'x', [image(5), image(6, { reason: 'isn’t one of Nebula’s own files' })])).toBeNull();
    expect(partialUndoLine('undo', 'x', [image(5, { reason: 'is an image link from outside Nebula' })])).toBeNull();
    // a look with no known name, or a part this doesn't know
    expect(partialUndoLine('undo', 'x', [look('f9')], lookName)).toBeNull();
    expect(partialUndoLine('undo', 'x', [look('f1')])).toBeNull();
    expect(partialUndoLine('undo', 'x', [{ part: 'frame', reason: 'changed since' }], lookName)).toBeNull();
    expect(partialUndoLine('undo', 'x', [{ part: 'other', reason: 'changed since', number: 1 }])).toBeNull();
    // a setting this doesn't know
    expect(partialUndoLine('undo', 'x', [{ part: 'settings', reason: 'changed since', number: 5, settings: ['colour'] }])).toBeNull();
    // one unsayable slice spoils the whole mix
    expect(partialUndoLine('undo', 'x', [image(5), field('direction', { reason: 'something else' })])).toBeNull();
  });

  it('names the images a step touched by the names rule: up to three listed, from four a count', () => {
    expect(imageStepWords([4])).toBe('image 4');
    expect(imageStepWords([4, 5])).toBe('images 4 and 5');
    expect(imageStepWords([4, 5, 6])).toBe('images 4, 5 and 6');
    expect(imageStepWords([4, 5, 6, 7, 8, 9])).toBe('6 images');
    expect(partialUndoLine('undo', `Added ${imageStepWords([4, 5, 6])}`, [{ part: 'image', reason: 'changed since', number: 5, numberBefore: 5 }]))
      .toBe('Undid “Added images 4, 5 and 6” except image 5, which changed after that.');
  });

  it('shortens a look’s name as the backend does (60 characters, an ellipsis inside them)', () => {
    const long = `${'Dusk over the harbour '.repeat(4)}end`;
    expect(long.length).toBeGreaterThan(60);
    const cut = lookNameInLine(long);
    expect(cut.length).toBe(60);
    expect(cut.endsWith('…')).toBe(true);
    expect(lookNameInLine('  Dusk \n  Noon ')).toBe('Dusk Noon');
    const seventy = 'x'.repeat(70);
    expect(lookNameInLine(seventy)).toBe(`${'x'.repeat(59)}…`);
    expect(partialUndoLine('undo', 'Moved 2 looks', [look('f1')], () => seventy))
      .toBe(`Undid “Moved 2 looks” except “${'x'.repeat(59)}…”, which changed after that.`);
  });
});
