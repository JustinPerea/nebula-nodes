/**
 * SMPTE-style HH:MM:SS:FF timecode formatting / parsing.
 *
 * Used throughout the editor so all time displays speak the same language.
 * Non-integer fps (e.g. 29.97) is rounded to the nearest integer for the
 * frames component — accurate enough for display; ffmpeg uses the true fps.
 */

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

export function formatSmpte(timestamp: number, fps: number): string {
  const fpsR = Math.round(fps);
  const totalFrames = Math.round(timestamp * fpsR);
  const frames = totalFrames % fpsR;
  const totalSeconds = Math.floor(totalFrames / fpsR);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}:${pad2(frames)}`;
}

export function parseSmpte(smpte: string, fps: number): number {
  const m = smpte.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return NaN;
  const [, hh, mm, ss, ff] = m;
  const fpsR = Math.round(fps);
  return parseInt(hh, 10) * 3600 + parseInt(mm, 10) * 60 + parseInt(ss, 10) + parseInt(ff, 10) / fpsR;
}
