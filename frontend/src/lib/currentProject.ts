import { apiFetch } from './backend';

export interface CurrentProject {
  id: string;
  name: string;
}

let cachedProject: Promise<CurrentProject> | null = null;

/** Resolve the backend-owned identity shared by every project-scoped surface. */
export function getCurrentProject(): Promise<CurrentProject> {
  if (!cachedProject) {
    cachedProject = apiFetch('/api/project')
      .then(async (response) => {
        if (!response.ok) throw new Error(`Fetch current project failed: ${response.status}`);
        const project = await response.json() as Partial<CurrentProject>;
        if (!project.id || !project.name) throw new Error('Backend returned an invalid project identity.');
        return { id: project.id, name: project.name };
      })
      .catch((error) => {
        cachedProject = null;
        throw error;
      });
  }
  return cachedProject;
}

export async function resolveProjectId(projectId?: string): Promise<string> {
  if (projectId) return projectId;
  return (await getCurrentProject()).id;
}

/** Test/reconnect seam: a recovered backend may represent another project. */
export function clearCurrentProjectCache(): void {
  cachedProject = null;
}
