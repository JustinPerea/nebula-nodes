/**
 * GM's lines for the Projects home notice after Nebula restored a damaged
 * project list (backend services/project_store.py _restore; GM - Design on
 * PR #199, rounds 1 to 3, 2026-10-27). Shown until the person closes it
 * with ×. The damaged file's path never goes in the notice: it is in the
 * Agent log line, and agents read it from GET /api/projects `catalogRestore`.
 *
 * Layout (GM r3, B): one outcome is said inline after the opening, as in A.
 * More than one: the opening on its own line, then each outcome on its own
 * line in GM's order, then "The damaged file was kept." last (`lines`).
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

const quoted = (name: string) => `“${name}”`;

/** The name the backend gives the live canvas when which project it was
 * isn't known (main.RECOVERED_CANVAS_NAME). */
const RECOVERED_CANVAS = 'Recovered canvas';
/** GM r3: "When the damaged file wasn't read whole" (it replaces "No
 * projects were missing."; "The damaged file was kept." follows it). */
const NOT_READ_WHOLE = "Nebula couldn't read the whole damaged file, so changes made after that copy may be missing.";

/** GM r3 (follow-up), one sentence for every case: the open project
 * couldn't be restored, it was restored but older (upgrade day), or which
 * project the canvas was couldn't be proven. `name` is the project it was
 * filed as: "Alpha (recovered)", "Alpha (recovered 2)" and so on (backend
 * project_store.recovered_name), or "Recovered canvas". */
export function recoveredCanvasSentence(name: string | null | undefined): string {
  return `The canvas you had open was saved as its own project, ${quoted(name || RECOVERED_CANVAS)}, so nothing in it is lost.`;
}

/** PENDING GM (review 2, L4): the open canvas isn't a project in the
 * restored list and couldn't be saved as its own, because the list is at a
 * limit (backend `canvasNotFiled`). It stays the live canvas until there is
 * room. Not GM's words yet: one constant per limit so the relay replaces
 * them in one place. */
export const CANVAS_NOT_FILED_PENDING: Record<'projects' | 'storage', string> = {
  projects: "The canvas you had open couldn't be saved as its own project because the project list is full. Move a project to Recently deleted to make room, and it will be saved.",
  storage: "The canvas you had open couldn't be saved as its own project because project storage is full. Delete a project for good to make room, and it will be saved.",
};

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

/** The copy's age after "from" (GM r3's scale): under an hour "less than
 * an hour ago"; "an hour ago", "5 hours ago" to 23; "a day ago" to 47 hours;
 * "3 days ago" to 6 days; "a week ago" to 13 days; then the date as the
 * home cards write it ("Oct 12", with the year when it isn't this year's).
 * Never "earlier today" or "over a week ago". Null when unknown. */
export function copyAge(copyAt: string | null | undefined, now: number = Date.now()): string | null {
  const at = copyAt ? Date.parse(copyAt) : Number.NaN;
  if (!Number.isFinite(at)) return null;
  const hours = Math.floor(Math.max(0, now - at) / 3_600_000);
  if (hours < 1) return 'less than an hour ago';
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days < 2) return 'a day ago';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'a week ago';
  const date = new Date(at);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' as const }) }).format(date);
}

export interface CatalogRestoreNotice {
  /** The notice as one paragraph (single outcome, or for logs and tests). */
  text: string;
  /** GM r3's B layout, when there is more than one outcome: the opening,
   * each outcome, and "The damaged file was kept." when said, one per line.
   * Null when the notice is said inline. */
  lines: string[] | null;
  /** Show "Open Recently deleted": something the person should look at is there. */
  openRecentlyDeleted: boolean;
}

/** The notice from its parts: inline for one outcome or none, stacked for more. */
function layout(opening: string, outcomes: string[], closing: string | null, openRecentlyDeleted: boolean): CatalogRestoreNotice {
  const all = [opening, ...outcomes, ...(closing ? [closing] : [])];
  return { text: all.join(' '), lines: outcomes.length > 1 ? all : null, openRecentlyDeleted };
}

type NoticeInput = Pick<CatalogRestore, 'kind' | 'addedBack' | 'addedBackCount' | 'notAddedBackCount'>
  & Partial<Pick<CatalogRestore, 'source' | 'copyAt' | 'damagedFile' | 'setAside' | 'notAddedBack' | 'reverted'
    | 'revertedCount' | 'cameBack' | 'cameBackCount' | 'backInTrash' | 'backInTrashCount' | 'recoveredCanvas'
    | 'canvasNotFiled' | 'damagedReadWhole' | 'openProjectMissing'>>;

