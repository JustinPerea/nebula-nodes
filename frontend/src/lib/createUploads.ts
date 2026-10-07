import { apiFetch, backendAssetUrlSync } from './backend';
import { v4 as uuidv4 } from 'uuid';
import { useCreateDraftStore } from '../store/createDraftStore';

export interface UploadedReference {
  filePath: string;   // absolute on-disk path — safe to feed image-input
  previewUrl: string; // served /api/outputs URL for display
}

const MAX_REFERENCE_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
// Transient files/controllers never enter browser storage or saved recipes.
const uploadFiles = new Map<string, File>();
const uploadControllers = new Map<string, AbortController>();

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

function fileKey(sessionId: string, id: string) { return `${sessionId}:${id}`; }

async function finishUpload(sessionId: string, id: string, attempt: string) {
  const key = fileKey(sessionId, id);
  const file = uploadFiles.get(key);
  if (!file) return;
  const controller = new AbortController();
  uploadControllers.set(attempt, controller);
  try {
    const uploaded = await uploadReference(file, controller.signal);
    useCreateDraftStore.getState().updateDraft(sessionId, (draft) => {
      if (!draft.uploads.some((upload) => upload.id === id && upload.attempt === attempt && upload.status === 'uploading')) return {};
      return {
        uploads: draft.uploads.filter((upload) => upload.id !== id),
        refs: draft.refs.some((ref) => ref.filePath === uploaded.filePath) ? draft.refs : [...draft.refs, uploaded],
      };
    });
    const current = useCreateDraftStore.getState().drafts[sessionId];
    if (!current?.uploads.some((upload) => upload.id === id)) uploadFiles.delete(key);
  } catch (error) {
    useCreateDraftStore.getState().updateDraft(sessionId, (draft) => {
      if (!draft.uploads.some((upload) => upload.id === id && upload.attempt === attempt && upload.status === 'uploading')) return {};
      return { uploads: draft.uploads.map((upload) => upload.id === id
        ? { ...upload, status: 'error', error: error instanceof Error ? error.message : 'Could not upload this image. Please try again.' }
        : upload) };
    });
  } finally {
    uploadControllers.delete(attempt);
  }
}

/** Author all pending chips before starting requests, closing attach→Generate races. */
export function attachCreateReferences(sessionId: string, files: FileList | readonly File[]) {
  if (!useCreateDraftStore.getState().drafts[sessionId]) return;
  const uploads = Array.from(files).map((file) => {
    const upload = { id: uuidv4(), name: file.name, attempt: uuidv4(), status: 'uploading' as const };
    uploadFiles.set(fileKey(sessionId, upload.id), file);
    return upload;
  });
  useCreateDraftStore.getState().updateDraft(sessionId, (draft) => ({ uploads: [...draft.uploads, ...uploads] }));
  for (const upload of uploads) void finishUpload(sessionId, upload.id, upload.attempt);
}

export function canRetryCreateReference(sessionId: string, id: string) {
  return uploadFiles.has(fileKey(sessionId, id));
}

export function retryCreateReference(sessionId: string, id: string, replacement?: File) {
  const upload = useCreateDraftStore.getState().drafts[sessionId]?.uploads.find((item) => item.id === id);
  if (!upload || upload.status !== 'error') return;
  const key = fileKey(sessionId, id);
  if (replacement) uploadFiles.set(key, replacement);
  const file = uploadFiles.get(key);
  if (!file) return;
  const attempt = uuidv4();
  useCreateDraftStore.getState().updateDraft(sessionId, (draft) => ({ uploads: draft.uploads.map((item) => item.id === id
    ? { id, name: file.name, attempt, status: 'uploading' }
    : item) }));
  uploadControllers.get(upload.attempt)?.abort();
  void finishUpload(sessionId, id, attempt);
}

export function removeCreateReferenceUpload(sessionId: string, id: string) {
  const upload = useCreateDraftStore.getState().drafts[sessionId]?.uploads.find((item) => item.id === id);
  useCreateDraftStore.getState().updateDraft(sessionId, (draft) => ({ uploads: draft.uploads.filter((item) => item.id !== id) }));
  uploadFiles.delete(fileKey(sessionId, id));
  if (upload) uploadControllers.get(upload.attempt)?.abort();
}

export function clearCreateReferenceUploads(sessionId: string) {
  for (const upload of useCreateDraftStore.getState().drafts[sessionId]?.uploads ?? []) {
    removeCreateReferenceUpload(sessionId, upload.id);
  }
}
