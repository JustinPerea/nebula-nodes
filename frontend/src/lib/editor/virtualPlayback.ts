/**
 * Pure math for stepping through edit sub-clips during virtual playback.
 *
 * Translates between OUTPUT time (perceived edited timeline) and SOURCE
 * time (where to seek <video>.currentTime).
 */

export interface EditClip {
  id: string;
  sourceIn: number;
  sourceOut: number;
  speed: number;
  volume: number;
  mute: boolean;
}

export function clipOutputDuration(clip: EditClip): number {
  if (clip.speed <= 0) return 0;
  return (clip.sourceOut - clip.sourceIn) / clip.speed;
}

export function totalOutputDuration(clips: EditClip[]): number {
  return clips.reduce((s, c) => s + clipOutputDuration(c), 0);
}

export function outputTimeToSourceTime(
  outputTime: number,
  clips: EditClip[],
): { clipIndex: number; sourceTime: number } {
  if (clips.length === 0) return { clipIndex: -1, sourceTime: 0 };
  if (outputTime <= 0) return { clipIndex: 0, sourceTime: clips[0].sourceIn };

  let remaining = outputTime;
  for (let i = 0; i < clips.length; i++) {
    const dur = clipOutputDuration(clips[i]);
    if (remaining <= dur) {
      return { clipIndex: i, sourceTime: clips[i].sourceIn + remaining * clips[i].speed };
    }
    remaining -= dur;
  }
  const last = clips[clips.length - 1];
  return { clipIndex: clips.length - 1, sourceTime: last.sourceOut };
}

export function sourceTimeToActiveClipIndex(sourceTime: number, clips: EditClip[]): number {
  return clips.findIndex((c) => sourceTime >= c.sourceIn && sourceTime <= c.sourceOut);
}
