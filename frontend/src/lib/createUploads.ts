import { apiFetch, backendAssetUrlSync } from './backend';

export interface UploadedReference {
  filePath: string;   // absolute on-disk path — safe to feed image-input
  previewUrl: string; // served /api/outputs URL for display
}

export async function uploadReference(file: File): Promise<UploadedReference> {
  const form = new FormData();
  form.append('file', file);
  const res = await apiFetch('/api/uploads', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = (await res.json()) as { filePath: string; url: string };
  return { filePath: data.filePath, previewUrl: backendAssetUrlSync(data.url) };
}
