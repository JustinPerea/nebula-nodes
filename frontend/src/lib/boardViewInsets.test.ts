import { describe, expect, it } from 'vitest';
import { BOARD_BAR_BAND_PX, BOARD_FALLBACK_INSETS, BOARD_NOTICE_GAP_PX, frameInInsets, insideInsets, measureBoardViewInsets } from './boardViewInsets';

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

// #210 round 6q (GM r95): the Studio's notice stack over the board's top is
// outside the view while a line shows, so a fit never frames a card under it.
describe('the notice band', () => {
  it('the board\'s top down to the stack\'s bottom, and the gap below it', () => {
    // GM r95's shot 4: the column at y 98 (the offline row up), 542 tall; the three-line line ends at y 172.
    const board = rect(98, 542);
    const bar = rect(98 + 542 - 53, 38);
    // The band ends 12 px below the line (the stack's own offset from the board's top): 172 - 98 + 12.
    expect(BOARD_NOTICE_GAP_PX).toBe(12);
    expect(measureBoardViewInsets(board, bar, rect(110, 62))).toEqual({ top: 86, right: 0, bottom: 53, left: 0 });
  });

  it('no line (an empty stack, 0 tall) or no stack: no band', () => {
    expect(measureBoardViewInsets(rect(49, 591), rect(49 + 591 - 53, 38), rect(61, 0))?.top).toBe(0);
    expect(measureBoardViewInsets(rect(49, 591), rect(49 + 591 - 53, 38), null)?.top).toBe(0);
    expect(measureBoardViewInsets(rect(49, 591), rect(49 + 591 - 53, 38))?.top).toBe(0);
  });

  it('never more than the board', () => {
    expect(measureBoardViewInsets(rect(0, 100), rect(47, 38), rect(12, 400))?.top).toBe(100);
  });
});

/**
 * The fuzz (GM r95: "add a cell for banner + 3-line notice at 1024 x 640"):
 * the Studio's layout at each window size the live runs use and two more,
 * with the offline row closed or open (49 px, and taller if it wraps), one
 * to three lines in the stack (or two lines stacked), and boards of every
 * shape: the fitted cards always start below the notice band and end above
 * the bar's band. The geometry is the Studio's: the header 49 px; the rail
 * 250 px and the side panel 319 px beside the column; the stack 12 px below
 * the column's top, a line 17 + 15 px a row (GM's shot 4: three rows, 62 px),
 * 6 px between lines; the bar 38 px tall, 15 px above the column's bottom.
 */
describe('fuzz: a fitted board clears the notices and the bar, whatever the banner adds', () => {
  const FIT = { minZoom: 0.02, maxZoom: 1, padding: 0.12 };
  const SIZES: Array<[number, number]> = [[1024, 640], [1280, 800], [1440, 900], [1920, 1080]];
  const BANNERS = [0, 49, 74, 98];
  const STACKS: number[][] = [[], [1], [2], [3], [2, 1], [3, 3]];
  let seed = 210;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const BOARDS = [
    { x: 0, y: 0, width: 360, height: 360 }, // GM's shot: one card
    { x: 0, y: 0, width: 2000, height: 1000 },
    { x: 0, y: 0, width: 400, height: 1200 },
    ...Array.from({ length: 12 }, () => ({ x: Math.round(random() * 4000 - 2000), y: Math.round(random() * 4000 - 2000),
      width: Math.round(40 + random() * 6000), height: Math.round(40 + random() * 4000) })),
  ];
  const cell = (width: number, height: number, banner: number, stack: number[], bounds: typeof BOARDS[number]) => {
    const top = 49 + banner;
    const column = { width: width - 250 - 319, height: height - top };
    const lines = stack.map((rows) => 17 + 15 * rows);
    const stackHeight = lines.reduce((sum, line) => sum + line, 0) + Math.max(0, lines.length - 1) * 6;
    const noticeBottom = top + 12 + stackHeight;
    const barTop = top + column.height - 15 - 38;
    const insets = measureBoardViewInsets(rect(top, column.height), rect(barTop, 38), rect(top + 12, stackHeight))!;
    const camera = frameInInsets(bounds, column.width, column.height, insets, FIT);
    const cardTop = top + camera.y + bounds.y * camera.zoom;
    const cardBottom = top + camera.y + (bounds.y + bounds.height) * camera.zoom;
    return { cardTop, cardBottom, noticeBottom: stack.length ? noticeBottom + BOARD_NOTICE_GAP_PX : top, barTop, zoom: camera.zoom };
  };

  it('GM r95\'s cell: 1024 x 640, the offline row up, a three-line line, one card: the card starts below the line', () => {
    const { cardTop, noticeBottom } = cell(1024, 640, 49, [3], BOARDS[0]);
    // Shot 4 had the line ending at y 172 and the card starting at y 163.
    expect(noticeBottom).toBe(172 + BOARD_NOTICE_GAP_PX);
    expect(cardTop).toBeGreaterThanOrEqual(172 + BOARD_NOTICE_GAP_PX);
  });

  it('every cell', () => {
    const misses: string[] = [];
    let cells = 0;
    for (const [width, height] of SIZES) for (const banner of BANNERS) for (const stack of STACKS) for (const bounds of BOARDS) {
      cells += 1;
      const { cardTop, cardBottom, noticeBottom, barTop, zoom } = cell(width, height, banner, stack, bounds);
      if (cardTop < noticeBottom - 0.5 || cardBottom > barTop + 0.5 || zoom > 1) {
        misses.push(`${width}x${height} banner ${banner} lines ${stack.join('+') || 'none'} board ${JSON.stringify(bounds)}: `
          + `card ${cardTop.toFixed(1)}-${cardBottom.toFixed(1)}, notices end ${noticeBottom}, bar at ${barTop}`);
      }
    }
    expect(cells).toBe(SIZES.length * BANNERS.length * STACKS.length * BOARDS.length);
    expect(misses).toEqual([]);
  });
});
