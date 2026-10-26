import { apiFetch } from './backend';
import { CommonsRequestError } from './commonsRequestError';
import {
  CONNECTION_LOST_COPY, ConnectionLostError, NO_ANSWER_STATUS,
  REFUSED_FALLBACK_COPY, commonsSessionCopy, copyForStatus, isNoAnswer, readDetail, requestSucceeded,
  warnFailure, type FailureCopy,
} from './errorCopy';
import {
  forgetPersonCredential, inDesktopShell, personToken, refreshPersonCredential, resetPersonSessionForTests,
} from './personSession';
import type {
  AssetDetail, Collection, CommonsStatus, FilterState, FolderLink, Region, Role, SearchRow,
} from './commonsTypes';

let session: Promise<string> | null = null;

export function resetCommonsSessionForTests(): void {
  session = null;
  resetPersonSessionForTests();
}

/** No person session to send (GM, error-copy round 2): in a plain browser
 * tab only a fresh link from the backend terminal brings it back; in the
 * desktop app a reload fetches the shell's token again (the silent refetch
 * already ran). */
const sessionLost = (heading: string) => new CommonsRequestError(commonsSessionCopy(inDesktopShell()), 401, { heading });

// Commons' human is the person: the same per-launch token (personSession.ts).
async function resolveToken(): Promise<string> {
  const token = await personToken();
  if (token) return token;
  throw sessionLost('');
}

export async function resolveCommonsToken(): Promise<string> {
  // A fresh terminal link supersedes a cached expired backend session.
  const hash = new URLSearchParams(window.location.hash.slice(1));
  if (hash.has('nebula-person') || hash.has('commons-token')) session = null;
  if (!session) {
    session = resolveToken();
    session.catch(() => { session = null; });
  }
  return session;
}

/** No answer at all, as a Commons failure: status 0, the connection line. */
const lostConnection = (heading: string, cause: unknown) =>
  new CommonsRequestError(CONNECTION_LOST_COPY, NO_ANSWER_STATUS, { cause, heading });

