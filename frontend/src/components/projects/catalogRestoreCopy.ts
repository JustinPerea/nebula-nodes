/**
 * GM's lines for the Projects home notice after Nebula restored a damaged
 * project list (backend services/project_store.py _restore; GM - Design on
 * PR #199, rounds 1 and 2, 2026-10-27). Shown until the person closes it
 * with ×. The damaged file's path never goes in the notice: it is in the
 * Agent log line, and agents read it from GET /api/projects `catalogRestore`.
 *
 * GM's general rules: names up to 3, a count from 4, never a count of 1
 * (except where the name couldn't be read).
 */
import type { CatalogRestore } from '../../lib/projects';

/** How many projects are named before a line gives a count. */
export const RESTORE_NAMED_MAX = 3;

/** The button the notice shows when something is in Recently deleted. */
export const OPEN_RECENTLY_DELETED = 'Open Recently deleted';

const OPENING = "Nebula's project list was damaged, so it restored the last good copy";
const REBUILT = "Nebula's project list was damaged and there was no good copy, so it recovered every project it could still read.";
const KEPT = 'The damaged file was kept.';

/** PENDING GM: the open project's record didn't come back, and its live
 * canvas was filed as its own project (backend `recoveredCanvas`). Not GM's
 * words yet; one constant so the relay replaces it in one place. */
export const RECOVERED_CANVAS_SENTENCE_PENDING = "The project you had open couldn't be restored, so its canvas is now “Recovered canvas”.";

const quoted = (name: string) => `“${name}”`;

function namedList(names: string[]): string {
  if (names.length === 1) return quoted(names[0]);
  return `${names.slice(0, -1).map(quoted).join(', ')} and ${quoted(names[names.length - 1])}`;
}

interface Row { name?: string | null; trashed?: boolean; liveCanvas?: boolean }

/** The names to say for `count` projects, or null when the line counts:
 * past RESTORE_NAMED_MAX, or a name that couldn't be read. */
function namesFor(rows: Row[], count: number): string[] | null {
  if (count < 1 || count > RESTORE_NAMED_MAX || rows.length !== count) return null;
  const names = rows.map((row) => row.name);
  return names.every((name): name is string => typeof name === 'string' && name.length > 0) ? names : null;
}

/** How many of a listed kind there are: the record's count, or its rows. */
const total = (count: number | undefined, rows: unknown[] | undefined) => Math.max(count ?? 0, rows?.length ?? 0);

/** "2 days ago" and the like, for the copy's age (GM: "from 2 days ago"), or
 * null when it is under a minute or unknown (the usual opening). */
