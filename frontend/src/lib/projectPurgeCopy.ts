/**
 * What deleting a project for good also deletes, in the Projects screen's
 * Recently deleted (PR #228). The backend lists it per trashed
 * project as `goesWith`: the names of its moodboards, characters and styles
 * (backend/services/project_asset_purge.py). The kinds are always named in
 * that order, lower case, with no serial comma.
 */

export interface GoesWith {
  moodboards: string[];
  characters: string[];
  styles: string[];
}

export const PROJECT_TRASH_NOTE =
  'Deleted projects stay here for 30 days. Deleting one for good also deletes its moodboards, characters and styles. Generated files stay in your outputs folder.';

const KINDS = [
  { key: 'moodboards', one: 'moodboard', many: 'moodboards' },
  { key: 'characters', one: 'character', many: 'characters' },
  { key: 'styles', one: 'style', many: 'styles' },
] as const;

/** "a", "a and b", "a, b and c": no serial comma. */
function listed(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A moodboard, character or style with no name reads “Untitled”, as in the Assets panel and Recently deleted. */
function shownName(name: string): string {
  return name.trim() ? name : 'Untitled';
}

function present(goesWith: GoesWith | undefined) {
  return KINDS.map((kind) => ({ ...kind, names: (goesWith?.[kind.key] ?? []).map(shownName) }))
    .filter((kind) => kind.names.length > 0);
}

/**
 * Delete forever's line between the heading and "This can’t be undone.", or
 * null when the project has none of the three. One kind: its names, one to
 * three ("Its moodboards “Rivers” and “Tide” are deleted with it."), a count
 * from 4 or whenever two names match ("Its 4 styles are deleted with it.",
 * "Its 2 moodboards are deleted with it."). Two or three kinds: counts, no
 * names ("Its 2 moodboards and 1 style are deleted with it.").
 */
export function deleteForeverLine(goesWith: GoesWith | undefined): string | null {
  const kinds = present(goesWith);
  if (!kinds.length) return null;
  if (kinds.length === 1) {
    const [{ one, many, names }] = kinds;
    if (names.length === 1) return `Its ${one} “${names[0]}” is deleted with it.`;
    if (names.length <= 3 && new Set(names).size === names.length) {
      return `Its ${many} ${listed(names.map((name) => `“${name}”`))} are deleted with it.`;
    }
    return `Its ${names.length} ${many} are deleted with it.`;
  }
  return `Its ${listed(kinds.map(({ one, many, names }) => `${names.length} ${names.length === 1 ? one : many}`))} are deleted with it.`;
}

/**
 * Empty's line after its heading: only the kinds present across the
 * projects, no counts ("Their moodboards and styles are deleted with them."),
 * singular for one project ("Its characters are deleted with it."), or null
 * when none of them has any.
 */
export function emptyTrashLine(projects: Array<{ goesWith?: GoesWith }>): string | null {
  const kinds = KINDS.filter((kind) => projects.some((project) => (project.goesWith?.[kind.key] ?? []).length > 0));
  if (!kinds.length) return null;
  const listedKinds = listed(kinds.map((kind) => kind.many));
  return projects.length === 1 ? `Its ${listedKinds} are deleted with it.` : `Their ${listedKinds} are deleted with them.`;
}
