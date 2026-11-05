/**
 * An uploaded image's size as shown, kept with its preview as the private
 * param `_previewSize` (backend services/preview_size.py: `POST /api/uploads`
 * returns it as `previewSize`, and a node it creates holds it). The
 * Inspector's preview takes it as `width`/`height`, which gives the `<img>`
 * its aspect ratio before it decodes, so the floating Inspector measures its
 * whole body on the first frame it opens (#226, GM r82). Once the image has
 * loaded its own ratio wins (CSS `aspect-ratio: auto w / h`), so a stale size
 * never distorts it.
 */
export type PreviewSize = { width: number; height: number };

const MAX_SIDE = 100_000;

function side(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_SIDE
    ? Math.round(value) : null;
}

/** A well-formed size, or null (a missing, partial or broken value). */
export function previewSize(value: unknown): PreviewSize | null {
  if (!value || typeof value !== 'object') return null;
  const width = side((value as Record<string, unknown>).width);
  const height = side((value as Record<string, unknown>).height);
  return width && height ? { width, height } : null;
}

/** The `<img>` attributes for a stored size, or none. */
export function previewSizeAttributes(value: unknown): { width?: number; height?: number } {
  const size = previewSize(value);
  return size ? { width: size.width, height: size.height } : {};
}
