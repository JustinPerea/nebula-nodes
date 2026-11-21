import { v4 as uuidv4 } from 'uuid';
import { uploadReference } from './uploadReference';
import { FailureNotice, NOT_ANSWERING_RETRY_CLAUSE, RequestFailedError, actionFailedLine } from './errorCopy';
import { quoted } from './quoted';
import { shownFileName } from './fileName';
import { useCinemaUploadStore, type CinemaReferenceUpload } from '../store/cinemaUploadStore';
import { useGraphStore } from '../store/graphStore';
import type { CinemaSceneSpec } from '../types';

// Files and request ownership last for this page only, never saved graph/history/storage.
const files = new Map<string, File>();
const controllers = new Map<string, AbortController>();

/** uploadReference's own reasons for a file it turned away before sending (lib/uploadReference.ts). */
const OVER_LIMIT_REASON = 'Image exceeds the 20 MB limit.';
const WRONG_TYPE_REASON = 'Use a PNG, JPEG, GIF or WebP image.';
const NO_IMAGE_REASON = 'The upload sent back no image.';

/**
 * A failed upload's line for the Cinema row, in the because form with Nebula
 * the subject ("Nebula couldn’t upload “photo.png” because the server isn’t
 * answering. Try again."). The status reasons come from errorCopy's own clauses
 * (actionFailedLine), so a status reads here as it does everywhere else. The
 * row's Try again sits beside the line, so the line ends in "Try again." (the
 * standing rule); a reason where trying again cannot help (a file over the size
 * limit, a wrong type, a file the server rejects, a refusal because you're
 * signed out) names the fix instead, ends without it, and the row offers no
 * Try again (`retryable` false).
 */
export function uploadFailure(name: string, error: unknown): { line: string; retryable: boolean } {
  const lead = `Nebula couldn’t upload ${quoted(shownFileName(name))} because`;
  const turnedAway = error instanceof FailureNotice ? error.reason : '';
  if (turnedAway === OVER_LIMIT_REASON || (error instanceof RequestFailedError && error.status === 413)) {
    return { line: `${lead} it’s over the 20 MB limit. Choose a smaller image.`, retryable: false };
  }
  if (turnedAway === WRONG_TYPE_REASON) {
    return { line: `${lead} it isn’t a PNG, JPEG, GIF or WebP image. Choose one of those.`, retryable: false };
  }
  if (turnedAway === NO_IMAGE_REASON) return { line: `${lead} the server sent back no image. Try again.`, retryable: true };
  const status = error instanceof RequestFailedError ? error.status : null;
  // A file the server rejects needs another file (400, 415 and 422), and any other refusal says it didn’t
  // accept the file; neither has a Try again, because trying the same file again cannot help.
  if (status === 400 || status === 415 || status === 422) {
    return { line: `${lead} the server couldn’t read it as an image. Choose another image.`, retryable: false };
  }
  const refused = (status !== null && status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status))
    || (status === null && error instanceof FailureNotice);
  if (refused) return { line: `${lead} the server didn’t accept it.`, retryable: false };
  // Everything else (no answer, a timeout, 429, a server error, signed out) reads as it does everywhere
  // else in the app: errorCopy's clauses for a line beside a button (actionFailedLine), so a given status
  // never has a row-specific wording here.
  const failed = actionFailedLine(`upload ${quoted(shownFileName(name))}`, error, `${lead} ${NOT_ANSWERING_RETRY_CLAUSE}`);
  return failed;
}

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
      // The line names the file and the reason, and ends as its buttons do (uploadFailure).
      ? { ...item, status: 'error', ...(() => { const failure = uploadFailure(upload.name, error); return { error: failure.line, canRetry: failure.retryable }; })() }
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
  // A Try again is a new attempt: a stop by an import is behind it (design PR #205).
  const next = { ...upload, attempt: uuidv4(), status: 'uploading' as const, error: undefined, stopped: undefined };
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
