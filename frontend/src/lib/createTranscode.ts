import { apiRequest } from './apiRequest';

/** Image formats the gallery download menu offers (server-side transcode). */
export const DOWNLOAD_FORMATS = ['png', 'jpg', 'webp'] as const;
export type DownloadFormat = (typeof DOWNLOAD_FORMATS)[number];

/**
 * Download a gallery image transcoded to `format` via `/api/transcode-image`.
 * Fetches the converted bytes and triggers a browser download. Throws with a
 * readable message on failure.
 */
export async function downloadTranscoded(url: string, format: DownloadFormat): Promise<void> {
  const res = await apiRequest("Couldn't convert the image.", '/api/transcode-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, format }),
  });
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(cd);
  const filename = match ? match[1] : `download.${format}`;
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objectUrl);
}
