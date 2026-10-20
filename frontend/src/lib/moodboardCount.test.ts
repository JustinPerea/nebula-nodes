import { describe, expect, it } from 'vitest';
import { isSetAside, moodboardImagesLabel, setAsideCount } from './moodboardCount';

/** A board's image count, wherever it shows (node card, Studio rail, Assets
 *  panel). The demo dry run (2026-10-20) set one of 5 images aside: the card
 *  and the rail read "5 images · look" while the Preview read "4 images". */
describe('moodboard image count', () => {
  it('names the set-aside images, in the Studio\'s words', () => {
    expect(moodboardImagesLabel(5, 1)).toBe('5 images · 1 set aside');
    expect(moodboardImagesLabel(2, 2)).toBe('2 images · 2 set aside');
    expect(moodboardImagesLabel(5, 0)).toBe('5 images');
    expect(moodboardImagesLabel(1)).toBe('1 image');
    expect(moodboardImagesLabel(0)).toBe('0 images');
  });

  it('counts the switch and weight 0, as the Studio shows them', () => {
    expect(setAsideCount([
      { excluded: true, weight: 1 },
      { excluded: false, weight: 0 },
      { excluded: false, weight: 0.5 },
      { excluded: true, weight: 0 },
    ])).toBe(3);
    // A loosely shaped image (an old or agent-written board) with no weight
    // steers at full weight, as the backend reads it (moodboard_analysis.steers).
    expect(setAsideCount([{}, { excluded: false }])).toBe(0);
    expect(isSetAside({ excluded: false, weight: 0 })).toBe(true);
    expect(isSetAside({ excluded: false, weight: 1 })).toBe(false);
  });
});
