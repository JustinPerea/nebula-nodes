import type { Edge, Node, Viewport } from '@xyflow/react';
import type { NodeData } from '../types';
import type { RunRecord } from './runHistory';
import type { CreateDraft } from '../store/createDraftStore';
import { apiFetch } from './backend';

export interface ProjectSummary {
  id: string; name: string; createdAt: string; updatedAt: string;
  lastOpenedAt: string | null; nodeCount: number; edgeCount: number;
  thumbnail: string | null;
}
export interface ProjectSnapshot {
  nodes: Node<NodeData>[]; edges: Edge[]; runHistory: RunRecord[];
  viewport: Viewport | null; createSessionId: string | null;
  createDraft?: CreateDraft | null;
}
export interface SavedProject extends ProjectSummary { snapshot: ProjectSnapshot }
export interface ProjectList {
  projects: ProjectSummary[]; activeProjectId: string | null;
  workspaceRevision: string; migratedProjectId?: string | null;
}
export interface ProjectActivation { project: SavedProject; workspaceRevision: string }

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
export const recoverProject = (sourceProjectId: string, snapshot: ProjectSnapshot, recoveryId: string) =>
  request<ProjectActivation>('/api/projects/recover', json('POST', { sourceProjectId, snapshot, recoveryId })).then((result) => result.project);
