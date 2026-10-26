import { backendAssetUrlSync } from './backend';

/** How the app may draw one image of a saved Style or Character.
 *
 * Only Nebula's own files are ever loaded: an output or upload
 * (`/api/outputs/...`, or a loopback URL to it), a shipped Style thumbnail
 * (`/api/presets/thumbnails/...`), or an upload's file path inside the output
 * folder (Create's "Save current" stores those). Anything else gets the
 * caller's placeholder; `outside` says it is a link to somewhere else, so the
 * card can say why it shows no picture. The backend refuses new ones
 * (services/stored_image_refs.py); this keeps a Style or Character saved
 * before that check from making the app fetch an outside host. */
export type StoredImageView = { src: string; outside: false } | { src: null; outside: boolean };

const SERVED = ['/api/outputs/', '/api/presets/thumbnails/'];
const NONE: StoredImageView = { src: null, outside: false };
const OUTSIDE: StoredImageView = { src: null, outside: true };

function served(path: string): boolean {
  return SERVED.some((prefix) => path.startsWith(prefix));
}

/** This machine, as the backend reads it (services/output.py _is_this_machine). */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '0.0.0.0'
    || host === '::' || /^127(\.\d{1,3}){3}$/.test(host);
}

export function storedImageView(value: unknown): StoredImageView {
  if (typeof value !== 'string' || !value.trim()) return NONE;
  const text = value.trim();
  if (served(text)) return { src: backendAssetUrlSync(text), outside: false };
  // As a browser reads it (and the backend's is_outside_link): tabs and
  // newlines dropped, a backslash a slash, so `/\host` is protocol-relative.
  if (text.replace(/[\t\n\r]/g, '').replaceAll('\\', '/').startsWith('//')) return OUTSIDE;
  // A file path (POSIX or Windows): drawn only when it is inside an output folder.
  if (text.startsWith('/') || /^[A-Za-z]:[\\/]/.test(text)) {
    const normalized = text.replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('/output/');
    return marker >= 0
      ? { src: backendAssetUrlSync(`/api/outputs/${normalized.slice(marker + '/output/'.length)}`), outside: false }
      : NONE;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return NONE; // plain text: nothing the browser would fetch
  }
  if ((url.protocol === 'http:' || url.protocol === 'https:') && isLoopback(url.hostname) && served(url.pathname)) {
    // Drawn from the backend this page talks to, whatever port the link named.
    return { src: backendAssetUrlSync(`${url.pathname}${url.search}`), outside: false };
  }
  return url.protocol === 'file:' ? NONE : OUTSIDE;
}

/** What a Style or Character card says where an outside image would be. */
export const OUTSIDE_IMAGE_NOTE = 'Image link from outside Nebula';
