import { afterEach, describe, expect, it, vi } from 'vitest';
import { springProgress, springViewport } from './viewportSpring';

// The board camera's spring, as 0 → 1 progress (GM r5: a filled placeholder's
// image rides it in), and the camera move built on it.

function frames() {
  const queue = new Map<number, FrameRequestCallback>();
  let next = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { next += 1; queue.set(next, cb); return next; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { queue.delete(id); });
  const take = () => { const [id, cb] = queue.entries().next().value!; queue.delete(id); return cb; };
  return {
    run(limit = 600) {
      for (let frame = 0; frame < limit && queue.size; frame += 1) take()(frame * 16);
      return queue.size;
    },
    step() { if (queue.size) take()(0); },
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('springProgress', () => {
  it('steps from 0 to 1 over several frames, ends on exactly 1, then calls done once', () => {
    const clock = frames();
    const seen: number[] = [];
    const done = vi.fn();
    springProgress((p) => seen.push(p), done);
    expect(seen).toEqual([]);
    expect(clock.run()).toBe(0);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen[0]).toBeGreaterThan(0);
    expect(seen[0]).toBeLessThan(0.5);
    expect(seen.at(-1)).toBe(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('a cancel stops it: no more frames, no done', () => {
    const clock = frames();
    const done = vi.fn();
    const apply = vi.fn();
    const cancel = springProgress(apply, done);
    clock.step();
    cancel();
    expect(clock.run()).toBe(0);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(done).not.toHaveBeenCalled();
  });

  it('reduced motion goes straight to 1 with no frame', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    const apply = vi.fn();
    const done = vi.fn();
    springProgress(apply, done);
    expect(apply.mock.calls).toEqual([[1]]);
    expect(done).toHaveBeenCalledTimes(1);
    expect(raf).not.toHaveBeenCalled();
  });
});

describe('springViewport (built on springProgress)', () => {
  it('travels in a straight line and lands exactly on the target', () => {
    const clock = frames();
    const from = { x: 0, y: 0, zoom: 1 };
    const to = { x: 400, y: -200, zoom: 2 };
    const seen: Array<{ x: number; y: number; zoom: number }> = [];
    springViewport(from, to, (view) => seen.push(view));
    clock.run();
    expect(seen.at(-1)).toEqual(to);
    for (const view of seen.slice(0, -1)) {
      expect(view.y).toBeCloseTo(-view.x / 2, 6);
      expect(view.zoom).toBeCloseTo(1 + view.x / 400, 6);
    }
  });

  it('lands on the target itself, not an interpolation that drifts in floating point', () => {
    const clock = frames();
    const to = { x: 0.1, y: 0.2, zoom: 0.1 };
    let last: { x: number; y: number; zoom: number } | null = null;
    // 0.7 + (0.1 - 0.7) * 1 is 0.09999999999999998, not 0.1.
    springViewport({ x: 0.7, y: -0.1, zoom: 0.7 }, to, (view) => { last = view; });
    clock.run();
    expect(last).toBe(to);
  });
});
