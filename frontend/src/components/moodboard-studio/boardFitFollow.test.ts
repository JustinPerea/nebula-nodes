import { describe, expect, it, vi } from 'vitest';
import { createBoardFitFollow, FIT_TOLERANCE_PX, FIT_TOLERANCE_ZOOM, sameCamera, type BoardFitFollow, type FitCamera } from './boardFitFollow';

// #209, GM (a): refit on a column resize only while the board is fitted.
// GM, #213 round 3: fitted means the camera is on the fit of the layout the
// board has now (its cards in its column), however it got there.

/** The whole-board fit in a column this size: any function of the size will do. */
const fitAt = (width: number, height: number): FitCamera => ({ x: width / 20 + 3, y: height / 2 - 80.425, zoom: Math.min(width, height) / 5400 });
const FIT = fitAt(870, 851);

function harness(fitted = true) {
  const frames: Array<() => void> = [];
  const camera: FitCamera = { x: 0, y: 0, zoom: 1 };
  const board = { cards: true, width: 0, height: 0 };
  const fitFor = vi.fn((width: number, height: number) => (board.cards ? fitAt(width, height) : null));
  /** A fit lands where it is going at once (the spring is the component's). */
  const refit = vi.fn<(instant: boolean) => boolean>(() => {
    if (!board.cards) return false;
    Object.assign(camera, fitAt(board.width, board.height));
    return true;
  });
  const follow: BoardFitFollow = createBoardFitFollow({
    fitted, refit, fitFor, camera: () => ({ ...camera }),
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: (id) => { frames[id - 1] = () => {}; },
  });
  const resize = (width: number, height: number) => {
    if (width && height) Object.assign(board, { width, height });
    follow.resize(width, height);
  };
  const flush = () => { for (const cb of frames.splice(0)) cb(); };
  /** Fitted at 870 x 851, as a fresh open leaves it. */
  const opened = () => { resize(870, 851); refit.mockClear(); };
  return { follow, refit, flush, frames, camera, opened, resize, board, fitFor };
}

