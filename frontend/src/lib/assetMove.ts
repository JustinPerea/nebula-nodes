import { NO_PROJECT_OPEN, type CurrentProject } from './currentProject';

/** One choice in a Studio's Move menu: where the saved board or Character
 * would go (`target`: a canvas project id, or null for Global). */
export interface MoveChoice {
  id: 'global' | 'project';
  label: string;
  target: string | null;
  disabled: boolean;
  /** Why it's off, for its tooltip. */
  reason?: string;
}

/**
 * What Move offers for an asset whose own `projectId` is `assetProjectId`,
 * with `openProject` open on the canvas (Justin's call P4, 2026-10-19):
 * "Move to Global" when it's in a project (this one or another), and
 * "Move to <open project>" when it's Global or in another project. With no
 * project open that second choice stays, off, saying why.
 */
export function moveChoices(assetProjectId: string | null | undefined,
  openProject: CurrentProject | null): MoveChoice[] {
  const choices: MoveChoice[] = [];
  if (assetProjectId) choices.push({ id: 'global', label: 'Move to Global', target: null, disabled: false });
  if (!openProject) {
    choices.push({ id: 'project', label: 'Move to a project', target: null, disabled: true, reason: NO_PROJECT_OPEN });
  } else if (assetProjectId !== openProject.id) {
    choices.push({ id: 'project', label: `Move to ${openProject.name}`, target: openProject.id, disabled: false });
  }
  return choices;
}
