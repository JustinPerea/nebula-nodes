/**
 * Files dropped from the desktop onto the canvas (fix/canvas-drop-files,
 * 2026-10-24). Every file in a drop is handled: one Nebula takes (images,
 * video, audio, PDF and text, what POST /api/uploads accepts) is uploaded
 * with create_node at the drop point, and the backend's graphSync draws the
 * Image, Video, Audio or Document Input there. Several files fan out from
 * the point in a small grid. A file Nebula can't take, and an upload that
 * fails, each get a written line in the canvas notice (graphStore.notify).
 *
 * Copy is GM - Design's (2026-10-24): one notice per drop. One failed file
 * gets "Couldn't add “{filename}”. Nebula takes images, video, audio, PDFs
 * and text files." or, for a failed upload, "Couldn't upload “{filename}”."
 * then the reason. Two or more get a count heading ("Couldn't add 2 of 5
 * files.", or "Couldn't add the 3 files." when none went in) over the shared
 * reason, or over "Not added: “a.zip”, “b.psd” and 1 more." when the reasons
 * differ. Files that went in get no notice of their own.
 */
import { apiRequest } from './apiRequest';
import { failureCopy, failureMessage } from './errorCopy';
import { useGraphStore } from '../store/graphStore';

export const DROP_TYPES_LINE = 'Nebula takes images, video, audio, PDFs and text files.';

/** Names a mixed-reason drop notice lists before "and {k} more." */
export const DROP_NOTICE_MAX_NAMES = 2;

/** A file name the way the canvas's labels quote one. */
export const quoted = (name: string) => `“${name}”`;

/** The fan-out grid: DROP_GRID_COLUMNS across, DROP_GRID_STEP_X apart (wider
 * than an input card's 240px). Rows stack by card height: an image or clip
 * card is its preview at full card width (height auto) under a 70px top pad
 * (slava-restraint.css), so a portrait photo's card runs ~500-600px; any
 * other card, and one whose size can't be read, counts as DROP_CARD_HEIGHT. */
export const DROP_GRID_COLUMNS = 3;
export const DROP_GRID_STEP_X = 300;
export const DROP_CARD_WIDTH = 240;
export const DROP_PREVIEW_PAD_TOP = 70;
export const DROP_CARD_HEIGHT = 380;
/** The file-name line under a picture or clip (`.model-node__file-name`:
 * 11px at 1.35 plus 6px below). */
export const DROP_NAME_LINE = 22;
export const DROP_ROW_GAP = 40;
/** How long a dropped image or clip gets to give its size before it counts
 * as a plain card. */
export const DROP_SIZE_TIMEOUT_MS = 1500;

/** How long after a drop's last upload settles the canvas still skips its
 * fit-to-new-nodes (the graphSync for the upload can land just after). */
export const DROP_FIT_GRACE_MS = 1000;

export type DropKind = 'image' | 'video' | 'audio' | 'document';

// The backend's lists (main.py: _sniff_image_type, _sniff_video_type,
// _sniff_audio_type, _DOC_TEXT_EXTS). The backend checks the bytes; this only
// decides which files are worth sending.
const EXTENSIONS: Record<string, DropKind> = {
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.mp4': 'video', '.mov': 'video', '.m4v': 'video', '.webm': 'video',
  '.wav': 'audio', '.mp3': 'audio', '.m4a': 'audio', '.aac': 'audio', '.flac': 'audio',
  '.ogg': 'audio', '.oga': 'audio', '.opus': 'audio',
  '.pdf': 'document', '.txt': 'document', '.md': 'document', '.markdown': 'document',
  '.csv': 'document', '.json': 'document', '.log': 'document', '.rst': 'document', '.tsv': 'document',
};

const MIME_TYPES: Record<string, DropKind> = {
  'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video',
  'audio/wav': 'audio', 'audio/x-wav': 'audio', 'audio/wave': 'audio', 'audio/mpeg': 'audio',
  'audio/mp4': 'audio', 'audio/x-m4a': 'audio', 'audio/aac': 'audio', 'audio/flac': 'audio',
  'audio/ogg': 'audio', 'application/pdf': 'document',
};

/** What a dropped file becomes, or null for one Nebula can't take. A known
 * extension decides; a name without one falls back to the browser's type. */
export function dropKind(file: Pick<File, 'name' | 'type'>): DropKind | null {
  const dot = file.name.lastIndexOf('.');
  if (dot > 0) return EXTENSIONS[file.name.slice(dot).toLowerCase()] ?? null;
  return MIME_TYPES[file.type.toLowerCase()] ?? null;
}

export type MediaSize = { width: number; height: number };

/** How tall a dropped file's card will be: an image or clip by its shape at
 * the card's width, never under a plain card. */
export function dropCardHeight(size: MediaSize | null): number {
  if (!size || !(size.width > 0) || !(size.height > 0)) return DROP_CARD_HEIGHT;
  return Math.max(DROP_CARD_HEIGHT, Math.ceil(DROP_PREVIEW_PAD_TOP + (DROP_CARD_WIDTH * size.height) / size.width + DROP_NAME_LINE));
}

/** Where each accepted file of a drop goes, given its card's height: the drop
 * point, then DROP_GRID_COLUMNS across, each row below the tallest card of
 * the row above it plus DROP_ROW_GAP. */
