import { v4 as uuidv4 } from 'uuid';
import { uploadReference } from './uploadReference';
import { useCinemaUploadStore, type CinemaReferenceUpload } from '../store/cinemaUploadStore';
import { useGraphStore } from '../store/graphStore';
import type { CinemaSceneSpec } from '../types';

// Files and request ownership last for this page only, never saved graph/history/storage.
const files = new Map<string, File>();
const controllers = new Map<string, AbortController>();

function hasTarget(nodeId: string, shotId?: string) {
  const node = useGraphStore.getState().nodes.find((candidate) => candidate.id === nodeId
    && candidate.data.definitionId === 'cinema-scene');
  if (!node) return false;
  return !shotId || (node.data.params.scene as CinemaSceneSpec | undefined)?.shots?.some((shot) => shot.id === shotId);
}

function owns(upload: CinemaReferenceUpload) {
  return useCinemaUploadStore.getState().uploads.some((item) => item.id === upload.id
    && item.attempt === upload.attempt && item.status === 'uploading') && hasTarget(upload.nodeId, upload.shotId);
}

async function finish(upload: CinemaReferenceUpload) {
  const file = files.get(upload.id);
  if (!file) return;
  const controller = new AbortController();
  controllers.set(upload.attempt, controller);
  try {
    const reference = await uploadReference(file, controller.signal);
    if (!owns(upload)) return;
    // Retain the existing backend-relative URL recipe format, independent of preview origin.
    const url = /^https?:\/\//.test(reference.previewUrl)
      ? new URL(reference.previewUrl).pathname : reference.previewUrl;
    useGraphStore.getState().updateScene(upload.nodeId, (current) => {
      if (!owns(upload)) return null;
      if (upload.shotId) {
        return { ...current, shots: current.shots.map((shot) => shot.id === upload.shotId
          ? { ...shot, refImageUrls: [...new Set([...(shot.refImageUrls ?? []), url])] } : shot) };
      }
      return { ...current, character: { ...current.character, strength: current.character?.strength ?? 0.75,
        refImageUrls: [...new Set([...(current.character?.refImageUrls ?? []), url])] } };
    });
    removeCinemaReferenceUpload(upload.id);
  } catch (error) {
    if (!owns(upload)) return;
    useCinemaUploadStore.getState().setUploads((uploads) => uploads.map((item) => item.id === upload.id
      ? { ...item, status: 'error', error: error instanceof Error ? error.message : 'Could not upload this image. Please try again.' }
      : item));
  } finally { controllers.delete(upload.attempt); }
}

/** Reserve all file chips synchronously before the first POST or Generate check. */
export function attachCinemaReferences(nodeId: string, shotId: string | undefined, selected: FileList | readonly File[]) {
  if (useGraphStore.getState().isImportingGraph || !hasTarget(nodeId, shotId)) return;
  const uploads = Array.from(selected).map((file): CinemaReferenceUpload => {
    const upload = { id: uuidv4(), attempt: uuidv4(), nodeId, shotId, name: file.name,
      status: 'uploading' as const, canRetry: true };
    files.set(upload.id, file);
    return upload;
  });
  useCinemaUploadStore.getState().setUploads((current) => [...current, ...uploads]);
  for (const upload of uploads) void finish(upload);
}

export function retryCinemaReferenceUpload(id: string) {
  const upload = useCinemaUploadStore.getState().uploads.find((item) => item.id === id);
  if (!upload || upload.status !== 'error' || !upload.canRetry || !files.has(id)
    || useGraphStore.getState().isImportingGraph || !hasTarget(upload.nodeId, upload.shotId)) return;
  const next = { ...upload, attempt: uuidv4(), status: 'uploading' as const, error: undefined };
  useCinemaUploadStore.getState().setUploads((current) => current.map((item) => item.id === id ? next : item));
  void finish(next);
}

export function removeCinemaReferenceUpload(id: string) {
  useCinemaUploadStore.getState().setUploads((uploads) => uploads.filter((item) => item.id !== id));
}

// Target deletion, graph replacement and explicit removal share the same cleanup.
useCinemaUploadStore.subscribe((state, previous) => {
  for (const upload of previous.uploads) {
    if (state.uploads.some((item) => item.id === upload.id && item.attempt === upload.attempt)) continue;
    controllers.get(upload.attempt)?.abort();
    controllers.delete(upload.attempt);
    if (!state.uploads.some((item) => item.id === upload.id)) files.delete(upload.id);
  }
});