describe('opening', () => {
  it('a board that opens fitted is fit at once at the first size it is measured at', () => {
    const { follow, refit, frames, resize } = harness();
    resize(1000, 800);
    expect(refit).toHaveBeenCalledTimes(1);
    expect(refit).toHaveBeenCalledWith(true);
    expect(frames).toHaveLength(0);
    expect(follow.fitted).toBe(true);
  });

  it('mounted at 0 x 0 (laid out later): the first real size fits it', () => {
    const { refit, resize } = harness();
    resize(0, 0);
    resize(870, 0);
    expect(refit).not.toHaveBeenCalled();
    resize(870, 851);
    expect(refit).toHaveBeenCalledWith(true);
  });

  it('nothing to fit yet (no cards, no camera): it waits, then fits when ready', () => {
    const { follow, refit, resize } = harness();
    refit.mockImplementationOnce(() => false);
    resize(870, 851);
    expect(follow.fitted).toBe(false);
    follow.ready();
    expect(refit).toHaveBeenCalledTimes(2);
    expect(follow.fitted).toBe(true);
    follow.ready();
    expect(refit).toHaveBeenCalledTimes(2);
  });

  it('ready before any size: nothing happens until it is measured', () => {
    const { follow, refit } = harness();
    follow.ready();
    expect(refit).not.toHaveBeenCalled();
  });

  it('a move the person makes before the fit on open cancels it', () => {
    const { follow, refit, resize } = harness();
    refit.mockImplementationOnce(() => false);
    resize(870, 851);
    follow.taken();
    follow.ready();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('a camera the person moved opens as kept: the first size only records it', () => {
    const { follow, refit, flush, resize } = harness(false);
    resize(1000, 800);
    flush();
    expect(refit).not.toHaveBeenCalled();
    expect(follow.fitted).toBe(false);
  });
});

describe('the board stays fitted when its column resizes', () => {
  it('fitted, then a new size: one refit on the next frame, on the spring', () => {
    const { refit, flush, opened, resize } = harness();
    opened();
    resize(430, 851);
    expect(refit).not.toHaveBeenCalled();
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
    expect(refit).toHaveBeenCalledWith(false);
  });

  it('several sizes in one frame give one refit, and the same size gives none', () => {
    const { refit, flush, opened, resize } = harness();
    opened();
    resize(800, 851);
    resize(700, 851);
    resize(430, 802);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
    resize(430, 802);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('each new size after a refit refits again', () => {
    const { refit, flush, opened, resize } = harness();
    opened();
    resize(430, 851);
    flush();
    resize(430, 300);
    flush();
    expect(refit).toHaveBeenCalledTimes(2);
  });

  it('a refit that changes only the camera does not call itself', () => {
    const { refit, flush, frames, opened, resize } = harness();
    opened();
    resize(430, 851);
    flush();
    expect(frames).toHaveLength(0);
    expect(refit).toHaveBeenCalledTimes(1);
  });
});

describe('fitted is read from the camera', () => {
  it('a camera moved off the fit with no event at all (a stuck wheel pan, a focus autopan): no refit', () => {
    const { follow, refit, flush, camera, opened, resize } = harness();
    opened();
    camera.y -= 50; // one wheel notch
    resize(430, 851);
    flush();
    expect(follow.fitted).toBe(false);
    expect(refit).not.toHaveBeenCalled();
  });

  it('a camera that moves between a resize and its frame: that refit does not run', () => {
    const { refit, flush, camera, opened, resize } = harness();
    opened();
    resize(430, 851);
    camera.x += 40;
    flush();
    expect(refit).not.toHaveBeenCalled();
  });

  it('a camera moved back onto the fit is fitted again', () => {
    const { follow, refit, flush, camera, opened, resize } = harness();
    opened();
    camera.y -= 50;
    expect(follow.fitted).toBe(false);
    camera.y += 50;
    expect(follow.fitted).toBe(true);
    resize(430, 851);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('a spring heading to the fit counts as fitted; once it ends off the fit, it does not', () => {
    const { follow, camera, resize } = harness(false);
    resize(870, 851);
    follow.headingToFit();
    Object.assign(camera, { x: 200, y: 10, zoom: 0.5 });
    expect(follow.fitted).toBe(true);
    follow.springEnded();
    expect(follow.fitted).toBe(false);
  });

  it('a spring heading to the fit, then a resize: it refits to the new column (#213 review 1 LOW-2)', () => {
    const { follow, refit, flush, camera, opened, resize } = harness();
    opened();
    Object.assign(camera, { x: 200, y: 10, zoom: 0.5 }); // mid-spring
    follow.headingToFit();
    resize(430, 851);
    flush();
    expect(refit).toHaveBeenCalledWith(false);
    expect(camera).toEqual(fitAt(430, 851));
  });

  it('the camera\'s own move elsewhere (zoom buttons, Show): off the fit it is not fitted, back on it it is (GM, review 4)', () => {
    const { follow, refit, flush, camera, opened, resize } = harness();
    opened();
    follow.headingToFit();
    follow.aside();
    Object.assign(camera, { ...FIT, zoom: FIT.zoom * 1.25 });
    expect(follow.fitted).toBe(false);
    resize(430, 851);
    flush();
    expect(refit).not.toHaveBeenCalled();
    Object.assign(camera, fitAt(430, 851));
    expect(follow.fitted).toBe(true);
    resize(870, 851);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('aside() cancels a refit already waiting for its frame', () => {
    const { follow, refit, flush, opened, resize } = harness();
    opened();
    resize(430, 851);
    follow.aside();
    flush();
    expect(refit).not.toHaveBeenCalled();
  });

  it('a Fit after a move makes it fitted again once it lands', () => {
    const { follow, refit, flush, camera, opened, resize } = harness(false);
    opened();
    resize(430, 851);
    flush();
    expect(refit).not.toHaveBeenCalled();
    follow.headingToFit();
    Object.assign(camera, fitAt(430, 851));
    follow.springEnded();
    resize(870, 851);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels a refit still waiting', () => {
    const { follow, refit, flush, opened, resize } = harness();
    opened();
    resize(430, 851);
    follow.dispose();
    flush();
    expect(refit).not.toHaveBeenCalled();
  });
});

// GM, #213 round 3: the fit of the layout the board has now, however the
// camera got there; a camera on the fit of the column before a resize is
// what a refit frame asks about.
describe('fitted means on the fit of the layout the board has now (GM, #213 round 3)', () => {
  it('not fitted, then the column resizes: a camera that lands on the new column\'s fit (a Show of every card) is fitted', () => {
    const { follow, refit, flush, camera, opened, resize } = harness();
    opened();
    camera.x += 90;
    resize(430, 851);
    flush();
    expect(refit).not.toHaveBeenCalled();
    expect(follow.fitted).toBe(false);
    expect(follow.onFit(fitAt(430, 851))).toBe(true);
    expect(follow.onFit(FIT)).toBe(false); // the old column's fit is not the fit now
    Object.assign(camera, fitAt(430, 851));
    expect(follow.fitted).toBe(true);
    resize(870, 851);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('between a resize and its frame, the camera is judged on the fit of the column before it', () => {
    const { follow, camera, opened, resize } = harness();
    opened();
    resize(430, 851);
    expect(follow.fitted).toBe(true);
    Object.assign(camera, fitAt(430, 851));
    expect(follow.fitted).toBe(false);
  });

  it('nothing to fit (no cards): never fitted, and nothing is on the fit', () => {
    const { follow, camera, board, resize } = harness(false);
    board.cards = false;
    resize(870, 851);
    Object.assign(camera, FIT);
    expect(follow.fitted).toBe(false);
    expect(follow.onFit(FIT)).toBe(false);
    expect(follow.onFit(camera)).toBe(false);
  });

  it('before any size, nothing is on the fit', () => {
    const { follow, fitFor } = harness(false);
    expect(follow.onFit(FIT)).toBe(false);
    expect(fitFor).not.toHaveBeenCalled();
  });
});

describe('the tolerance: half a screen pixel, and 0.001 of zoom (GM, #213 round 3)', () => {
  it('is pinned', () => {
    expect(FIT_TOLERANCE_PX).toBe(0.5);
    expect(FIT_TOLERANCE_ZOOM).toBe(0.001);
  });

  it('x and y: 0.5 px off is the fit, 0.51 px off is not', () => {
    expect(sameCamera({ ...FIT, x: FIT.x + 0.5 }, FIT)).toBe(true);
    expect(sameCamera({ ...FIT, x: FIT.x - 0.51 }, FIT)).toBe(false);
    expect(sameCamera({ ...FIT, y: FIT.y - 0.5 }, FIT)).toBe(true);
    expect(sameCamera({ ...FIT, y: FIT.y + 0.51 }, FIT)).toBe(false);
  });

  it('zoom: 0.0009 off is the fit, 0.0011 off is not, at any zoom', () => {
    expect(sameCamera({ ...FIT, zoom: FIT.zoom + 0.0009 }, FIT)).toBe(true);
    expect(sameCamera({ ...FIT, zoom: FIT.zoom - 0.0011 }, FIT)).toBe(false);
    expect(sameCamera({ x: 0, y: 0, zoom: 1.0009 }, { x: 0, y: 0, zoom: 1 })).toBe(true);
    expect(sameCamera({ x: 0, y: 0, zoom: 0.0511 }, { x: 0, y: 0, zoom: 0.05 })).toBe(false);
  });
});
