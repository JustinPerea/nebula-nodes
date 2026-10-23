import { apiFetch, rewriteBackendAssetUrls } from './backend';
import { copyForStatus, readDetail, REFUSED_FALLBACK_COPY, RequestFailedError, requestSucceeded, warnFailure, withHeading } from './errorCopy';

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

/** Desktop and web routes verified against Paper's installed deep-link handler.
 * Derive from the bound identity, never a URL supplied by an imported graph.
 * Legacy snapshot navigation metadata remains immutable and file-scoped.
 */
export function paperObjectLinks(identity: Pick<PaperSourceIdentity, 'fileId' | 'pageId' | 'objectId'>): { desktop: string; web: string } | null {
  const ids = [identity.fileId, identity.pageId, identity.objectId];
  if (ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 128 || /[^A-Za-z0-9_-]/.test(id))) return null;
  const path = `file/${ids.join('/')}`;
  return { desktop: `paper://${path}`, web: `https://app.paper.design/${path}` };
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
  /** The specific text, for agents (word for word). */
  lastError?: string;
  /** The card's line beside it (error copy round 3e, services/paper_copy.py). */
  lastErrorPerson?: string;
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

/** A Paper route's refusal (error copy round 3e). The heading names the
 * card's action; the reason is the route's `person` line (paper_routes), and
 * `detail.message`, the specific text, stays for the console and agents. A
 * refresh that failed carries the source record the backend kept. */
export class PaperSourceError extends RequestFailedError {
  readonly source?: PaperSourceRecord;

  constructor(heading: string, status: number, options: { detail?: unknown; reason?: string; source?: PaperSourceRecord } = {}) {
    super(heading, status, { detail: options.detail, reason: options.reason });
    this.name = 'PaperSourceError';
    this.source = options.source;
  }
}

const PAPER_HEADINGS = {
  selection: "Couldn't read the Paper selection.",
  object: "Couldn't find that Paper object.",
  open: "Couldn't open the source.",
  link: "Couldn't link the artwork.",
  refresh: "Couldn't refresh the source.",
  reconnect: "Couldn't reconnect the object.",
} as const;

async function paperRequest<T>(heading: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await apiFetch(`/api/paper${path}`, body === undefined ? {
      cache: 'no-store',
    } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw withHeading(error, heading);
  }
  if (!response.ok) {
    const detail = await readDetail(response) as { person?: unknown; source?: PaperSourceRecord } | string | undefined;
    warnFailure(heading, response.status, detail);
    const person = typeof detail === 'object' && typeof detail?.person === 'string' ? detail.person : undefined;
    const source = typeof detail === 'object' && detail?.source ? rewriteBackendAssetUrls(detail.source) as PaperSourceRecord : undefined;
    throw new PaperSourceError(heading, response.status, {
      detail, source, reason: person ?? copyForStatus(response.status, undefined),
    });
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // An answer the browser can't read: GM's general line under the heading.
    throw new PaperSourceError(heading, response.status, { reason: REFUSED_FALLBACK_COPY });
  }
  requestSucceeded(heading);
  return rewriteBackendAssetUrls(payload) as T;
}

export function getPaperSelection(fileId?: string): Promise<PaperSelection> {
  return paperRequest(PAPER_HEADINGS.selection, `/selection${fileId ? `?fileId=${encodeURIComponent(fileId)}` : ''}`);
}

export async function inspectPaperObject(request: Omit<PaperLinkRequest, 'scale'>): Promise<PaperSelection> {
  const query = new URLSearchParams(request);
  const result = await paperRequest<Omit<PaperSelection, 'selection'> & { object: PaperSelection['selection'][number] }>(
    PAPER_HEADINGS.object, `/object?${query}`);
  return { ...result, selection: [result.object] };
}

export function openPaperSource(sourceId: string): Promise<{ navigation: 'file'; objectNavigation: false; url: string; opened: boolean }> {
  return paperRequest(PAPER_HEADINGS.open, `/sources/${encodeURIComponent(sourceId)}/open`, {});
}

export function linkPaperSource(request: PaperLinkRequest): Promise<PaperSourceRecord> {
  return paperRequest(PAPER_HEADINGS.link, '/sources', request);
}

export function refreshPaperSource(sourceId: string): Promise<PaperSourceRecord> {
  return paperRequest(PAPER_HEADINGS.refresh, `/sources/${encodeURIComponent(sourceId)}/refresh`, {});
}

export function reconnectPaperSource(sourceId: string, request: PaperLinkRequest): Promise<PaperSourceRecord> {
  return paperRequest(PAPER_HEADINGS.reconnect, `/sources/${encodeURIComponent(sourceId)}/reconnect`, request);
}
