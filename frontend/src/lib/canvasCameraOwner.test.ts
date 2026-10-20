import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cameraMoveIsCanvasOwn, cameraMoveStarted, claimCameraMove, resetCanvasCameraForTests } from './canvasCameraOwner';

// React Flow reports every camera move as start, frames, end (d3-zoom's
// gesture; an interrupted transition ends too), the end on a timer. A move
// with no input event is programmatic, but the person's toolbar zoom and Fit
// view are programmatic as well: only a move the canvas claimed right before
// it started is the canvas's own (its fit after an agent's nodes land, an
// arrange's reveal), and it stays so until the next move starts.

const wheel = new WheelEvent('wheel');

beforeEach(() => { resetCanvasCameraForTests(); vi.useFakeTimers(); });
afterEach(() => vi.useRealTimers());

describe('which camera moves are the canvas’s own', () => {
  it('a claimed move, every frame of it, until the next move starts', () => {
    claimCameraMove();
    cameraMoveStarted(null);
    expect(cameraMoveIsCanvasOwn(null)).toBe(true);
    expect(cameraMoveIsCanvasOwn(null)).toBe(true);
    cameraMoveStarted(null);
    expect(cameraMoveIsCanvasOwn(null)).toBe(false);
  });

  it('not a programmatic move nobody claimed (the toolbar’s zoom, Fit view)', () => {
    cameraMoveStarted(null);
    expect(cameraMoveIsCanvasOwn(null)).toBe(false);
  });

  it('not the person’s pan or zoom, even in the middle of the canvas’s move', () => {
    claimCameraMove();
    cameraMoveStarted(null);
    expect(cameraMoveIsCanvasOwn(wheel)).toBe(false);
    cameraMoveStarted(new MouseEvent('mousedown'));
    expect(cameraMoveIsCanvasOwn(null)).toBe(false);
  });

  it('not a move of the person’s that interrupts the canvas’s (d3 ends the first, then starts the next)', () => {
    claimCameraMove();
    cameraMoveStarted(null);
    cameraMoveStarted(null);
    expect(cameraMoveIsCanvasOwn(null)).toBe(false);
  });

  it('a new claim during the canvas’s move is taken by the next move (a reveal frame interrupting its fit)', () => {
    claimCameraMove();
    cameraMoveStarted(null);
    claimCameraMove();
    cameraMoveStarted(null);
    expect(cameraMoveIsCanvasOwn(null)).toBe(true);
  });

  it('a claim no move took up expires, so it can’t mark a much later move', () => {
    claimCameraMove();
    vi.advanceTimersByTime(1500);
    cameraMoveStarted(null);
    expect(cameraMoveIsCanvasOwn(null)).toBe(false);
  });
});
