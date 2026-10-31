import { describe, expect, it, vi } from 'vitest';
import { createBoardFitFollow } from './boardFitFollow';

// #209, GM (a): refit on a column resize only while the camera is still where
// the last whole-board fit left it.

function harness(fitted = true) {
  const frames: Array<() => void> = [];
  const refit = vi.fn();
  const follow = createBoardFitFollow({
    fitted, refit,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: (id) => { frames[id - 1] = () => {}; },
  });
  const flush = () => { for (const cb of frames.splice(0)) cb(); };
  return { follow, refit, flush, frames };
}

describe('the board stays fitted when its column resizes', () => {
  it('the first size only records it: fit on open has used it', () => {
    const { follow, refit, flush } = harness();
    follow.resize(1000, 800);
    flush();
    expect(refit).not.toHaveBeenCalled();
  });

  it('fitted, then a new size: one refit on the next frame', () => {
    const { follow, refit, flush } = harness();
    follow.resize(870, 851);
    follow.resize(430, 851);
    expect(refit).not.toHaveBeenCalled();
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('several sizes in one frame give one refit, and the same size gives none', () => {
    const { follow, refit, flush } = harness();
    follow.resize(870, 851);
    follow.resize(800, 851);
    follow.resize(700, 851);
    follow.resize(430, 802);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
    follow.resize(430, 802);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('a refit that changes only the camera does not call itself', () => {
    const { follow, refit, flush, frames } = harness();
    refit.mockImplementation(() => follow.markFitted());
    follow.resize(870, 851);
    follow.resize(430, 851);
    flush();
    expect(frames).toHaveLength(0);
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('a person\'s pan or zoom (a move with a source event) keeps their view', () => {
    const { follow, refit, flush } = harness();
    follow.resize(870, 851);
    follow.moveStart(new Event('wheel'));
    follow.resize(430, 851);
    flush();
    expect(follow.fitted).toBe(false);
    expect(refit).not.toHaveBeenCalled();
  });

  it('the camera\'s own moves (no source event: the fit spring, fit on open) keep it fitted', () => {
    const { follow, refit, flush } = harness();
    follow.resize(870, 851);
    follow.moveStart(null);
    follow.moveStart(undefined);
    follow.resize(430, 851);
    flush();
    expect(follow.fitted).toBe(true);
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('a move that lands between a resize and its frame cancels that refit', () => {
    const { follow, refit, flush } = harness();
    follow.resize(870, 851);
    follow.resize(430, 851);
    follow.leave();
    flush();
    expect(refit).not.toHaveBeenCalled();
  });

  it('a Fit after a pan makes it fitted again', () => {
    const { follow, refit, flush } = harness(false);
    follow.resize(870, 851);
    follow.resize(430, 851);
    flush();
    expect(refit).not.toHaveBeenCalled();
    follow.markFitted();
    follow.resize(870, 851);
    flush();
    expect(refit).toHaveBeenCalledTimes(1);
  });

  it('dispose cancels a refit still waiting', () => {
    const { follow, refit, flush } = harness();
    follow.resize(870, 851);
    follow.resize(430, 851);
    follow.dispose();
    flush();
    expect(refit).not.toHaveBeenCalled();
  });
});
