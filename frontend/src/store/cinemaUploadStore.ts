import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { CinemaSceneSpec } from '../types';

export const CINEMA_UPLOAD_STORAGE_KEY = 'nebula:cinema:uploads:v1';
export const INTERRUPTED_CINEMA_UPLOAD_MESSAGE = 'Upload was interrupted. Remove it, then attach the image again.';

export interface CinemaReferenceUpload {
  id: string;
  attempt: string;
  nodeId: string;
  shotId?: string;
  name: string;
  status: 'uploading' | 'error';
  error?: string;
  canRetry: boolean;
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
      interrupt: () => save(get().uploads.map((upload) => upload.status === 'uploading'
        ? { ...upload, attempt: uuidv4(), status: 'error', error: 'Upload stopped because a graph import started. Retry or remove it.' }
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

/** Shared references affect every shot; composition references affect their owner. */
export function getCinemaUploadIssue(nodeId: string, shotId?: string, includeAllShots = false): string | null {
  const uploads = useCinemaUploadStore.getState().uploads.filter((upload) => upload.nodeId === nodeId
    && (includeAllShots || !upload.shotId || upload.shotId === shotId));
  if (uploads.some((upload) => upload.status === 'uploading')) return 'Wait for reference uploads to finish before generating.';
  if (uploads.length) return 'Retry or remove failed reference uploads before generating.';
  return null;
}
