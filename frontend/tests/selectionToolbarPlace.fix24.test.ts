// @vitest-environment node
/**
 * PR #199 round 25, GM r24 (toolbar, between-stack-and-selection): "the bar
 * crosses the stacked cards at about y 150–280, and there's free canvas below
 * them. If one of those cards is the selection, the bar goes below it, as in
 * the near-top shot. If the selection is the card whose header is under the
 * banner, send a crop with the selection outline visible. The near-top fix
 * and the filling-view pin are approved."
 *
 * The rule reads the selection only: the bar between the stack and a lower
 * selection stays there however many unselected cards it crosses (they are
 * not what it must not cover); once a stacked card is the selection, it goes
 * below that card, never over it; a selection under the banner goes below it
 * and the banner; a selection that fills the view stays pinned (the one case
 * that covers it).
 */
import { describe, expect, it } from 'vitest';
import { placeSelectionToolbar, type ScreenBox } from '../src/lib/bottomBar';

const H = 50;
const GAP = 8;
const BOTTOM = 820;
const TOOLBAR = { left: 420, right: 1020 };
// The notice and its reopen line at 1440 x 900 (as selectionToolbarPlace.fix23).
const STACK = { home: 128, stackBottom: 120 };
const box = (top: number, bottom: number, left = 600, right = 840): ScreenBox => ({ top, bottom, left, right });
const place = (selection: ScreenBox | null, stack = STACK) => placeSelectionToolbar({
  home: stack.home, height: H, ...TOOLBAR, selection, stackBottom: stack.stackBottom, bottomLimit: BOTTOM, gap: GAP,
});
const overlaps = (top: number, selection: ScreenBox) => TOOLBAR.left < selection.right && TOOLBAR.right > selection.left
  && top < selection.bottom && top + H > selection.top;

describe('GM r24: the bar and the stacked cards', () => {
  // Three cards stacked down the canvas, the first at y 150–280 under the bar.
  const first = box(150, 280);
  const second = box(300, 430);
  const third = box(450, 580);

  it('a stacked card that is the selection: the bar goes below it, never over it', () => {
    for (const selection of [first, second, third]) {
      const at = place(selection);
      expect(overlaps(at.top, selection), JSON.stringify({ selection, at })).toBe(false);
      if (selection === first) expect(at).toEqual({ top: 280 + GAP, place: 'below' });
    }
  });

  it('the card whose header is under the banner: the bar goes below that card, under the banner too', () => {
    const underBanner = box(104, 234);
    const at = place(underBanner);
    expect(at).toEqual({ top: 234 + GAP, place: 'below' });
    expect(at.top).toBeGreaterThanOrEqual(STACK.stackBottom + GAP);
    expect(overlaps(at.top, underBanner)).toBe(false);
  });

  it('a lower selection leaves the bar between the stack and it, whatever unselected cards the bar crosses', () => {
    // The bar's own place (128–178) crosses `first` (150–280); only the selection counts.
    const selection = box(460, 600);
    expect(place(selection)).toEqual({ top: STACK.home, place: 'between' });
    expect(overlaps(STACK.home, first)).toBe(true);
    expect(overlaps(STACK.home, selection)).toBe(false);
  });

  it('the gap decides it exactly: a selection the gap below the bar stays between, one pixel closer flips below', () => {
    expect(place(box(STACK.home + H + GAP, 600)).place).toBe('between');
    expect(place(box(STACK.home + H + GAP - 1, 600)).place).toBe('below');
  });

  it('the approved cases hold: filling the view stays pinned, in the bar’s own place', () => {
    expect(place(box(60, 880))).toEqual({ top: STACK.home, place: 'pinned' });
    expect(place(null)).toEqual({ top: STACK.home, place: 'clear' });
  });
});
