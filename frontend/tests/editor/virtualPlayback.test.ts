import { describe, it, expect } from 'vitest';
import {
  type EditClip,
  clipSpeed,
  clipOutputDuration,
  totalOutputDuration,
  outputTimeToSourceTime,
  sourceTimeToActiveClipIndex,
} from '../../src/lib/editor/virtualPlayback';

// Two end-to-end clips. clip[1] is at 0.5x speed so it stretches: 2s of source
// becomes 4s of output. Total output: 2 + 4 = 6s.
const clips: EditClip[] = [
  { id: 'c1', start: 0, duration: 2, sourceIn: 0, sourceOut: 2, volume: 1, mute: false },
  { id: 'c2', start: 2, duration: 4, sourceIn: 2, sourceOut: 4, volume: 1, mute: false },
];

describe('clipSpeed', () => {
  it('derives 1.0 when duration matches source range', () => {
    expect(clipSpeed(clips[0])).toBeCloseTo(1.0, 5);
  });
  it('derives 0.5 when output duration is double source range', () => {
    expect(clipSpeed(clips[1])).toBeCloseTo(0.5, 5);
  });
  it('returns 1 for zero-duration safety fallback', () => {
    const degenerate: EditClip = { id: 'x', start: 0, duration: 0, sourceIn: 0, sourceOut: 1, volume: 1, mute: false };
    expect(clipSpeed(degenerate)).toBe(1);
  });
});

describe('clipOutputDuration', () => {
  it('returns clip.duration directly (output is stored, not computed)', () => {
    expect(clipOutputDuration(clips[0])).toBe(2);
    expect(clipOutputDuration(clips[1])).toBe(4);
  });
});

describe('totalOutputDuration', () => {
  it('sums clip durations for end-to-end clips', () => {
    expect(totalOutputDuration(clips)).toBeCloseTo(6.0, 5);
  });
  it('returns 0 for empty clips array', () => {
    expect(totalOutputDuration([])).toBe(0);
  });
});

describe('outputTimeToSourceTime', () => {
  it('returns first clip sourceIn at output 0', () => {
    expect(outputTimeToSourceTime(0, clips)).toEqual({ clipIndex: 0, sourceTime: 0 });
  });
  it('maps within first clip at output 1.5 (speed 1, sourceTime=1.5)', () => {
    const r = outputTimeToSourceTime(1.5, clips);
    expect(r.clipIndex).toBe(0);
    expect(r.sourceTime).toBeCloseTo(1.5, 5);
  });
  it('crosses into second clip at output 3 (0.5s into clip[1] at 0.5x → 0.25s of source past sourceIn=2)', () => {
    const r = outputTimeToSourceTime(3.0, clips);
    expect(r.clipIndex).toBe(1);
    expect(r.sourceTime).toBeCloseTo(2.5, 5);
  });
  it('clamps to last clip sourceOut past end', () => {
    const r = outputTimeToSourceTime(10.0, clips);
    expect(r.clipIndex).toBe(1);
    expect(r.sourceTime).toBeCloseTo(4.0, 5);
  });
  it('returns clipIndex -1 for empty clips array', () => {
    expect(outputTimeToSourceTime(1.0, [])).toEqual({ clipIndex: -1, sourceTime: 0 });
  });
});

describe('sourceTimeToActiveClipIndex', () => {
  it('finds first clip whose source range contains the given source time', () => {
    expect(sourceTimeToActiveClipIndex(0.5, clips)).toBe(0);
    expect(sourceTimeToActiveClipIndex(3.0, clips)).toBe(1);
  });
  it('returns -1 if no clip contains the source time', () => {
    expect(sourceTimeToActiveClipIndex(99, clips)).toBe(-1);
  });
});
