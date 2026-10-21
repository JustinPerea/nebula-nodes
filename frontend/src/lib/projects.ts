import type { Edge, Node, Viewport } from '@xyflow/react';
import type { NodeData } from '../types';
import type { RunRecord } from './runHistory';
import type { CreateDraft } from '../store/createDraftStore';
import { apiFetch } from './backend';

/** The card's picture (backend services/project_cover.py): a pinned image,
 * the newest made image, or up to four input references for a mosaic. */
export interface ProjectCover {
  source: 'pinned' | 'output' | 'references';
  images: string[];
}
export interface ProjectSummary {
  id: string; name: string; createdAt: string; updatedAt: string;
  lastOpenedAt: string | null; nodeCount: number; edgeCount: number;
  thumbnail: string | null;
  /** Missing from a backend older than covers. */
  cover?: ProjectCover | null;
  /** Who pinned the cover ({kind, name}); none on a pin from before it was recorded (the person's). */
  coverBy?: { kind: string; name: string };
  /** A pin whose image left the project (Q90 a): it no longer counts, and the cover is automatic. */
  coverLostPin?: { url: string; by: { kind: string; name: string } | null };
  /** Set when an agent made the project. */
  createdBy?: { kind: 'agent'; name: string };
}
/** The pictures a card shows: one image, or up to four input references as
 * a mosaic when the project has made nothing yet. */
export function coverImages(project: Pick<ProjectSummary, 'cover' | 'thumbnail'>): { images: string[]; mosaic: boolean } {
  const cover = project.cover;
  if (cover && cover.images.length > 0) {
    const mosaic = cover.source === 'references' && cover.images.length > 1;
    return { images: mosaic ? cover.images.slice(0, 4) : cover.images.slice(0, 1), mosaic };
  }
  return { images: project.thumbnail ? [project.thumbnail] : [], mosaic: false };
}
export interface CoverChoice { url: string; kind: 'output' | 'reference' }
export interface CoverChoices {
  images: CoverChoice[]; pinned: string | null; cover: ProjectCover | null;
  /** Who pinned it: kind "person" is the person; missing from a backend before agents could set covers. */
  pinnedBy?: { kind: string; name: string } | null;
  /** The stored pin while its image is gone ({url, by}); it counts again if the image comes back. */
  lostPin?: { url: string; by: { kind: string; name: string } | null } | null;
}
export interface ProjectSnapshot {
  nodes: Node<NodeData>[]; edges: Edge[]; runHistory: RunRecord[];
  viewport: Viewport | null; createSessionId: string | null;
  createDraft?: CreateDraft | null;
}
export interface SavedProject extends ProjectSummary { snapshot: ProjectSnapshot }
export interface TrashedProject extends ProjectSummary { deletedAt: string; purgeAt: string; deletedBy?: { kind: string; name: string } }
export interface ProjectList {
  projects: ProjectSummary[]; trash?: TrashedProject[]; activeProjectId: string | null;
  workspaceRevision: string; migratedProjectId?: string | null;
  /** The backend's params version (lib/savedParamsUpgrades.ts). */
  paramsVersion?: number;
}
export interface ProjectActivation {
  project: SavedProject; workspaceRevision: string;
  /** Create and open only: the backend's params version (none = 0, a backend from before the gate). */
  paramsVersion?: number;
  /** Open only: what opening changed that the person should know (a folded
   * Krea node's dropped connections, services/retired_nodes.py MERGED). */
  warnings?: string[];
}
export interface ProjectDeletion {
  deletedProjectId: string; trashedProject: TrashedProject;
  activeProjectId: string | null; workspaceRevision: string;
}

export class ProjectRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json() as { detail?: unknown };
      if (typeof body.detail === 'string') detail = body.detail;
    } catch { /* Use the readable fallback. */ }
    throw new ProjectRequestError(detail || `Project request failed (${response.status}).`, response.status);
  }
  return response.json() as Promise<T>;
}
const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
export const listProjects = () => request<ProjectList>('/api/projects');
export const getProject = (id: string) => request<SavedProject>(`/api/projects/${encodeURIComponent(id)}`);
export const createProject = (name: string | undefined, workspaceRevision: string) =>
  request<ProjectActivation>('/api/projects', json('POST', { name, workspaceRevision }));
export const openProject = (id: string, workspaceRevision: string) =>
  request<ProjectActivation>(`/api/projects/${encodeURIComponent(id)}/open`, json('POST', { workspaceRevision }));
export const saveProject = (id: string, snapshot: ProjectSnapshot, workspaceRevision: string) =>
  request<ProjectActivation>(`/api/projects/${encodeURIComponent(id)}`, json('PUT', { snapshot, workspaceRevision })).then((result) => result.project);
export const renameProject = (id: string, name: string) =>
  request<ProjectActivation>(`/api/projects/${encodeURIComponent(id)}`, json('PUT', { name })).then((result) => result.project);
export const deleteProject = (id: string, workspaceRevision: string) =>
  request<ProjectDeletion>(`/api/projects/${encodeURIComponent(id)}`, json('DELETE', { workspaceRevision }));
export const restoreProject = (id: string) =>
  request<{ project: ProjectSummary; workspaceRevision: string }>(`/api/projects/${encodeURIComponent(id)}/restore`, { method: 'POST' }).then((result) => result.project);
export const purgeTrashedProject = (id: string) =>
  request<{ trash: TrashedProject[] }>(`/api/projects/trash/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((result) => result.trash);
/** Deletes for good only `ids` (what the list showed), so a project an agent
 * deleted after it loaded stays restorable. */
export const emptyProjectTrash = (ids: string[]) =>
  request<{ trash: TrashedProject[] }>('/api/projects/trash/empty', json('POST', { ids })).then((result) => result.trash);
export const listCoverChoices = (id: string) =>
  request<CoverChoices>(`/api/projects/${encodeURIComponent(id)}/covers`);
/** Pin one of the project's images as its cover, or `null` for automatic. */
export const pinProjectCover = (id: string, url: string | null) =>
  request<{ project: ProjectSummary }>(`/api/projects/${encodeURIComponent(id)}/cover`, json('PUT', { url })).then((result) => result.project);
/** `paramsVersion`: the one-time param upgrades the tab's canvas had when it
 * loaded (lib/savedParamsUpgrades.ts). The backend upgrades the copy from it. */
export const recoverProject = (sourceProjectId: string, snapshot: ProjectSnapshot, recoveryId: string, paramsVersion: number) =>
  request<ProjectActivation>('/api/projects/recover', json('POST', { sourceProjectId, snapshot, recoveryId, paramsVersion })).then((result) => result.project);