/** The open canvas's outcome (GM r3: the last outcome line), if any. */
function canvasSentence(restore: NoticeInput): string | null {
  if (restore.recoveredCanvas) return recoveredCanvasSentence(restore.recoveredCanvas.name);
  const waiting = restore.canvasNotFiled?.reason;
  return waiting === 'projects' || waiting === 'storage' ? CANVAS_NOT_FILED_PENDING[waiting] : null;
}

function rebuiltNotice(restore: NoticeInput): CatalogRestoreNotice {
  // GM: "Lost Recently deleted entries: not in the notice; log them."
  const rows = (restore.notAddedBack ?? []).filter((row) => row.trashed !== true);
  const trashedRows = (restore.notAddedBack ?? []).length - rows.length;
  const lost = Math.max(0, (restore.notAddedBackCount ?? 0) - trashedRows);
  const outcomes: string[] = [];
  if (lost === 0) {
    outcomes.push("If a project you expect isn't here, it couldn't be recovered.");
  } else {
    const names = namesFor(rows, lost);
    const who = names ? namedList(names) : `${lost} ${lost === 1 ? 'project' : 'projects'}`;
    outcomes.push(`${who} couldn't be recovered, and others may be missing too.`);
  }
  const canvas = canvasSentence(restore);
  if (canvas) outcomes.push(canvas);
  return layout(REBUILT, outcomes, KEPT, false);
}

