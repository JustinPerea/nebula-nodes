import { describe, it, expect } from 'vitest';
import {
  type EditClip,
  totalOutputDuration,
  outputTimeToSourceTime,
  sourceTimeToActiveClipIndex,
} from '../../src/lib/editor/virtualPlayback';

const clips: EditClip[] = [
  { id: 'c1', sourceIn: 0.0, sourceOut: 2.0, speed: 1.0, volume: 1.0, mute: false },
  { id: 'c2', sourceIn: 2.0, sourceOut: 4.0, speed: 0.5, volume: 1.0, mute: false },
];

describe('totalOutputDuration', () => {
  it('sums speed-adjusted sub-clip durations', () => {
    expect(totalOutputDuration(clips)).toBeCloseTo(6.0, 5);
  });
});

describe('outputTimeToSourceTime', () => {
  it('returns first clip at output 0', () => {
    expect(outputTimeToSourceTime(0, clips)).toEqual({ clipIndex: 0, sourceTime: 0.0 });
  });
  it('returns within first clip', () => {
    const r = outputTimeToSourceTime(1.5, clips);
    expect(r.clipIndex).toBe(0);
    expect(r.sourceTime).toBeCloseTo(1.5, 5);
  });
  it('crosses into second clip', () => {
    const r = outputTimeToSourceTime(3.0, clips);
    expect(r.clipIndex).toBe(1);
    expect(r.sourceTime).toBeCloseTo(2.5, 5);
  });
  it('clamps at end', () => {
    const r = outputTimeToSourceTime(10.0, clips);
    expect(r.clipIndex).toBe(1);
    expect(r.sourceTime).toBeCloseTo(4.0, 5);
  });
});

describe('sourceTimeToActiveClipIndex', () => {
  it('finds containing clip', () => {
    expect(sourceTimeToActiveClipIndex(0.5, clips)).toBe(0);
    expect(sourceTimeToActiveClipIndex(3.0, clips)).toBe(1);
  });
  it('returns -1 if no clip contains the time', () => {
    expect(sourceTimeToActiveClipIndex(99, clips)).toBe(-1);
  });
});
