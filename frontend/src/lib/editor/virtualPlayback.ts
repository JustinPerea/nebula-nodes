/**
 * Pure math for stepping through edit sub-clips during virtual playback.
 *
 * Coordinate model (matches FCPXML / OpenTimelineIO industry convention):
 *   start, duration   — OUTPUT time (where the clip sits on the edited timeline)
 *   sourceIn, sourceOut — SOURCE time (which range of the original media plays)
 *   speed              — DERIVED: (sourceOut - sourceIn) / duration
 *
 * Clips are stored in playback order. The store enforces the end-to-end
 * invariant clips[i].start = clips[i-1].start + clips[i-1].duration; this
 * file trusts that invariant when iterating.
 */

export interface EditClip {
  id: string;
  /** Where this clip starts on the output (edited) timeline, seconds. */
  start: number;
  /** How long this clip occupies on the output timeline, seconds. */
  duration: number;
  /** Source media in-point (which frame of the file starts playback). */
  sourceIn: number;
  /** Source media out-point (which frame of the file ends playback). */
  sourceOut: number;
  volume: number;
  mute: boolean;
}

/**
 * Derived playback rate. Returns 1 for degenerate (zero-duration) clips so
 * downstream math never divides by zero.
 */
export function clipSpeed(clip: EditClip): number {
  if (clip.duration <= 0) return 1;
  return (clip.sourceOut - clip.sourceIn) / clip.duration;
}

export function clipOutputDuration(clip: EditClip): number {
  return clip.duration;
}

export function totalOutputDuration(clips: EditClip[]): number {
  return clips.reduce((s, c) => s + c.duration, 0);
}

/**
 * Map an output-time position to its corresponding source media position.
 * Returns the index of the clip containing outputTime and the source frame
 * that should play at that moment. Out-of-range times clamp to the nearest
 * endpoint.
 */
export function outputTimeToSourceTime(
  outputTime: number,
  clips: EditClip[],
): { clipIndex: number; sourceTime: number } {
  if (clips.length === 0) return { clipIndex: -1, sourceTime: 0 };
  if (outputTime <= clips[0].start) return { clipIndex: 0, sourceTime: clips[0].sourceIn };

  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const clipEnd = c.start + c.duration;
    if (outputTime <= clipEnd) {
      const localOutput = outputTime - c.start;
      const speed = clipSpeed(c);
      return { clipIndex: i, sourceTime: c.sourceIn + localOutput * speed };
    }
  }
  const last = clips[clips.length - 1];
  return { clipIndex: clips.length - 1, sourceTime: last.sourceOut };
}

/**
 * Reverse lookup: which clip's source range contains this source time?
 * Used for scrubbing decisions that originate in source space rather than
 * output space. Returns the first matching clip or -1.
 */
export function sourceTimeToActiveClipIndex(sourceTime: number, clips: EditClip[]): number {
  return clips.findIndex((c) => sourceTime >= c.sourceIn && sourceTime <= c.sourceOut);
}