export function dropSpots(origin: { x: number; y: number }, heights: readonly number[]): { x: number; y: number }[] {
  const spots: { x: number; y: number }[] = [];
  let rowY = origin.y;
  for (let start = 0; start < heights.length; start += DROP_GRID_COLUMNS) {
    const row = heights.slice(start, start + DROP_GRID_COLUMNS);
    row.forEach((_, column) => spots.push({ x: origin.x + column * DROP_GRID_STEP_X, y: rowY }));
    rowY += Math.max(...row) + DROP_ROW_GAP;
  }
  return spots;
}

/** A dropped image's or clip's pixel size, read in the browser before it is
 * sent, or null (another kind, an unreadable file, or no answer in time). */
export function readMediaSize(file: File, kind: DropKind): Promise<MediaSize | null> {
  if ((kind !== 'image' && kind !== 'video') || typeof URL.createObjectURL !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (size: MediaSize | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(size);
    };
    const timer = window.setTimeout(() => finish(null), DROP_SIZE_TIMEOUT_MS);
    if (kind === 'image') {
      const image = new Image();
      image.onload = () => finish({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => finish(null);
      image.src = url;
    } else {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => finish({ width: video.videoWidth, height: video.videoHeight });
      video.onerror = () => finish(null);
      video.src = url;
    }
  });
}

export type DropFailure =
  | { kind: 'unsupported'; name: string }
  | { kind: 'upload'; name: string; line: string; reason: string };

/** The notice for a drop's failed files out of `total` dropped, or null
 * when none failed. */
export function dropNoticeText(failures: readonly DropFailure[], total: number): string | null {
  if (failures.length === 0) return null;
  const reasonOf = (failure: DropFailure) => (failure.kind === 'upload' ? failure.reason : DROP_TYPES_LINE);
  if (failures.length === 1) {
    const [failure] = failures;
    return failure.kind === 'upload' ? failure.line : `Couldn't add ${quoted(failure.name)}. ${DROP_TYPES_LINE}`;
  }
  const heading = failures.length >= total
    ? `Couldn't add the ${failures.length} files.`
    : `Couldn't add ${failures.length} of ${total} files.`;
  const reasons = new Set(failures.map(reasonOf));
  if (reasons.size === 1) return `${heading}\n${reasonOf(failures[0])}`;
  const names = failures.slice(0, DROP_NOTICE_MAX_NAMES).map((failure) => quoted(failure.name)).join(', ');
  const more = failures.length - DROP_NOTICE_MAX_NAMES;
  return `${heading}\nNot added: ${names}${more > 0 ? ` and ${more} more` : ''}.`;
}

let dropsInFlight = 0;

/** Whether a drop's uploads are on their way: the canvas then doesn't fit
 * the camera to the nodes they add, which land where the person dropped them. */
export function fileDropInFlight(): boolean {
  return dropsInFlight > 0;
}

/** Upload a drop's files at `origin` (flow coordinates). One undo step per
 * accepted file, given back if its upload fails. Resolves when every upload
 * has settled. */
export async function addDroppedFiles(files: readonly File[], origin: { x: number; y: number }): Promise<void> {
  // Failures by their place in the drop, so the notice names files in the
  // order they were dropped.
  const failed = new Map<number, DropFailure>();
  const accepted: { file: File; kind: DropKind; at: number }[] = [];
  files.forEach((file, at) => {
    const kind = dropKind(file);
    if (kind) accepted.push({ file, kind, at });
    else failed.set(at, { kind: 'unsupported', name: file.name });
  });
  const inOrder = () => [...failed.entries()].sort(([a], [b]) => a - b).map(([, failure]) => failure);
  const notify = (text: string | null) => { if (text) useGraphStore.getState().notify(text, 'error'); };
  // One notice per drop (GM): with nothing to upload it can say so now;
  // otherwise it waits for the uploads, so one notice names every failure.
  if (accepted.length === 0) { notify(dropNoticeText(inOrder(), files.length)); return; }

  dropsInFlight += 1;
  // Each card's height first, so a portrait photo's row pushes the next down.
  const sizes = await Promise.all(accepted.map(({ file, kind }) => readMediaSize(file, kind)));
  const spots = dropSpots(origin, sizes.map(dropCardHeight));
  await Promise.all(accepted.map(async ({ file, at }, index) => {
    const spot = spots[index];
    const form = new FormData();
    form.append('file', file);
    form.append('create_node', 'true');
    form.append('x', String(spot.x));
    form.append('y', String(spot.y));
    // One undo step per dropped file, taken before its graphSync lands.
    const undoStep = useGraphStore.getState().beginUndoStep();
    const heading = `Couldn't upload ${quoted(file.name)}.`;
    // The node the upload adds, which comes with its echo (review 11, L-2).
    let arrives: string[] = [];
    try {
      const response = await apiRequest(heading, '/api/uploads', { method: 'POST', body: form });
      const body = await response.json().catch(() => null) as { nodeId?: unknown } | null;
      if (typeof body?.nodeId === 'string') arrives = [body.nodeId];
    } catch (error) {
      useGraphStore.getState().cancelUndoStep(undoStep);
      failed.set(at, { kind: 'upload', name: file.name, line: failureMessage(error, heading),
        reason: failureCopy(error, { heading }).reason });
    } finally {
      // An undo pressed while the upload was on its way acts once its node is
      // on the canvas (review 10, L-2; review 11, L-2).
      useGraphStore.getState().endUndoStep(undoStep, { arrives });
    }
  }));
  window.setTimeout(() => { dropsInFlight = Math.max(0, dropsInFlight - 1); }, DROP_FIT_GRACE_MS);
  notify(dropNoticeText(inOrder(), files.length));
}
