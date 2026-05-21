/**
 * Frame-grid snapping + requestVideoFrameCallback feature detection.
 *
 * HTML5 currentTime is NOT frame-accurate by default across browsers.
 * Snap times to Math.floor(t * fps) / fps before passing them anywhere.
 */

export function snapToFrameGrid(timestamp: number, fps: number): number {
  if (fps <= 0) return timestamp;
  return Math.floor(timestamp * fps) / fps;
}

export function hasRequestVideoFrameCallback(): boolean {
  if (typeof window === 'undefined') return false;
  return 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
}
