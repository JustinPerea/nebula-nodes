import { describe, it, expect } from 'vitest';
import {
  type EditClip,
  clipSpeed,
  clipOutputDuration,
  totalOutputDuration,
  outputTimeToSourceTime,
  sourceTimeToActiveClipIndex,
  isClipEdited,
  clampSpeedToFloor,
  MIN_OUTPUT_DURATION,
} from '../../src/lib/editor/virtualPlayback';

// Two end-to-end clips. clip[1] is at 0.5x speed so it stretches: 2s of source
// becomes 4s of output. Total output: 2 + 4 = 6s.
const clips: EditClip[] = [
  { id: 'c1', start: 0, duration: 2, sourceIn: 0, sourceOut: 2, volume: 1, mute: false },
  { id: 'c2', start: 2, duration: 4, sourceIn: 2, sourceOut: 4, volume: 1, mute: false },
];

describe('clampSpeedToFloor', () => {
  // Phase F handoff flagged the math edge case: at 4× speed on a 0.3s source
  // range, the prior unclamped math produced 0.075s output — below the
  // intended 0.1s floor. clampSpeedToFloor caps the effective speed so the
  // output never dips beneath MIN_OUTPUT_DURATION.

  it('leaves the requested speed untouched when source range is comfortable', () => {
    const { speed, duration } = clampSpeedToFloor(2, 4);  // 4s source, 2× → 2s output
    expect(speed).toBe(2);
    expect(duration).toBe(2);
  });

  it('caps the requested speed when output would fall below the floor', () => {
    // 0.3s source, requested 4× → would be 0.075s output. Max safe speed is
    // sourceRange / floor = 0.3 / 0.1 = 3×.
    const { speed, duration } = clampSpeedToFloor(4, 0.3);
    expect(speed).toBeCloseTo(3, 5);
    expect(duration).toBeCloseTo(0.1, 5);
  });

  it('holds speed at 1× when the source itself is shorter than the floor', () => {
    // 0.05s source: no speed can produce ≥ 0.1s output. Fall back to native.
    const { speed, duration } = clampSpeedToFloor(2, 0.05);
    expect(speed).toBe(1);
    expect(duration).toBe(0.05);
  });

  it('honors a custom floor when supplied', () => {
    const { duration } = clampSpeedToFloor(4, 0.3, 0.2);  // custom 0.2s floor
    expect(duration).toBeCloseTo(0.2, 5);
  });

  it('exports MIN_OUTPUT_DURATION as the shared floor constant', () => {
    expect(MIN_OUTPUT_DURATION).toBe(0.1);
  });
});

describe('isClipEdited', () => {
  // sourceDuration of 8s for all cases — matches what the editor reads off
  // the source node after ffprobe.
  const SOURCE_DUR = 8;
  const baseClip = (overrides: Partial<EditClip> = {}): EditClip => ({
    id: 'c1', start: 0, duration: 8, sourceIn: 0, sourceOut: 8, volume: 1, mute: false, ...overrides,
  });

  it('returns false for the seeded full-span no-op clip', () => {
    expect(isClipEdited(baseClip(), SOURCE_DUR)).toBe(false);
  });

  it('fires when speed deviates from 1.0', () => {
    // duration=16 over a 0-to-8 source range = 0.5x derived speed
    expect(isClipEdited(baseClip({ duration: 16 }), SOURCE_DUR)).toBe(true);
  });

  it('fires when volume drops below 1.0', () => {
    expect(isClipEdited(baseClip({ volume: 0.4 }), SOURCE_DUR)).toBe(true);
  });

  it('fires when the clip is muted', () => {
    expect(isClipEdited(baseClip({ mute: true }), SOURCE_DUR)).toBe(true);
  });

  it('fires when the head is trimmed (sourceIn > 0)', () => {
    expect(isClipEdited(baseClip({ sourceIn: 1, duration: 7 }), SOURCE_DUR)).toBe(true);
  });

  // Regression: this is the case that silently broke during the output-time
  // refactor's prop-renaming. sourceIn=0, speed=1, vol=1, mute=false — the
  // only divergence is sourceOut decreased. Without the sourceOut check,
  // the badge never fired for tail-only trims.
  it('fires when only the tail is trimmed (sourceOut < sourceDuration)', () => {
    expect(isClipEdited(baseClip({ sourceOut: 4, duration: 4 }), SOURCE_DUR)).toBe(true);
  });
});

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
