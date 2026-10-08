import { v4 as uuidv4 } from 'uuid';
import { useCreateDraftStore } from '../store/createDraftStore';

import { uploadReference } from './uploadReference';
export { uploadReference, type UploadedReference } from './uploadReference';

// Transient files/controllers never enter browser storage or saved recipes.
const uploadFiles = new Map<string, File>();
const uploadControllers = new Map<string, AbortController>();

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
