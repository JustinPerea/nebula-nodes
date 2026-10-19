import type { AssetScope } from '../store/uiStore';

/**
 * Where an open saved board or Character lives, for the Studio rails. Its own
 * `projectId` says, not the scope it was opened with (a node's Open button and
 * a link don't know it): Global, the canvas project open now, or another
 * canvas project (opened by link, or from a node pasted from that project).
 */
export type AssetHome =
  | { scope: 'global' }
  | { scope: 'project'; here: true }
  | { scope: 'project'; here: false; projectName: string | null };

export type RailAssetKind = 'moodboard' | 'character';

const NOUN: Record<RailAssetKind, { one: string; many: string }> = {
  moodboard: { one: 'board', many: 'moodboards' },
  character: { one: 'Character', many: 'Characters' },
};

/** `projectId` is the asset's own; `projectName` names it when it isn't the open one. */
export function assetHome(projectId: string | null | undefined, openProjectId: string | null,
  projectName: string | null): AssetHome {
  if (!projectId) return { scope: 'global' };
  if (projectId === openProjectId) return { scope: 'project', here: true };
  return { scope: 'project', here: false, projectName };
}

function elsewhere(home: AssetHome | null): home is { scope: 'project'; here: false; projectName: string | null } {
  return Boolean(home && home.scope === 'project' && !home.here);
}

export function whereItLives(kind: RailAssetKind, home: AssetHome): string {
  const subject = `This ${NOUN[kind].one}`;
  if (home.scope === 'global') return `${subject} is Global.`;
  if (home.here) return `${subject} is in this project.`;
  return home.projectName ? `${subject} is in ${home.projectName}.` : `${subject} is in another project.`;
}

/** Above the list, when the open asset is in neither list the rail can show:
 * it belongs to another project. Null otherwise. */
export function railNotice(kind: RailAssetKind, home: AssetHome | null): string | null {
  return elsewhere(home) ? whereItLives(kind, home) : null;
}

/** What a rail says when a tab has nothing in it. With no project open the
 * Project tab says to open one. When the open asset is in the other tab it
 * says so, so an empty list never reads as a lost asset. */
export function emptyRailMessage(kind: RailAssetKind, scope: AssetScope, home: AssetHome | null,
  projectOpen = true): string {
  const many = NOUN[kind].many;
  if (scope === 'project' && !projectOpen) return `Open a project to see its ${many}.`;
  const named = `${scope === 'project' ? 'project' : 'global'} ${many}`;
  if (home && home.scope !== scope && !elsewhere(home)) return `No ${named}. ${whereItLives(kind, home)}`;
  return `No ${named} yet.`;
}
