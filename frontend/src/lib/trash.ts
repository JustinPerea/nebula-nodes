import { apiRequest } from './apiRequest';
import { resolveProjectId } from './currentProject';

/**
 * Recently deleted (backend main.py `/api/trash`, services/asset_trash.py).
 *
 * Deleting a moodboard, a character, a Style or a project moves it here. Anyone,
 * agents included, may restore it with the same id. Deleting for good can't
 * be undone, so the backend lets only the person do it.
 */

export type TrashKind = 'moodboard' | 'character' | 'style' | 'project';

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
  /** Projects only: when they're removed for good. Boards, characters and Styles stay until you delete them. */
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

/* Every call names its action (GM, error-copy round 2: "Couldn't {verb}
 * {object}." then the reason); apiRequest says the reason: GM's line for no
 * answer, 408, 429 and 5xx, else the backend's reason, else GM's line for
 * the status. Never a status code. Objects are named as the UI names them,
 * lowercase mid-sentence. */
const NOUN: Record<TrashKind, string> = { moodboard: 'board', character: 'character', style: 'style', project: 'project' };

export async function fetchTrash(filter: TrashFilter = {}): Promise<TrashedItem[]> {
  const response = await apiRequest("Couldn't load Recently deleted.", `/api/trash${await query(filter)}`);
  const body = await response.json() as { items?: TrashedItem[] };
  return body.items ?? [];
}

export async function restoreTrashed(kind: TrashKind, id: string): Promise<void> {
  await apiRequest(`Couldn't restore the ${NOUN[kind]}.`, `/api/trash/${kind}/${encodeURIComponent(id)}/restore`, { method: 'POST' });
}

/** Delete for good. The backend allows only the person. */
export async function purgeTrashed(kind: TrashKind, id: string): Promise<void> {
  await apiRequest(`Couldn't delete the ${NOUN[kind]} for good.`, `/api/trash/${kind}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Delete for good the `shown` items (what the list showed the person) that
 * `fetchTrash(filter)` still lists. Person only. Sending `shown` keeps an
 * agent's delete that landed after the list loaded restorable. */
export async function emptyTrash(filter: TrashFilter, shown: Array<Pick<TrashedItem, 'kind' | 'id'>>): Promise<void> {
  await apiRequest("Couldn't empty Recently deleted.", `/api/trash/empty${await query(filter)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: shown.map(({ kind, id }) => ({ kind, id })) }),
  });
}

/**
 * Who did it, from `kind` alone: "you" only for the person, "<name> (agent)"
 * for an agent, "Nebula", or "an unnamed client". An agent picks its own
 * name, so a name (even "You", or letters that look like it) never reads as
 * the person (backend services/canvas_events.actor_record).
 */
export function actorLabel(by: { kind?: string; name?: string } | null | undefined): string | null {
  if (!by) return null;
  if (by.kind === 'person') return 'you';
  if (by.kind === 'agent') return `${by.name?.trim() || 'Agent'} (agent)`;
  if (by.kind === 'system') return 'Nebula';
  return 'an unnamed client';
}

export function deletedByLabel(item: Pick<TrashedItem, 'deletedBy'>): string | null {
  return actorLabel(item.deletedBy);
}