export function copyAge(copyAt: string | null | undefined, now: number = Date.now()): string | null {
  const at = copyAt ? Date.parse(copyAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return null;
  if (minutes < 60) return minutes === 1 ? 'a minute ago' : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export interface CatalogRestoreNotice {
  text: string;
  /** Show "Open Recently deleted": something the person should look at is there. */
  openRecentlyDeleted: boolean;
}

type NoticeInput = Pick<CatalogRestore, 'kind' | 'addedBack' | 'addedBackCount' | 'notAddedBackCount'>
  & Partial<Pick<CatalogRestore, 'source' | 'copyAt' | 'damagedFile' | 'setAside' | 'notAddedBack' | 'reverted'
    | 'revertedCount' | 'cameBack' | 'cameBackCount' | 'backInTrash' | 'backInTrashCount' | 'recoveredCanvas'
    | 'damagedReadWhole'>>;

function rebuiltNotice(restore: NoticeInput): CatalogRestoreNotice {
  // GM: "Lost Recently deleted entries: not in the notice; log them."
  const rows = (restore.notAddedBack ?? []).filter((row) => row.trashed !== true);
  const trashedRows = (restore.notAddedBack ?? []).length - rows.length;
  const lost = Math.max(0, (restore.notAddedBackCount ?? 0) - trashedRows);
  const canvas = restore.recoveredCanvas ? ` ${RECOVERED_CANVAS_SENTENCE_PENDING}` : '';
  if (lost === 0) {
    return { text: `${REBUILT} If a project you expect isn't here, it couldn't be recovered.${canvas} ${KEPT}`, openRecentlyDeleted: false };
  }
  const names = namesFor(rows, lost);
  const who = names ? namedList(names) : `${lost} ${lost === 1 ? 'project' : 'projects'}`;
  return { text: `${REBUILT} ${who} couldn't be recovered, and others may be missing too.${canvas} ${KEPT}`, openRecentlyDeleted: false };
}

/** The notice for `restore`: GM's sentences in GM's order. */
export function catalogRestoreNotice(restore: NoticeInput, now: number = Date.now()): CatalogRestoreNotice {
  if (restore.kind === 'rebuilt') return rebuiltNotice(restore);
  const addedRows = restore.addedBack ?? [];
  const trashedAdded = addedRows.filter((row) => row.trashed === true);
  const liveAddedRows = addedRows.filter((row) => row.trashed !== true);
  const liveAdded = Math.max(0, total(restore.addedBackCount, addedRows) - trashedAdded.length);
  const failedRows = restore.notAddedBack ?? [];
  const failed = total(restore.notAddedBackCount, failedRows);
  // (a): the open project whose graph came back from the live canvas isn't
  // reverted for the person, and a project they deleted isn't news.
  const revertedRows = (restore.reverted ?? []).filter((row) => !row.liveCanvas && !row.trashed);
  const revertedOut = (restore.reverted ?? []).length - revertedRows.length;
  const reverted = Math.max(0, total(restore.revertedCount, restore.reverted) - revertedOut);
  const cameBackRows = restore.cameBack ?? [];
  const cameBack = total(restore.cameBackCount, cameBackRows);
  const backInTrashRows = restore.backInTrash ?? [];
  const backInTrash = total(restore.backInTrashCount, backInTrashRows);
  const kept = Boolean(restore.damagedFile) || (restore.setAside ?? []).length > 0;

  // GM: say the copy's age up front when the copy is the older one, or when
  // it decided something; unknown (or under a minute): the usual opening.
  const older = restore.source === 'catalog.json.bak.1' || reverted > 0 || cameBack > 0 || backInTrash > 0;
  const age = older ? copyAge(restore.copyAt, now) : null;
  const opening = age ? `${OPENING}, from ${age}` : OPENING;
  const sentences: string[] = [];

  if (liveAdded > 0) {
    const names = namesFor(liveAddedRows, liveAdded);
    if (names?.length === 1) sentences.push(`${opening} and added back ${quoted(names[0])}, a newer project it found.`);
    else if (names) sentences.push(`${opening} and added back ${namedList(names)}, newer projects it found.`);
    else sentences.push(`${opening} and added back ${liveAdded} newer projects it found.`);
  } else {
    sentences.push(`${opening}.`);
  }

  // Form 2: added back into Recently deleted (not on the grid).
  if (trashedAdded.length > 0) {
    const count = trashedAdded.length;
    const names = namesFor(trashedAdded, count);
    if (names?.length === 1) sentences.push(`${quoted(names[0])}, a newer project it found, is in Recently deleted. Restore it from there to keep it.`);
    else if (names) sentences.push(`${namedList(names)}, newer projects it found, are in Recently deleted. Restore them from there to keep them.`);
    else sentences.push(`${count} newer projects it found are in Recently deleted. Restore them from there to keep them.`);
  }

  // Add-backs that failed (GM round 1, form 2): named, or counted when the
  // name couldn't be read (even 1–3). After something was added back, the
  // named line drops ", a newer project,".
  if (failed > 0) {
    const names = namesFor(failedRows, failed);
    const partial = liveAdded > 0 || trashedAdded.length > 0;
    if (names && partial) sentences.push(`${namedList(names)} couldn't be added back.`);
    else if (names?.length === 1) sentences.push(`${quoted(names[0])}, a newer project, couldn't be added back.`);
    else if (names) sentences.push(`${namedList(names)}, newer projects, couldn't be added back.`);
    else sentences.push(`${failed} newer ${failed === 1 ? 'project' : 'projects'} couldn't be added back.`);
  }

  // (a) Reverted to the copy's version.
  if (reverted > 0) {
    const names = namesFor(revertedRows, reverted);
    if (names?.length === 1) sentences.push(`${quoted(names[0])} went back to its version in that copy, so its latest edits aren't there.`);
    else if (names) sentences.push(`${namedList(names)} went back to their versions in that copy, so their latest edits aren't there.`);
    else sentences.push(`${reverted} projects went back to their versions in that copy, so their latest edits aren't there.`);
  }

  // (b) Back after it was deleted (who deleted it isn't named).
  if (cameBack > 0) {
    const names = namesFor(cameBackRows, cameBack);
    if (names?.length === 1) sentences.push(`${quoted(names[0])} was deleted, but the copy still had it, so it's back. Delete it again if you don't need it.`);
    else if (names) sentences.push(`${namedList(names)} were deleted, but the copy still had them, so they're back. Delete them again if you don't need them.`);
    else sentences.push(`${cameBack} deleted projects are back because the copy still had them. Delete them again if you don't need them.`);
  }

  // (c) Back in Recently deleted.
  if (backInTrash > 0) {
    const names = namesFor(backInTrashRows, backInTrash);
    if (names?.length === 1) sentences.push(`${quoted(names[0])} is in Recently deleted again because the copy had it there. Restore it again if you need it.`);
    else if (names) sentences.push(`${namedList(names)} are in Recently deleted again because the copy had them there. Restore them again if you need them.`);
    else sentences.push(`${backInTrash} projects are in Recently deleted again because the copy had them there. Restore them again if you need them.`);
  }

  const canvas = Boolean(restore.recoveredCanvas);
  if (canvas) sentences.push(RECOVERED_CANVAS_SENTENCE_PENDING);
  const saidMore = liveAdded > 0 || trashedAdded.length > 0 || failed > 0 || reverted > 0 || cameBack > 0 || backInTrash > 0 || canvas;
  // Said only when the damaged file was read to its end: past a cut or a
  // zeroed span, what it held is unknown (fix round 1's live check).
  const readWhole = restore.damagedReadWhole === true;
  if (!saidMore && readWhole) sentences.push('No projects were missing.');
  // Only when the file really is kept AND something may be lost.
  if (kept && (failed > 0 || reverted > 0 || canvas || !readWhole)) sentences.push(KEPT);
  return { text: sentences.join(' '), openRecentlyDeleted: trashedAdded.length > 0 || backInTrash > 0 };
}

/** The notice's text for `restore`. */
export function catalogRestoreLine(restore: NoticeInput, now: number = Date.now()): string {
  return catalogRestoreNotice(restore, now).text;
}

function logList(rows: Row[], count: number): string {
  const names = namesFor(rows, count);
  return names ? namedList(names) : `${count} ${count === 1 ? 'project' : 'projects'}`;
}

/** The Agent log's line (source "system", GM round 2): sentences, with the
 * damaged file's absolute path, which the notice leaves out. */
export function catalogRestoreLogLine(restore: Pick<CatalogRestore, 'kind' | 'source' | 'damagedFile' | 'addedBack' | 'addedBackCount' | 'notAddedBackCount'>
  & Partial<Pick<CatalogRestore, 'setAside' | 'notAddedBack'>>): string {
  const sentences: string[] = [];
  // GM worded the restored opening; the rebuild's is ours (no good copy to name).
  sentences.push(restore.kind === 'rebuilt' || !restore.source
    ? 'Rebuilt the project list from the damaged files.'
    : `Restored the project list from ${restore.source}.`);
  const path = restore.damagedFile ?? restore.setAside?.[0] ?? null;
  if (path) sentences.push(`The damaged file was kept at ${path}.`);
  const rows = restore.addedBack ?? [];
  const trashed = rows.filter((row) => row.trashed === true);
  const live = rows.filter((row) => row.trashed !== true);
  const liveCount = Math.max(0, total(restore.addedBackCount, rows) - trashed.length);
  if (liveCount > 0) sentences.push(`Added back ${logList(live, liveCount)}.`);
  if (trashed.length > 0) sentences.push(`Put ${logList(trashed, trashed.length)} in Recently deleted.`);
  const failedRows = restore.notAddedBack ?? [];
  const failed = total(restore.notAddedBackCount, failedRows);
  if (failed > 0) sentences.push(`Couldn't add back ${logList(failedRows, failed)}.`);
  return sentences.join(' ');
}
