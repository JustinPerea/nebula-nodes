import { apiFetch, backendAssetUrlSync } from './backend';

export interface UploadedReference {
  filePath: string;   // absolute on-disk path — safe to feed image-input
  previewUrl: string; // served /api/outputs URL for display
}

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export async function uploadReference(file: File, signal?: AbortSignal): Promise<UploadedReference> {
  if (file.size > MAX_REFERENCE_BYTES) throw new Error('Image exceeds the 20 MB limit.');
  const type = file.type.toLowerCase();
  if (!IMAGE_TYPES.has(type)
    && !((!type || type === 'application/octet-stream') && /\.(png|jpe?g|gif|webp)$/i.test(file.name))) {
    throw new Error('Use a PNG, JPEG, GIF or WebP image.');
  }
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch('/api/uploads', { method: 'POST', body: form, signal });
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === 'string' ? body.detail : `Upload failed (${res.status}). Please try again.`);
  }
  const data = (await res.json()) as { filePath?: unknown; url?: unknown };
  if (typeof data.filePath !== 'string' || !data.filePath || typeof data.url !== 'string' || !data.url) {
    throw new Error('The upload returned no image reference. Please try again.');
  }
  return { filePath: data.filePath, previewUrl: backendAssetUrlSync(data.url) };
}