async function send(heading: string, path: string, init: RequestInit): Promise<Response> {
  let token: string;
  try {
    token = await resolveCommonsToken();
  } catch (error) {
    // No session: say it under this call's heading.
    throw error instanceof CommonsRequestError ? sessionLost(heading) : error;
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  try {
    return await apiFetch(`/api/commons${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } });
  } catch (error) {
    // apiFetch says a lost connection in words; the caller's own abort passes.
    throw error instanceof ConnectionLostError ? lostConnection(heading, error) : error;
  }
}

/** One Commons request. `heading` names it the way the Commons does ("Couldn't
 * save your labels."): a failure says "<heading> <reason>" (GM, error-copy
 * round 2), and the leave popover shows the reason under its own heading. */
async function call<T>(heading: string, path: string, init: RequestInit = {}): Promise<T> {
  let response = await send(heading, path, init);
  if (response.status === 401) {
    // The person token lives in backend memory; a restarted backend has a new
    // one. Re-resolve authority once (a new link, or the desktop shell's token).
    session = null;
    refreshPersonCredential();
    response = await send(heading, path, init);
  }
  if (response.status === 401) {
    // Stop browser polling from repeatedly sending a token forgotten by a
    // restarted backend. A new terminal link restores explicit authority.
    session = null;
    forgetPersonCredential();
    warnFailure(heading, 401, 'no person session');
    throw sessionLost(heading);
  }
  if (!response.ok) {
    // Copy, never the status or a raw body (lib/errorCopy.ts): GM's line for
    // 408, 429 and 5xx, else the backend's written reason, else GM's line
    // for the status. `detail` keeps what it sent, for debugging and the
    // console (once per call until it works again).
    const detail = await readDetail(response);
    warnFailure(heading, response.status, detail);
    throw new CommonsRequestError(copyForStatus(response.status, detail), response.status, { detail, heading });
  }
  requestSucceeded(heading);
  const type = response.headers.get('content-type') ?? '';
  try {
    return await (type.includes('application/json') ? response.json() : response.blob()) as T;
  } catch (error) {
    // The connection dropped while the body was arriving: apiFetch's Response
    // classifies the read (a ConnectionLostError), so a used body or a bug is
    // not read as one (typeerror2, 2026-10-24).
    if (isNoAnswer(error, init.signal)) throw lostConnection(heading, error);
    throw error;
  }
}

const post = <T>(heading: string, path: string, body?: unknown) =>
  call<T>(heading, path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(heading: string, path: string, body: unknown) =>
  call<T>(heading, path, { method: 'PATCH', body: JSON.stringify(body) });

/** One file's result from an upload. `reason` is the backend's machine code
 * for a refused file (routes/commons.py intake_files); `error` is its raw
 * text, for agents and the console, never shown to the person. */
export interface UploadResult {
  filename: string;
  ok: boolean;
  asset_id?: string;
  /** The specific text, for agents and the console; never shown to the person. */
  error?: string;
  /** The refusal's machine code (too_large, unsupported_type, ...). */
  reason?: string;
  /** The person's line, written in backend/commons/person_copy.py (INTAKE). */
  person?: string;
}

/** A refused file as the person reads it (GM, round 2): "Couldn't upload
 * {filename}." with the backend's line for its reason below it, GM's 4xx
 * fallback when it sent none. Never the raw `error`. The lines live in one
 * table, backend/commons/person_copy.py, as every Commons refusal's do. */
export function uploadFailureCopy(result: UploadResult): FailureCopy {
  return {
    heading: `Couldn't upload ${result.filename || 'that file'}.`,
    reason: result.person?.trim() || REFUSED_FALLBACK_COPY,
  };
}


export type UrlAddResult =
  | { kind: 'asset'; asset_id: string }
  | { kind: 'page'; page_url: string; page_title: string | null;
    candidates: { url: string; width: number | null; height: number | null }[] };

export const commonsApi = {
  blob: (path: string, signal?: AbortSignal) => {
    if (!path.startsWith('/api/commons/blobs/')) throw new Error('Invalid Commons blob path');
    return call<Blob>("Couldn't load the reference.", path.slice('/api/commons'.length), { signal });
  },
  status: () => call<CommonsStatus>("Couldn't check the Commons status.", '/status'),
  collections: () => call<Collection[]>("Couldn't load the collections.", '/collections'),
  createCollection: (name: string, brand?: string | null) =>
    post<Collection>("Couldn't create the collection.", '/collections', { name, brand: brand || null }),
  patchCollection: (id: string, body: { name?: string; brand?: string | null }) =>
    patch<Collection>("Couldn't save the collection.", `/collections/${id}`, body),
  search: (body: { query: string; filters: Record<string, unknown>; all_scopes?: boolean; limit?: number }) =>
    post<{ results: SearchRow[] }>("Couldn't load the references.", '/search', { limit: 20, ...body }),
  asset: (id: string) => call<AssetDetail>("Couldn't load the reference.", `/assets/${id}`),
  uploadFiles: (collectionId: string, files: File[], why?: string, role: Role = 'neutral') => {
    const form = new FormData();
    form.append('collection_id', collectionId);
    form.append('role', role);
    if (why) form.append('why', why);
    files.forEach((f) => form.append('files', f));
    return call<{ results: UploadResult[] }>("Couldn't upload the files.", '/intake/files', { method: 'POST', body: form });
  },
  addUrl: (body: { url: string; collection_id: string; why?: string; page_url?: string; page_title?: string }) =>
    post<UrlAddResult>("Couldn't add that URL.", '/intake/url', body),
  importMoodboards: () => post<{ collections: number; added: number; skipped: { url: string; reason: string }[] }>(
    "Couldn't import the moodboards.", '/intake/moodboards'),
  folders: () => call<FolderLink[]>("Couldn't load the linked folders.", '/folders'),
  linkFolder: (path: string, ignores?: string[]) => post<FolderLink>("Couldn't link the folder.", '/folders', { path, ignores }),
  setIgnores: (id: string, ignores: string[]) => patch<FolderLink>("Couldn't save the ignore list.", `/folders/${id}`, { ignores }),
  rescan: (id: string) => post<{ status: string }>("Couldn't rescan the folder.", `/folders/${id}/rescan`),
  patchMembership: (id: string, body: { role?: Role; why?: string }) =>
    patch("Couldn't save the reference.", `/memberships/${id}`, body),
  accept: (id: string) => post("Couldn't accept the reference.", `/memberships/${id}/accept`),
  correct: (assetId: string, body: { field_path: string; op: 'set' | 'add' | 'remove'; value: unknown; reason?: string }) =>
    post("Couldn't save the correction.", `/assets/${assetId}/corrections`, body),
  addRegion: (assetId: string, box: Region['box'], label: string) =>
    post<Region>("Couldn't add the region.", `/assets/${assetId}/regions`, { box, label }),
  patchRegion: (id: string, body: Partial<Pick<Region, 'label' | 'note' | 'status' | 'box'>>) =>
    patch<Region>("Couldn't save the region.", `/regions/${id}`, body),
  reanalyze: (assetId: string) => post("Couldn't reanalyze the reference.", `/assets/${assetId}/reanalyze`),
  reanalyzeStale: (collectionId?: string) => post<{ queued: number }>(
    "Couldn't reanalyze the stale references.", '/reanalyze-stale', { collection_id: collectionId ?? null }),
  purge: (assetId: string) => call("Couldn't delete the reference.", `/assets/${assetId}`, { method: 'DELETE' }),
  comment: (assetId: string, text: string, membershipId?: string, regionId?: string) =>
    post("Couldn't post the comment.", '/comments', { asset_id: assetId, text, membership_id: membershipId, region_id: regionId }),
  settings: () => call<Record<string, unknown>>("Couldn't load the Commons settings.", '/settings'),
  patchSettings: (body: Record<string, unknown>) =>
    patch<Record<string, unknown>>("Couldn't save the Commons settings.", '/settings', body),
  candidates: () => call<{ term: string; count: number; assets: string[] }[]>(
    "Couldn't load the vocabulary candidates.", '/vocabulary/candidates'),
  workerStart: () => post("Couldn't start the worker.", '/worker/start'),
  workerStop: () => post("Couldn't stop the worker.", '/worker/stop'),
  exportZip: () => call<Blob>("Couldn't export the ZIP.", '/export'),
};

export function filtersToRequest(f: FilterState): { query: string; filters: Record<string, unknown> } {
  const filters: Record<string, unknown> = {};
  if (Object.keys(f.axes).length) filters.axes = f.axes;
  if (f.keywords.length) filters.keywords = f.keywords;
  if (/^#[0-9a-f]{6}$/i.test(f.paletteHex)) filters.palette_near = { hex: f.paletteHex, max_delta_e: f.paletteDeltaE };
  if (f.collection) filters.collection = f.collection;
  if (f.media) filters.media = f.media;
  if (f.role) filters.role = f.role;
  if (f.madeBy) filters.made_by = f.madeBy;
  if (f.correctedOnly) filters.corrected_only = true;
  if (f.hasComments) filters.has_comments = true;
  if (f.inbox) filters.inbox = true;
  return { query: f.query.trim(), filters };
}

export const commonsEvaluationApi = {
  get: () => call<import('./commonsEvaluationTypes').EvaluationBatch | null>("Couldn't load Blind labeling.", '/evaluation'),
  prepare: (path: string) => post<import('./commonsEvaluationTypes').EvaluationBatch>(
    "Couldn't prepare the held-out set.", '/evaluation/prepare', { path }),
  image: (position: number, signal?: AbortSignal) =>
    call<Blob>("Couldn't load the reference.", `/evaluation/items/${position}/image`, { signal }),
  accents: (position: number, revision: number, points: import('./commonsEvaluationTypes').AccentPoint[], no_accents: boolean) =>
    post<import('./commonsEvaluationTypes').EvaluationBatch>(
      "Couldn't save the accents.", `/evaluation/items/${position}/accents`, { revision, points, no_accents }),
  labels: (position: number, revision: number, labels: import('./commonsEvaluationTypes').EvaluationLabels) =>
    call<import('./commonsEvaluationTypes').EvaluationBatch>("Couldn't save your labels.", `/evaluation/items/${position}/labels`, {
      method: 'PUT', body: JSON.stringify({ revision, labels }),
    }),
  seal: (revision: number) => post<import('./commonsEvaluationTypes').EvaluationBatch>(
    "Couldn't seal the labels.", '/evaluation/seal', { revision }),
  /** Ends the batch as assisted review, never blind ground truth; the server requires the acknowledgement. */
  close: (revision: number) => post<import('./commonsEvaluationTypes').EvaluationBatch>(
    "Couldn't close the batch.", '/evaluation/close', { revision, acknowledge_not_blind: true }),
};

export const commonsReviewApi = {
  get: () => call<import('./commonsReviewTypes').ReviewBatch | null>("Couldn't load Agent review.", '/review'),
  propose: (position: number) => post<import('./commonsReviewTypes').ReviewBatch>(
    "Couldn't grade the reference.", `/review/items/${position}/propose`, {}),
  accept: (position: number, revision: number, labels: import('./commonsEvaluationTypes').EvaluationLabels) =>
    call<import('./commonsReviewTypes').ReviewBatch>("Couldn't save your corrections.", `/review/items/${position}`,
      { method: 'PUT', body: JSON.stringify({ revision, labels }) }),
};
