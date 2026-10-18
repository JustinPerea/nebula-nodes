import { apiFetch } from './backend';
import { resolveProjectId } from './currentProject';

/**
 * Recently deleted (backend main.py `/api/trash`, services/asset_trash.py).
 *
 * Deleting a moodboard, a character or a project moves it here. Anyone,
 * agents included, may restore it with the same id. Deleting for good can't
 * be undone, so the backend lets only the person do it.
 */

export type TrashKind = 'moodboard' | 'character' | 'project';

export interface DeletedBy {
  kind: 'person' | 'agent' | 'anonymous' | 'system';
  name: string;
}

export interface TrashedItem {
  kind: TrashKind;
  id: string;
  name: string;
  thumbnail?: string | null;
  projectId?: string | null;
  deletedAt: string;
  /** Missing on projects deleted before who-deleted-it was recorded. */
  deletedBy?: DeletedBy;
  /** Projects only: when they're removed for good. Boards and characters stay until you delete them. */
  purgeAt?: string;
}

export interface TrashFilter {
  kind?: TrashKind;
  scope?: 'project' | 'global';
  projectId?: string;
}

async function query(filter: TrashFilter): Promise<string> {
  const params = new URLSearchParams();
  if (filter.kind) params.set('kind', filter.kind);
  if (filter.scope) params.set('scope', filter.scope);
  if (filter.scope === 'project') params.set('projectId', await resolveProjectId(filter.projectId));
  const text = params.toString();
  return text ? `?${text}` : '';
}

async function failure(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { detail?: unknown };
    if (typeof body?.detail === 'string' && body.detail) return new Error(body.detail);
  } catch { /* not JSON */ }
  return new Error(`${fallback}: ${response.status}`);
}

export async function fetchTrash(filter: TrashFilter = {}): Promise<TrashedItem[]> {
  const response = await apiFetch(`/api/trash${await query(filter)}`);
  if (!response.ok) throw await failure(response, 'Loading Recently deleted failed');
  const body = await response.json() as { items?: TrashedItem[] };
  return body.items ?? [];
}

export async function restoreTrashed(kind: TrashKind, id: string): Promise<void> {
  const response = await apiFetch(`/api/trash/${kind}/${encodeURIComponent(id)}/restore`, { method: 'POST' });
  if (!response.ok) throw await failure(response, 'Restore failed');
}

/** Delete for good. The backend allows only the person. */
export async function purgeTrashed(kind: TrashKind, id: string): Promise<void> {
  const response = await apiFetch(`/api/trash/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw await failure(response, 'Delete failed');
}

/** Delete for good the `shown` items (what the list showed the person) that
 * `fetchTrash(filter)` still lists. Person only. Sending `shown` keeps an
 * agent's delete that landed after the list loaded restorable. */
export async function emptyTrash(filter: TrashFilter, shown: Array<Pick<TrashedItem, 'kind' | 'id'>>): Promise<void> {
  const response = await apiFetch(`/api/trash/empty${await query(filter)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: shown.map(({ kind, id }) => ({ kind, id })) }),
  });
  if (!response.ok) throw await failure(response, 'Emptying Recently deleted failed');
}

/** "you", an agent's name, or "an unnamed client". */
export function deletedByLabel(item: Pick<TrashedItem, 'deletedBy'>): string | null {
  const by = item.deletedBy;
  if (!by) return null;
  if (by.kind === 'person') return 'you';
  if (by.kind === 'anonymous') return 'an unnamed client';
  return by.name;
}
