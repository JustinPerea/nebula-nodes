import { backendAssetUrlSync } from './backend';
import { apiRequest } from './apiRequest';
import { FailureNotice } from './errorCopy';

export interface UploadedReference {
  filePath: string;   // absolute on-disk path — safe to feed image-input
  previewUrl: string; // served /api/outputs URL for display
}

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export async function uploadReference(file: File, signal?: AbortSignal): Promise<UploadedReference> {
  // Written lines under the upload's heading (round 3e: as plain Errors the
  // chip read GM's general line instead).
  const heading = `Couldn't upload ${file.name || 'the image'}.`;
  if (file.size > MAX_REFERENCE_BYTES) throw new FailureNotice(heading, 'Image exceeds the 20 MB limit.');
  const type = file.type.toLowerCase();
  if (!IMAGE_TYPES.has(type)
    && !((!type || type === 'application/octet-stream') && /\.(png|jpe?g|gif|webp)$/i.test(file.name))) {
    throw new FailureNotice(heading, 'Use a PNG, JPEG, GIF or WebP image.');
  }
  const form = new FormData();
  form.append('file', file);
  const res = await apiRequest(heading, '/api/uploads', { method: 'POST', body: form, signal });
  const data = (await res.json()) as { filePath?: unknown; url?: unknown };
  if (typeof data.filePath !== 'string' || !data.filePath || typeof data.url !== 'string' || !data.url) {
    throw new FailureNotice(heading, 'The upload sent back no image.');
  }
  return { filePath: data.filePath, previewUrl: backendAssetUrlSync(data.url) };
}
