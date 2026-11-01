import { describe, expect, it, vi } from 'vitest';
import { createBoardFitFollow, FIT_TOLERANCE_PX, FIT_TOLERANCE_ZOOM, sameCamera, type BoardFitFollow, type FitCamera } from './boardFitFollow';

// #209, GM (a): refit on a column resize only while the camera is still where
// the last whole-board fit left it. Fitted is read from the camera.

const FIT: FitCamera = { x: 23, y: 344.575, zoom: 0.157442 };

function harness(fitted = true) {
  const frames: Array<() => void> = [];
  const camera: FitCamera = { x: 0, y: 0, zoom: 1 };
  /** A fit lands where it is going at once (the spring is the component's). */
  const refit = vi.fn<(instant: boolean) => boolean>(() => {
    follow.fitTo(FIT, false);
    Object.assign(camera, FIT);
    return true;
  });
  const follow: BoardFitFollow = createBoardFitFollow({
    fitted, refit, camera: () => ({ ...camera }),
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: (id) => { frames[id - 1] = () => {}; },
  });
  const flush = () => { for (const cb of frames.splice(0)) cb(); };
  /** Fitted at 870 x 851, as a fresh open leaves it. */
  const opened = () => { follow.resize(870, 851); refit.mockClear(); };
  return { follow, refit, flush, frames, camera, opened };
}

