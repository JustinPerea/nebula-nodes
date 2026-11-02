import { describe, expect, it } from 'vitest';
import { BOARD_BAR_BAND_PX, BOARD_FALLBACK_INSETS, insideInsets, measureBoardViewInsets } from './boardViewInsets';

// #213 review 2 LOW-2: the view insets are measured from the control bar;
// jsdom has no layout, so these give the rects by hand.

const rect = (top: number, height: number) => ({ getBoundingClientRect: () => ({ top, bottom: top + height, height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect });

describe('measureBoardViewInsets', () => {
  it('the band is the board\'s bottom less the bar\'s top: the bar and the strip below it', () => {
    // A board 851 tall at y 49; the bar 38 tall, 15 px above the board's bottom edge.
    const board = rect(49, 851);
    const bar = rect(49 + 851 - 15 - 38, 38);
    expect(measureBoardViewInsets(board, bar)).toEqual({ top: 0, right: 0, bottom: 53, left: 0 });
  });

  it('a taller bar (wrapped) gives a taller band', () => {
    expect(measureBoardViewInsets(rect(0, 600), rect(600 - 15 - 76, 76))?.bottom).toBe(91);
  });

  it('no layout (a 0-height board or bar, or none): null', () => {
    expect(measureBoardViewInsets(rect(0, 0), rect(10, 38))).toBeNull();
    expect(measureBoardViewInsets(rect(0, 600), rect(10, 0))).toBeNull();
    expect(measureBoardViewInsets(null, rect(10, 38))).toBeNull();
    expect(measureBoardViewInsets(rect(0, 600), undefined)).toBeNull();
  });

  it('the band is never more than the board, nor less than 0', () => {
    expect(measureBoardViewInsets(rect(100, 40), rect(20, 38))?.bottom).toBe(40); // the bar above the board's top
    expect(measureBoardViewInsets(rect(0, 600), rect(700, 38))?.bottom).toBe(0); // the bar below it
  });
});

describe('the fallback and insideInsets', () => {
  it('the fallback band is the bar (38) 15 px above the edge', () => {
    expect(BOARD_BAR_BAND_PX).toBe(53);
    expect(BOARD_FALLBACK_INSETS).toEqual({ top: 0, right: 0, bottom: 53, left: 0 });
  });

  it('insideInsets is the column less the insets, offset by the top and left', () => {
    expect(insideInsets(870, 851, { top: 10, right: 20, bottom: 53, left: 30 })).toEqual({ x: 30, y: 10, width: 820, height: 788 });
  });

  it('never less than 1 px each way', () => {
    expect(insideInsets(40, 40, { top: 0, right: 0, bottom: 53, left: 60 })).toEqual({ x: 60, y: 0, width: 1, height: 1 });
  });
});
