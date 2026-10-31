import { quotedNames } from '../lib/errorCopy';
import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { CinemaSceneSpec } from '../types';

export const CINEMA_UPLOAD_STORAGE_KEY = 'nebula:cinema:uploads:v1';
export const INTERRUPTED_CINEMA_UPLOAD_MESSAGE = 'Upload was interrupted. Remove it, then attach the image again.';
/** A canvas import stopped it (GM PR #205 r13 item 3). */
export const STOPPED_CINEMA_UPLOAD_MESSAGE = 'The upload stopped because a canvas import started.';
/** A stopped upload after a reload (GM PR #205 r15 item 2): its file is gone
 * and Try again with it, so the import reason leads nowhere; it reads as the
 * other reloaded rows do. */
export const RELOADED_STOPPED_CINEMA_UPLOAD_MESSAGE = 'Remove it, then attach the image again.';

export interface CinemaReferenceUpload {
  id: string;
  attempt: string;
  nodeId: string;
  shotId?: string;
  name: string;
  status: 'uploading' | 'error';
  error?: string;
  canRetry: boolean;
  /** Stopped by a canvas import (GM PR #205 r14 item 4): nothing broke and
   * nothing was lost, and its Try again and Remove say what to do, so its
   * reason reads neutral, never as a problem. Not kept across a reload (the
   * file is gone then, and the row is a problem to fix). */
  stopped?: boolean;
}

type UploadStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface CinemaUploadState {
  uploads: CinemaReferenceUpload[];
  setUploads: (change: (current: CinemaReferenceUpload[]) => CinemaReferenceUpload[]) => void;
  clear: () => void;
  interrupt: () => void;
  reconcileTargets: (nodes: { id: string; data: { definitionId: string; params: Record<string, unknown> } }[], knownTargets?: Set<string>) => void;
}

function browserStorage(): UploadStorage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; }
  catch { return null; }
}

function load(storage: UploadStorage | null): CinemaReferenceUpload[] {
  try {
    const raw = storage?.getItem(CINEMA_UPLOAD_STORAGE_KEY);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1
      || !('uploads' in data) || !Array.isArray(data.uploads)) return [];
    return data.uploads.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const value = item as Record<string, unknown>;
      if (!['id', 'attempt', 'nodeId', 'name'].every((key) => typeof value[key] === 'string' && value[key])
        || (value.shotId !== undefined && typeof value.shotId !== 'string')
        || !['uploading', 'error'].includes(String(value.status))) return [];
      return [{ id: value.id as string, attempt: value.attempt as string, nodeId: value.nodeId as string,
        name: value.name as string, ...(value.shotId !== undefined ? { shotId: value.shotId as string } : {}),
        status: 'error' as const, canRetry: false,
        error: value.status === 'uploading' ? INTERRUPTED_CINEMA_UPLOAD_MESSAGE
          : value.error === STOPPED_CINEMA_UPLOAD_MESSAGE ? RELOADED_STOPPED_CINEMA_UPLOAD_MESSAGE
            : typeof value.error === 'string' ? value.error : 'Remove this upload, then attach the image again.' }];
    });
  } catch { return []; }
}

/** Authoring metadata only: never put pending files into the graph or a run recipe. */
export function createCinemaUploadStore(storage: UploadStorage | null = browserStorage()) {
  return create<CinemaUploadState>((set, get) => {
    const save = (uploads: CinemaReferenceUpload[]) => {
      if (uploads === get().uploads) return;
      set({ uploads });
      try {
        storage?.setItem(CINEMA_UPLOAD_STORAGE_KEY, JSON.stringify({ version: 1,
          uploads: uploads.map(({ id, attempt, nodeId, shotId, name, status, error }) =>
            ({ id, attempt, nodeId, shotId, name, status, error })) }));
      } catch { /* Keep the working state when browser storage is unavailable. */ }
    };
    return {
      uploads: load(storage),
      setUploads: (change) => save(change(get().uploads)),
      clear: () => save([]),
      // GM PR #205 r13 item 3: the row's Try again and Remove are the next
      // step, so the line doesn't repeat them.
      interrupt: () => save(get().uploads.map((upload) => upload.status === 'uploading'
        ? { ...upload, attempt: uuidv4(), status: 'error', error: STOPPED_CINEMA_UPLOAD_MESSAGE, stopped: true }
        : upload)),
      reconcileTargets: (nodes, knownTargets) => {
        const targets = new Map(nodes.filter((node) => node.data.definitionId === 'cinema-scene')
          .map((node) => [node.id, node.data.params.scene as CinemaSceneSpec | undefined]));
        const uploads = get().uploads;
        const remaining = uploads.filter((upload) => (knownTargets && !knownTargets.has(upload.nodeId))
          || (targets.has(upload.nodeId)
            && (!upload.shotId || targets.get(upload.nodeId)?.shots?.some((shot) => shot.id === upload.shotId))));
        if (remaining.length !== uploads.length) save(remaining);
      },
    };
  });
}

export const useCinemaUploadStore = createCinemaUploadStore();

/** GM PR #205 r15 item 3: the lock reason for Generate all when another
 * shot's uploads hold it, naming those shots by the name-list rule ("“Shot
 * 2”", "“Shot 2” and “Shot 3”", from 4 "4 shots"): uploads on their way
 * first; otherwise the failed ones. Null when no other shot has any. */
export function otherShotsUploadLine(nodeId: string, shotId: string, shots: readonly { id: string }[]): string | null {
  const others = useCinemaUploadStore.getState().uploads.filter((upload) => upload.nodeId === nodeId
    && upload.shotId !== undefined && upload.shotId !== shotId);
  const pending = others.filter((upload) => upload.status === 'uploading');
  const named = pending.length > 0 ? pending : others;
  const numbers = [...new Set(named.map((upload) => shots.findIndex((shot) => shot.id === upload.shotId) + 1))]
    .filter((number) => number > 0).sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  const where = quotedNames(numbers.map((number) => `Shot ${number}`), 'shots');
  return pending.length > 0 ? `You can generate all when the uploads in ${where} finish.`
    : `You can generate all after you try the uploads in ${where} again or remove them.`;
}

/** How an upload row's reason reads (GM PR #205 r14 item 4): a failure the
 * person must fix is an alert in the warning colour; one that destroyed
 * nothing (a canvas import stopped it) and the row's progress are a status,
 * in the row's neutral ink. */
export function uploadReasonRole(upload: CinemaReferenceUpload): 'alert' | 'status' {
  return upload.status === 'error' && !upload.stopped ? 'alert' : 'status';
}

/** Shared references affect every shot; composition references affect their owner. */
export function getCinemaUploadIssue(nodeId: string, shotId?: string, includeAllShots = false): string | null {
  const uploads = useCinemaUploadStore.getState().uploads.filter((upload) => upload.nodeId === nodeId
    && (includeAllShots || !upload.shotId || upload.shotId === shotId));
  if (uploads.some((upload) => upload.status === 'uploading')) return 'Wait for reference uploads to finish before generating.';
  // GM PR #205 r14 item 3: a lock reason, in the lock form, naming the
  // uploads by the shared name-list rule (up to 3 by name, from 4 a count).
  if (uploads.length) {
    return `You can generate after you try ${quotedNames(uploads.map((upload) => upload.name), 'uploads')} again or remove ${uploads.length > 1 ? 'them' : 'it'}.`;
  }
  return null;
}
