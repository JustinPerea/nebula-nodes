import { apiFetch } from './backend';
import type {
  AssetDetail, Collection, CommonsStatus, FilterState, FolderLink, Region, Role, SearchRow,
} from './commonsTypes';

let session: Promise<string> | null = null;

export function resetCommonsSessionForTests(): void {
  session = null;
}

const SESSION_MESSAGE = 'no UI session: use a fresh Commons dev link from the backend terminal';

async function resolveToken(): Promise<string> {
  const desktop = await window.nebulaDesktop?.commons?.uiToken();
  if (desktop) return desktop;
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const fromLink = hash.get('commons-token');
  if (fromLink) {
    window.sessionStorage.setItem('nebula.commons.token', fromLink);
    hash.delete('commons-token');
    const remaining = hash.toString();
    window.history.replaceState(window.history.state, '',
      window.location.pathname + window.location.search + (remaining ? `#${remaining}` : ''));
    return fromLink;
  }
  const stored = window.sessionStorage.getItem('nebula.commons.token');
  if (stored) return stored;
  throw new Error(SESSION_MESSAGE);
}

export async function resolveCommonsToken(): Promise<string> {
  // A fresh terminal link supersedes a cached expired backend session.
  if (new URLSearchParams(window.location.hash.slice(1)).has('commons-token')) session = null;
  if (!session) {
    session = resolveToken();
    session.catch(() => { session = null; });
  }
  return session;
}