describe('opening', () => {
  it('a board that opens fitted is fit at once at the first size it is measured at', () => {
    const { follow, refit, frames } = harness();
    follow.resize(1000, 800);
    expect(refit).toHaveBeenCalledTimes(1);
    expect(refit).toHaveBeenCalledWith(true);
    expect(frames).toHaveLength(0);
    expect(follow.fitted).toBe(true);
  });

  it('mounted at 0 x 0 (laid out later): the first real size fits it', () => {
    const { follow, refit } = harness();
    follow.resize(0, 0);
    follow.resize(870, 0);
    expect(refit).not.toHaveBeenCalled();
    follow.resize(870, 851);
    expect(refit).toHaveBeenCalledWith(true);
  });

  it('nothing to fit yet (no cards, no camera): it waits, then fits when ready', () => {
    const { follow, refit } = harness();
    refit.mockImplementationOnce(() => false);
    follow.resize(870, 851);
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
    const { follow, refit } = harness();
    refit.mockImplementationOnce(() => false);
    follow.resize(870, 851);
    follow.taken();
    follow.ready();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('a camera the person moved opens as kept: the first size only records it', () => {
    const { follow, refit, flush } = harness(false);
    follow.resize(1000, 800);
    flush();
    expect(refit).not.toHaveBeenCalled();
    expect(follow.fitted).toBe(false);
  });
});

describe('the board stays fitted when its column resizes', () => {
  it('fitted, then a new size: one refit on the next frame, on the spring', () => {
    const { follow, refit, flush, opened } = harness();
    opened();
    follow.resize(430, 851);
    expect(refit).not.toHaveBeenCalled();
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
    expect(refit).toHaveBeenCalledWith(false);
  });

  it('several sizes in one frame give one refit, and the same size gives none', () => {
    const { follow, refit, flush, opened } = harness();
    opened();
    follow.resize(800, 851);
    follow.resize(700, 851);
    follow.resize(430, 802);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
    follow.resize(430, 802);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('each new size after a refit refits again', () => {
    const { follow, refit, flush, opened } = harness();
    opened();
    follow.resize(430, 851);
    flush();
    follow.resize(430, 300);
    flush();
    expect(refit).toHaveBeenCalledTimes(2);
  });

  it('a refit that changes only the camera does not call itself', () => {
    const { follow, refit, flush, frames, opened } = harness();
    opened();
    follow.resize(430, 851);
    flush();
    expect(frames).toHaveLength(0);
    expect(refit).toHaveBeenCalledTimes(1);
  });
});

describe('fitted is read from the camera', () => {
  it('a camera moved off the fit with no event at all (a stuck wheel pan, a focus autopan): no refit', () => {
    const { follow, refit, flush, camera, opened } = harness();
    opened();
    camera.y -= 50; // one wheel notch
    follow.resize(430, 851);
    flush();
    expect(follow.fitted).toBe(false);
    expect(refit).not.toHaveBeenCalled();
  });

  it('a camera that moves between a resize and its frame: that refit does not run', () => {
    const { follow, refit, flush, camera, opened } = harness();
    opened();
    follow.resize(430, 851);
    camera.x += 40;
    flush();
    expect(refit).not.toHaveBeenCalled();
  });

  it('a camera moved back onto the fit is fitted again', () => {
    const { follow, refit, flush, camera, opened } = harness();
    opened();
    camera.y -= 50;
    expect(follow.fitted).toBe(false);
    camera.y += 50;
    expect(follow.fitted).toBe(true);
    follow.resize(430, 851);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('a fit spring still heading to its target counts as fitted; once it ends off target, it does not', () => {
    const { follow, camera } = harness(false);
    follow.fitTo(FIT, true);
    Object.assign(camera, { x: 200, y: 10, zoom: 0.5 });
    expect(follow.fitted).toBe(true);
    follow.springEnded();
    expect(follow.fitted).toBe(false);
  });

  it('the camera\'s own move elsewhere (zoom buttons, Show) leaves no fit, even back on the old target', () => {
    const { follow, refit, flush, camera, opened } = harness();
    opened();
    follow.leave();
    Object.assign(camera, FIT);
    expect(follow.fitted).toBe(false);
    follow.resize(430, 851);
    flush();
    expect(refit).not.toHaveBeenCalled();
  });

  it('leave() cancels a refit already waiting for its frame', () => {
    const { follow, refit, flush, opened } = harness();
    opened();
    follow.resize(430, 851);
    follow.leave();
    flush();
    expect(refit).not.toHaveBeenCalled();
  });

  it('a Fit after a move makes it fitted again once it lands', () => {
    const { follow, refit, flush, camera, opened } = harness(false);
    opened();
    follow.resize(430, 851);
    flush();
    expect(refit).not.toHaveBeenCalled();
    follow.fitTo(FIT, true);
    Object.assign(camera, FIT);
    follow.springEnded();
    follow.resize(870, 851);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels a refit still waiting', () => {
    const { follow, refit, flush, opened } = harness();
    opened();
    follow.resize(430, 851);
    follow.dispose();
    flush();
    expect(refit).not.toHaveBeenCalled();
  });
});

describe('the tolerance: half a screen pixel, and 5e-4 of the zoom', () => {
  it('is pinned', () => {
    expect(FIT_TOLERANCE_PX).toBe(0.5);
    expect(FIT_TOLERANCE_ZOOM).toBe(5e-4);
  });

  it('x and y: 0.4 px off is the fit, 0.6 px off is not', () => {
    expect(sameCamera({ ...FIT, x: FIT.x + 0.4 }, FIT)).toBe(true);
    expect(sameCamera({ ...FIT, x: FIT.x - 0.6 }, FIT)).toBe(false);
    expect(sameCamera({ ...FIT, y: FIT.y - 0.4 }, FIT)).toBe(true);
    expect(sameCamera({ ...FIT, y: FIT.y + 0.6 }, FIT)).toBe(false);
  });

  it('zoom, relative to the fit\'s: 4e-4 of it off is the fit, 6e-4 is not', () => {
    expect(sameCamera({ ...FIT, zoom: FIT.zoom * (1 + 4e-4) }, FIT)).toBe(true);
    expect(sameCamera({ ...FIT, zoom: FIT.zoom * (1 - 6e-4) }, FIT)).toBe(false);
    // Relative, not absolute: at zoom 1, 4e-4 is still the fit.
    expect(sameCamera({ x: 0, y: 0, zoom: 1.0004 }, { x: 0, y: 0, zoom: 1 })).toBe(true);
  });
});
