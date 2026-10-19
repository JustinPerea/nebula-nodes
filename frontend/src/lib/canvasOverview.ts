/**
 * The zoomed-out canvas (design-canvas gap 19). Below CANVAS_LOD_ZOOM the
 * canvas shows light previews: a node's image, or a still of its video, comes
 * from a small thumbnail the backend makes once (`/api/outputs/<file>?thumb=1`),
 * while players, 3D views, text and port labels hide (canvas.css). Fit view on
 * a 20-node board lands near 36%, so the overview has to keep its pictures.
 */
export const CANVAS_LOD_ZOOM = 0.4;

const OUTPUTS_PREFIX = '/api/outputs/';
// What the backend can make a thumbnail of (services/output_thumbnail.py).
const THUMBNAIL_SUFFIX = /\.(png|jpe?g|webp|gif|bmp|tiff?|mp4|mov|webm|m4v|mkv)$/i;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The overview thumbnail of a Nebula output, or null when there is none to
 * make: another site's URL, a data or blob URL, an SVG or another kind of file. */
export function overviewThumbnailUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  const relative = src.startsWith('/') && !src.startsWith('//');
  let url: URL;
  try {
    url = new URL(src, 'http://nebula.invalid');
  } catch {
    return null;
  }
  if (!relative && !(url.protocol === 'http:' || url.protocol === 'https:')) return null;
  if (!relative && !LOOPBACK_HOSTS.has(url.hostname) && !sameOrigin(url)) return null;
  if (!url.pathname.startsWith(OUTPUTS_PREFIX) || !THUMBNAIL_SUFFIX.test(url.pathname)) return null;
  url.searchParams.set('thumb', '1');
  return relative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

function sameOrigin(url: URL): boolean {
  return typeof window !== 'undefined' && url.origin === window.location.origin;
}