async function send(path: string, init: RequestInit): Promise<Response> {
  const headers: Record<string, string> = { Authorization: `Bearer ${await resolveCommonsToken()}` };
  if (init.body && !(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  return apiFetch(`/api/commons${path}`, { ...init, headers: { ...headers, ...(init.headers as object) } });
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response = await send(path, init);
  if (response.status === 401) {
    // The UI session lives in backend memory; a backend restart forgets it. Re-resolve authority once.
    session = null;
    response = await send(path, init);
  }
  if (response.status === 401) {
    // Stop browser polling from repeatedly sending a token forgotten by a
    // restarted backend. A new terminal link restores explicit authority.
    session = null;
    window.sessionStorage.removeItem('nebula.commons.token');
    throw new Error(SESSION_MESSAGE);
  }
  if (!response.ok) {
    let detail = `Commons request failed (${response.status})`;
    try { detail = (await response.json()).detail ?? detail; } catch { /* keep default */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  const type = response.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? response.json() : response.blob()) as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  call<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) => call<T>(path, { method: 'PATCH', body: JSON.stringify(body) });


export type UrlAddResult =
  | { kind: 'asset'; asset_id: string }
  | { kind: 'page'; page_url: string; page_title: string | null;
    candidates: { url: string; width: number | null; height: number | null }[] };

export const commonsApi = {
  blob: (path: string, signal?: AbortSignal) => {
    if (!path.startsWith('/api/commons/blobs/')) throw new Error('Invalid Commons blob path');
    return call<Blob>(path.slice('/api/commons'.length), { signal });
  },
  status: () => call<CommonsStatus>('/status'),
  collections: () => call<Collection[]>('/collections'),
  createCollection: (name: string, brand?: string | null) => post<Collection>('/collections', { name, brand: brand || null }),
  patchCollection: (id: string, body: { name?: string; brand?: string | null }) => patch<Collection>(`/collections/${id}`, body),
  search: (body: { query: string; filters: Record<string, unknown>; all_scopes?: boolean; limit?: number }) =>
    post<{ results: SearchRow[] }>('/search', { limit: 20, ...body }),
  asset: (id: string) => call<AssetDetail>(`/assets/${id}`),
  uploadFiles: (collectionId: string, files: File[], why?: string, role: Role = 'neutral') => {
    const form = new FormData();
    form.append('collection_id', collectionId);
    form.append('role', role);
    if (why) form.append('why', why);
    files.forEach((f) => form.append('files', f));
    return call<{ results: { filename: string; ok: boolean; asset_id?: string; error?: string }[] }>(
      '/intake/files', { method: 'POST', body: form });
  },
  addUrl: (body: { url: string; collection_id: string; why?: string; page_url?: string; page_title?: string }) =>
    post<UrlAddResult>('/intake/url', body),
  importMoodboards: () => post<{ collections: number; added: number; skipped: { url: string; reason: string }[] }>('/intake/moodboards'),
  folders: () => call<FolderLink[]>('/folders'),
  linkFolder: (path: string, ignores?: string[]) => post<FolderLink>('/folders', { path, ignores }),
  setIgnores: (id: string, ignores: string[]) => patch<FolderLink>(`/folders/${id}`, { ignores }),
  rescan: (id: string) => post<{ status: string }>(`/folders/${id}/rescan`),
  patchMembership: (id: string, body: { role?: Role; why?: string }) => patch(`/memberships/${id}`, body),
  accept: (id: string) => post(`/memberships/${id}/accept`),
  correct: (assetId: string, body: { field_path: string; op: 'set' | 'add' | 'remove'; value: unknown; reason?: string }) =>
    post(`/assets/${assetId}/corrections`, body),
  addRegion: (assetId: string, box: Region['box'], label: string) => post<Region>(`/assets/${assetId}/regions`, { box, label }),
  patchRegion: (id: string, body: Partial<Pick<Region, 'label' | 'note' | 'status' | 'box'>>) => patch<Region>(`/regions/${id}`, body),
  reanalyze: (assetId: string) => post(`/assets/${assetId}/reanalyze`),
  reanalyzeStale: (collectionId?: string) => post<{ queued: number }>('/reanalyze-stale', { collection_id: collectionId ?? null }),
  purge: (assetId: string) => call(`/assets/${assetId}`, { method: 'DELETE' }),
  comment: (assetId: string, text: string, membershipId?: string, regionId?: string) =>
    post('/comments', { asset_id: assetId, text, membership_id: membershipId, region_id: regionId }),
  settings: () => call<Record<string, unknown>>('/settings'),
  patchSettings: (body: Record<string, unknown>) => patch<Record<string, unknown>>('/settings', body),
  candidates: () => call<{ term: string; count: number; assets: string[] }[]>('/vocabulary/candidates'),
  workerStart: () => post('/worker/start'),
  workerStop: () => post('/worker/stop'),
  exportZip: () => call<Blob>('/export'),
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
  get: () => call<import('./commonsEvaluationTypes').EvaluationBatch | null>('/evaluation'),
  prepare: (path: string) => post<import('./commonsEvaluationTypes').EvaluationBatch>('/evaluation/prepare', { path }),
  image: (position: number, signal?: AbortSignal) => call<Blob>(`/evaluation/items/${position}/image`, { signal }),
  accents: (position: number, revision: number, points: import('./commonsEvaluationTypes').AccentPoint[], no_accents: boolean) =>
    post<import('./commonsEvaluationTypes').EvaluationBatch>(`/evaluation/items/${position}/accents`, { revision, points, no_accents }),
  labels: (position: number, revision: number, labels: import('./commonsEvaluationTypes').EvaluationLabels) =>
    call<import('./commonsEvaluationTypes').EvaluationBatch>(`/evaluation/items/${position}/labels`, {
      method: 'PUT', body: JSON.stringify({ revision, labels }),
    }),
  seal: (revision: number) => post<import('./commonsEvaluationTypes').EvaluationBatch>('/evaluation/seal', { revision }),
  /** Ends the batch as assisted review, never blind ground truth; the server requires the acknowledgement. */
  close: (revision: number) => post<import('./commonsEvaluationTypes').EvaluationBatch>('/evaluation/close', { revision, acknowledge_not_blind: true }),
};

export const commonsReviewApi = {
  get: () => call<import('./commonsReviewTypes').ReviewBatch | null>('/review'),
  propose: (position: number) => post<import('./commonsReviewTypes').ReviewBatch>(`/review/items/${position}/propose`, {}),
  accept: (position: number, revision: number, labels: import('./commonsEvaluationTypes').EvaluationLabels) =>
    call<import('./commonsReviewTypes').ReviewBatch>(`/review/items/${position}`, { method: 'PUT', body: JSON.stringify({ revision, labels }) }),
};
