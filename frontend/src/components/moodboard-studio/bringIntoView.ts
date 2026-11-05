/**
 * A reading's citation chip, clicked (GM's board reading design section 3):
 * the tile is selected, and the camera moves only if the tile isn't wholly in
 * view. Then it is brought in on Fit's spring at the zoom the person had,
 * centred, or zoomed out just enough when it is bigger than the view. Never
 * zoomed in: the person chose that zoom.
 */

export interface Rect { x: number; y: number; width: number; height: number }
export interface Camera { x: number; y: number; zoom: number }

/** The camera that brings `bounds` (board px) into a `width` × `height` view,
 *  or null when it is already wholly in view. `padding` is the fraction of the
 *  view kept clear around it (Fit's padding). */
export function bringIntoView(bounds: Rect, camera: Camera, width: number, height: number, padding: number): Camera | null {
  if (!(width > 0) || !(height > 0) || !(camera.zoom > 0)) return null;
  const left = -camera.x / camera.zoom;
  const top = -camera.y / camera.zoom;
  const right = left + width / camera.zoom;
  const bottom = top + height / camera.zoom;
  if (bounds.x >= left && bounds.y >= top && bounds.x + bounds.width <= right && bounds.y + bounds.height <= bottom) {
    return null;
  }
  const room = 1 + 2 * padding;
  const fits = Math.min(width / (bounds.width * room || 1), height / (bounds.height * room || 1));
  const zoom = Math.min(camera.zoom, fits);
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  return { zoom, x: width / 2 - cx * zoom, y: height / 2 - cy * zoom };
}
