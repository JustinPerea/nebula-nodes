/**
 * GM's lines for the Projects home notice after Nebula restored a damaged
 * project list (backend services/project_store.py _restore, 2026-10-27).
 * Shown once, until the person closes it with ×. The damaged file's path
 * never goes in the notice: it is in the Agent log line below, and agents
 * read it from GET /api/projects `catalogRestore`.
 */
import type { CatalogRestore } from '../../lib/projects';

/** How many added-back projects are named before the line gives a count. */
export const RESTORE_NAMED_MAX = 3;

/** GM's second sentence for a rebuild is pending (what a rebuild can lose).
 * PLACEHOLDER: replace with GM's sentence, or drop it if GM says nothing
 * visible is lost. */
export const REBUILD_SECOND_SENTENCE_PLACEHOLDER = '[GM: second sentence pending]';

const quoted = (name: string) => `“${name}”`;

function namedList(names: string[]): string {
  if (names.length === 1) return quoted(names[0]);
  return `${names.slice(0, -1).map(quoted).join(', ')} and ${quoted(names[names.length - 1])}`;
}

/** The notice's line for `restore`. */
export function catalogRestoreLine(restore: Pick<CatalogRestore, 'kind' | 'addedBack' | 'addedBackCount' | 'notAddedBackCount'>): string {
  if (restore.kind === 'rebuilt') {
    return `Nebula's project list was damaged, so it rebuilt it from your project folders. ${REBUILD_SECOND_SENTENCE_PLACEHOLDER}`;
  }
  const added = Math.max(restore.addedBackCount ?? 0, restore.addedBack?.length ?? 0);
  const names = (restore.addedBack ?? []).map((row) => row.name);
  if (added === 0) {
    // Some couldn't be added back: never "No projects were missing".
    // PLACEHOLDER (not GM's): the restored line alone, until GM words this case.
    if ((restore.notAddedBackCount ?? 0) > 0) return "Nebula's project list was damaged, so it restored the last good copy.";
    return "Nebula's project list was damaged, so it restored the last good copy. No projects were missing.";
  }
  if (added === 1 && names.length === 1) {
    return `Nebula's project list was damaged, so it restored the last good copy and added back ${quoted(names[0])}, a newer project it found.`;
  }
  if (added <= RESTORE_NAMED_MAX && names.length === added) {
    return `Nebula's project list was damaged, so it restored the last good copy and added back ${namedList(names)}, newer projects it found.`;
  }
  return `Nebula's project list was damaged, so it restored the last good copy and added back ${added} newer projects it found.`;
}

/** The Agent log's line (source "system"): where it came from and where the
 * damaged file is kept, for agents and support. Not GM copy. */
export function catalogRestoreLogLine(restore: Pick<CatalogRestore, 'kind' | 'source' | 'damagedFile' | 'addedBackCount' | 'notAddedBackCount'>): string {
  const from = restore.kind === 'rebuilt' || !restore.source
    ? 'Project list rebuilt from the damaged files (no good copy)'
    : `Project list restored from ${restore.source}`;
  const kept = restore.damagedFile ? `; damaged file kept at ${restore.damagedFile}` : '';
  const added = `; ${restore.addedBackCount ?? 0} added back`;
  const missed = (restore.notAddedBackCount ?? 0) > 0 ? `, ${restore.notAddedBackCount} not added back` : '';
  return `${from}${kept}${added}${missed}.`;
}
