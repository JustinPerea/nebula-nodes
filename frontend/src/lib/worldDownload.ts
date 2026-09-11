import { backendAssetUrlSync } from './backend';
import { AssetByteLimitError, readBoundedAssetResponse } from './boundedAsset';
import { isSafeWorldUrl } from './worldValue';

// Blob fallback intentionally stays below graph-bundle totals: the browser
// briefly holds both the byte array and Blob/object URL. Larger exports should
// be downloaded from Marble rather than risking a tab crash.
export const WORLD_DOWNLOAD_MAX_BLOB_BYTES = 256 * 1024 * 1024;

export interface WorldDownloadOptions {
  signal?: AbortSignal;
  maxBlobBytes?: number;
  tooLargeMessage?: string;
}

function safeDownloadName(filename: string): string {
  const withoutUnsafeCharacters = Array.from(filename.normalize('NFKC'), (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f || '/\\:*?"<>|'.includes(character)
      ? '-'
      : character;
  }).join('');
  const normalized = withoutUnsafeCharacters
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.slice(0, 180) || 'world-asset.bin';
}

/** Fetch an asset into a Blob before triggering save, including cross-port
 * localhost assets where an `<a download>` attribute would otherwise be
 * ignored. Throws a user-safe error so the caller can render failure state. */
export async function downloadWorldAsset(
  url: string,
  filename: string,
  options: WorldDownloadOptions = {},
): Promise<void> {
  if (!isSafeWorldUrl(url)) throw new Error('The asset URL is not safe to download.');

  let response: Response;
  try {
    response = await fetch(backendAssetUrlSync(url), { signal: options.signal, cache: 'no-store' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('The asset could not be reached.');
  }
  if (!response.ok) throw new Error(`The asset server returned HTTP ${response.status}.`);

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await readBoundedAssetResponse(
      response,
      options.maxBlobBytes ?? WORLD_DOWNLOAD_MAX_BLOB_BYTES,
    );
  } catch (error) {
    if (error instanceof AssetByteLimitError) {
      throw new Error(
        options.tooLargeMessage
        ?? 'This asset is too large for a safe in-browser download. Open it in Marble instead.',
      );
    }
    throw error;
  }
  const blob = new Blob([bytes]);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = safeDownloadName(filename);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Allow the browser to begin consuming the object URL before revocation.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }
}

export function worldAssetFilename(
  displayName: string,
  assetLabel: string,
  extension: string,
): string {
  const base = displayName
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'world';
  const label = assetLabel
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'asset';
  const ext = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `${base}-${label}.${ext}`;
}

/** Preserve the backend-validated panorama format in the saved filename. The
 * local output service gives magic-validated images a matching extension; an
 * unknown or extensionless imported URL stays `.bin` instead of being mislabeled. */
export function worldImageExtensionFromUrl(url: string): string {
  try {
    const pathname = new URL(url, 'http://nebula.local').pathname.toLowerCase();
    const extension = pathname.match(/\.([a-z0-9]+)$/)?.[1] ?? '';
    return ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension) ? extension : 'bin';
  } catch {
    return 'bin';
  }
}
