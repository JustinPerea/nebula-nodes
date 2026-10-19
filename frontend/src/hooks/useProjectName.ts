import { useProjectStore } from '../store/projectStore';

type ProjectLists = Pick<ReturnType<typeof useProjectStore.getState>, 'projects' | 'trash' | 'activeProject'>;

/** A canvas project's name by id, from the projects this tab has listed
 * (Recently deleted too), or null when it isn't known here. */
export function projectNameOf(state: ProjectLists, id: string): string | null {
  if (state.activeProject?.id === id) return state.activeProject.name;
  return state.projects.find((project) => project.id === id)?.name
    ?? state.trash.find((project) => project.id === id)?.name
    ?? null;
}

/** The name of the project `id` names (an asset's own projectId), or null. */
export function useProjectName(id: string | null | undefined): string | null {
  return useProjectStore((state) => (id ? projectNameOf(state, id) : null));
}