/** The notice for `restore`: GM's sentences in GM's order. */
export function catalogRestoreNotice(restore: NoticeInput, now: number = Date.now()): CatalogRestoreNotice {
  if (restore.kind === 'rebuilt') return rebuiltNotice(restore);
  const addedRows = restore.addedBack ?? [];
  const trashedAdded = addedRows.filter((row) => row.trashed === true);
  const liveAddedRows = addedRows.filter((row) => row.trashed !== true);
  const liveAdded = Math.max(0, total(restore.addedBackCount, addedRows) - trashedAdded.length);
  // The open project that couldn't be added back but whose canvas was saved
  // as its own project: the canvas sentence is its one sentence (GM r3), so
  // its failed add-back isn't said beside "so nothing in it is lost". The
  // Agent log still lists it.
  const savedFrom = restore.recoveredCanvas ? restore.openProjectMissing ?? null : null;
  const failedRows = (restore.notAddedBack ?? []).filter((row) => savedFrom === null || row.id !== savedFrom);
  const failedOut = (restore.notAddedBack ?? []).length - failedRows.length;
  const failed = Math.max(0, total(restore.notAddedBackCount, restore.notAddedBack) - failedOut);
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
  // it decided something; unknown: the usual opening. No comma before it (GM r3).
  const older = restore.source === 'catalog.json.bak.1' || reverted > 0 || cameBack > 0 || backInTrash > 0;
  const age = older ? copyAge(restore.copyAt, now) : null;
  const start = age ? `${OPENING} from ${age}` : OPENING;
  let opening: string;
  const outcomes: string[] = [];

  if (liveAdded > 0) {
    const names = namesFor(liveAddedRows, liveAdded);
    if (names?.length === 1) opening = `${start} and added back ${quoted(names[0])}, a newer project it found.`;
    else if (names) opening = `${start} and added back ${namedList(names)}, newer projects it found.`;
    else opening = `${start} and added back ${liveAdded} newer projects it found.`;
  } else {
    opening = `${start}.`;
  }

  // GM r3's order: added back to Recently deleted, reverted, deleted but
  // back, back in Recently deleted, the open canvas saved. Add-backs that
  // failed follow form 2 (their place in A).
  if (trashedAdded.length > 0) {
    const count = trashedAdded.length;
    const names = namesFor(trashedAdded, count);
    if (names?.length === 1) outcomes.push(`${quoted(names[0])}, a newer project it found, is in Recently deleted. Restore it from there to keep it.`);
    else if (names) outcomes.push(`${namedList(names)}, newer projects it found, are in Recently deleted. Restore them from there to keep them.`);
    else outcomes.push(`${count} newer projects it found are in Recently deleted. Restore them from there to keep them.`);
  }

  // Add-backs that failed (GM round 1, form 2): named, or counted when the
  // name couldn't be read (even 1–3). After something was added back, the
  // named line drops ", a newer project,".
  if (failed > 0) {
    const names = namesFor(failedRows, failed);
    const partial = liveAdded > 0 || trashedAdded.length > 0;
    if (names && partial) outcomes.push(`${namedList(names)} couldn't be added back.`);
    else if (names?.length === 1) outcomes.push(`${quoted(names[0])}, a newer project, couldn't be added back.`);
    else if (names) outcomes.push(`${namedList(names)}, newer projects, couldn't be added back.`);
    else outcomes.push(`${failed} newer ${failed === 1 ? 'project' : 'projects'} couldn't be added back.`);
  }

  // (a) Reverted to the copy's version.
  if (reverted > 0) {
    const names = namesFor(revertedRows, reverted);
    if (names?.length === 1) outcomes.push(`${quoted(names[0])} went back to its version in that copy, so its latest edits aren't there.`);
    else if (names) outcomes.push(`${namedList(names)} went back to their versions in that copy, so their latest edits aren't there.`);
    else outcomes.push(`${reverted} projects went back to their versions in that copy, so their latest edits aren't there.`);
  }

  // (b) Back after it was deleted (who deleted it isn't named).
  if (cameBack > 0) {
    const names = namesFor(cameBackRows, cameBack);
    if (names?.length === 1) outcomes.push(`${quoted(names[0])} was deleted, but the copy still had it, so it's back. Delete it again if you don't need it.`);
    else if (names) outcomes.push(`${namedList(names)} were deleted, but the copy still had them, so they're back. Delete them again if you don't need them.`);
    else outcomes.push(`${cameBack} deleted projects are back because the copy still had them. Delete them again if you don't need them.`);
  }

  // (c) Back in Recently deleted.
  if (backInTrash > 0) {
    const names = namesFor(backInTrashRows, backInTrash);
    if (names?.length === 1) outcomes.push(`${quoted(names[0])} is in Recently deleted again because the copy had it there. Restore it again if you need it.`);
    else if (names) outcomes.push(`${namedList(names)} are in Recently deleted again because the copy had them there. Restore them again if you need them.`);
    else outcomes.push(`${backInTrash} projects are in Recently deleted again because the copy had them there. Restore them again if you need them.`);
  }

  // The open canvas, saved as its own project (GM r3 string 1).
  const canvas = canvasSentence(restore);
  if (canvas) outcomes.push(canvas);

  // GM r3 string 4: a damaged file that wasn't read to its end (cut,
  // zeroed, or a key damaged): what it held past that is unknown. Only
  // where a damaged file was kept (a missing catalog has none to read).
  const readWhole = restore.damagedReadWhole === true;
  if (!readWhole && kept) outcomes.push(NOT_READ_WHOLE);
  const saidMore = liveAdded > 0 || outcomes.length > 0;
  if (!saidMore && readWhole) outcomes.push('No projects were missing.');
  // Only when the file really is kept AND something may be lost.
  const closing = kept && (failed > 0 || reverted > 0 || canvas !== null || !readWhole) ? KEPT : null;
  return layout(opening, outcomes, closing, trashedAdded.length > 0 || backInTrash > 0);
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
  & Partial<Pick<CatalogRestore, 'setAside' | 'notAddedBack' | 'damagedReadWhole'>>): string {
  const path = restore.damagedFile ?? restore.setAside?.[0] ?? null;
  if (restore.kind === 'rebuilt' || !restore.source) return rebuiltLogLine(restore, path);
  const sentences: string[] = [`Restored the project list from ${restore.source}.`];
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

/** GM r3 string 5: "Rebuilt the project list from the damaged file.
 * Recovered “Hero study”." then as needed "Couldn't recover “X”." /
 * "Couldn't read the whole file." / "The damaged file was kept at <path>."
 * Names to 3, counts from 4; Recently deleted's losses are logged too. */
function rebuiltLogLine(restore: Parameters<typeof catalogRestoreLogLine>[0], path: string | null): string {
  const sentences = ['Rebuilt the project list from the damaged file.'];
  const rows = restore.addedBack ?? [];
  const recovered = total(restore.addedBackCount, rows);
  if (recovered > 0) sentences.push(`Recovered ${logList(rows, recovered)}.`);
  const failedRows = restore.notAddedBack ?? [];
  const failed = total(restore.notAddedBackCount, failedRows);
  if (failed > 0) sentences.push(`Couldn't recover ${logList(failedRows, failed)}.`);
  if (restore.damagedReadWhole === false) sentences.push("Couldn't read the whole file.");
  if (path) sentences.push(`The damaged file was kept at ${path}.`);
  return sentences.join(' ');
}
