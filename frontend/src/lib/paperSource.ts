import { apiFetch, rewriteBackendAssetUrls } from './backend';

/** Paper owns editable objects. Nebula owns immutable exported snapshots. */
export interface PaperSourceIdentity {
  fileId: string;
  pageId: string;
  objectId: string;
  fileName: string;
  pageName: string;
  objectName: string;
  openUrl: string;
  navigation: 'file';
}

export interface PaperExportSettings {
  format: 'png';
  scale: '1x' | '2x';
  bounds: 'object';
  background: 'artwork';
}

export interface PaperSourceSnapshot {
  id: string;
  hash: string;
  capturedAt: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  hasTransparency: boolean;
  filePath: string;
  previewUrl: string;
  identity: PaperSourceIdentity;
  exportSettings: PaperExportSettings;
}

export interface PaperSourceRecord {
  id: string;
  identity: PaperSourceIdentity;
  exportSettings: PaperExportSettings;
  snapshot?: PaperSourceSnapshot;
  snapshots: PaperSourceSnapshot[];
  state: 'current' | 'unavailable' | 'missing';
  lastSuccessfulRefresh?: string;
  lastError?: string;
  sequence: number;
  changed?: boolean;
}

export interface PaperSelection {
  file: { id: string; name: string };
  pageId: string;
  pageName: string;
  selection: Array<{ id: string; name: string; width: number; height: number }>;
}

export interface PaperLinkRequest {
  fileId: string;
  pageId: string;
  objectId: string;
  scale: '1x' | '2x';
}

export class PaperSourceError extends Error {
  readonly source?: PaperSourceRecord;

  constructor(message: string, source?: PaperSourceRecord) {
    super(message);
    this.name = 'PaperSourceError';
    this.source = source;
  }
}

async function paperRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await apiFetch(`/api/paper${path}`, body === undefined ? {
    cache: 'no-store',
  } : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) {
    const detail = payload?.detail;
    throw new PaperSourceError(
      typeof detail === 'string' ? detail : detail?.message ?? 'Paper source is unavailable.',
      detail?.source ? rewriteBackendAssetUrls(detail.source) : undefined,
    );
  }
  return rewriteBackendAssetUrls(payload) as T;
}

export function getPaperSelection(fileId?: string): Promise<PaperSelection> {
  return paperRequest(`/selection${fileId ? `?fileId=${encodeURIComponent(fileId)}` : ''}`);
}

export async function inspectPaperObject(request: Omit<PaperLinkRequest, 'scale'>): Promise<PaperSelection> {
  const query = new URLSearchParams(request);
  const result = await paperRequest<Omit<PaperSelection, 'selection'> & { object: PaperSelection['selection'][number] }>(`/object?${query}`);
  return { ...result, selection: [result.object] };
}

export function openPaperSource(sourceId: string): Promise<{ navigation: 'file'; objectNavigation: false; url: string; opened: boolean }> {
  return paperRequest(`/sources/${encodeURIComponent(sourceId)}/open`, {});
}

export function linkPaperSource(request: PaperLinkRequest): Promise<PaperSourceRecord> {
  return paperRequest('/sources', request);
}

export function refreshPaperSource(sourceId: string): Promise<PaperSourceRecord> {
  return paperRequest(`/sources/${encodeURIComponent(sourceId)}/refresh`, {});
}

export function reconnectPaperSource(sourceId: string, request: PaperLinkRequest): Promise<PaperSourceRecord> {
  return paperRequest(`/sources/${encodeURIComponent(sourceId)}/reconnect`, request);
}
