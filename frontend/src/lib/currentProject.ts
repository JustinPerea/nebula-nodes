import { create } from 'zustand';
import type { ProjectSummary } from './projects';

/**
 * "This project" for project-scoped Characters, Moodboards and Styles: the
 * canvas project this tab has open (projectStore `activeProject`). It's the
 * same project the CLI and MCP mean by `--project current` (the catalog's
 * activeProjectId), so a board an agent files "here" is in this Project tab.
 *
 * projectStore is the only writer: it publishes its open project here on
 * every change (`publishOpenProject`). This module stays light so lib/api and
 * the other request helpers can read it without loading the project store.
 * There's no fetch or cache: switching projects (the person, or an agent the
 * tab follows) changes it at once, and every surface that lists or files a
 * project asset reads it again. With no project loaded it's null.
 */
export interface CurrentProject {
  id: string;
  name: string;
}

/** What the Project tabs and a project save say when no project is open. */
export const NO_PROJECT_OPEN = 'No project is open. Open one from Projects to use its assets.';

export class NoProjectOpenError extends Error {
  constructor() {
    super(NO_PROJECT_OPEN);
    this.name = 'NoProjectOpenError';
  }
}

const useOpenProjectStore = create<{ project: CurrentProject | null }>(() => ({ project: null }));

/** The open project in a projectStore state, or null (none loaded yet, none
 * open, or the tab stopped after another window took over). */
export function currentProjectOf(state: { initialized: boolean; activeProject: Pick<ProjectSummary, 'id' | 'name'> | null }): CurrentProject | null {
  if (!state.initialized || !state.activeProject) return null;
  return { id: state.activeProject.id, name: state.activeProject.name };
}

/** projectStore's hook: the open project changed (or didn't). */
export function publishOpenProject(project: CurrentProject | null): void {
  const current = useOpenProjectStore.getState().project;
  if (current?.id === project?.id && current?.name === project?.name) return;
  useOpenProjectStore.setState({ project });
}

/** The open project right now, or null. */
export function currentProject(): CurrentProject | null {
  return useOpenProjectStore.getState().project;
}

/** The open project, or null; re-renders when it changes or is renamed. */
export function useCurrentProject(): CurrentProject | null {
  return useOpenProjectStore((state) => state.project);
}

/** The open project's id, or null; re-renders when the project changes. */
export function useCurrentProjectId(): string | null {
  return useOpenProjectStore((state) => state.project?.id ?? null);
}

/** The open project, or a NoProjectOpenError. Async for the callers that
 * used to fetch it. */
export async function getCurrentProject(): Promise<CurrentProject> {
  const project = currentProject();
  if (!project) throw new NoProjectOpenError();
  return project;
}

/** `projectId` when given, else the open project's id (or NoProjectOpenError). */
export async function resolveProjectId(projectId?: string): Promise<string> {
  if (projectId) return projectId;
  return (await getCurrentProject()).id;
}
