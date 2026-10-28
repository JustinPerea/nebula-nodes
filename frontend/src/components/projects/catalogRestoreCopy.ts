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

/** The limit the live canvas waits on (backend `canvasNotFiled.reason`):
 * the project limit, or the project list's size cap ("storage", never said
 * as a size: GM r4, "Never show 128 MB to the person"). */
export type CanvasLimit = 'projects' | 'storage';

/** What the limit lines need: the project limit's number (the backend's
 * `projectLimit`; 500), whether Recently deleted holds anything (only a
 * delete for good frees the size cap), and each canvas that waits (the
 * listing's `canvasNotFiled.canvases`: held ones and the live one, with the
 * name of the project it was when known; review 6 of PR #199, N-2). */
export interface CanvasLimitContext {
  projectLimit: number; trashHasItems: boolean;
  canvases?: { name?: string | null }[];
}

/** The backend's MAX_PROJECTS, for a listing that doesn't say it. */
export const DEFAULT_PROJECT_LIMIT = 500;

/** GM r5, the size cap's advice by whether Recently deleted has items. */
function sizeCapAdvice(trashHasItems: boolean): string {
  return trashHasItems
    ? 'Permanently delete a project in Recently deleted and Nebula will save it.'
    : 'Delete a project, then remove it from Recently deleted too, and Nebula will save it.';
}

/** GM r6: what every limit and waiting line says of the canvas. Never that
 * it "stays open": the Projects home can't show a canvas that isn't a
 * project, so the person can't reach it until it is saved (review 4, M-1;
 * GM dropped "Open canvas" for good). */
const NOTHING_LOST = 'Nothing in it is lost.';

/** The size cap's advice for several canvases (N-2; GM to confirm). */
function sizeCapAdviceMany(trashHasItems: boolean): string {
  return trashHasItems
    ? 'Permanently delete projects in Recently deleted and Nebula will save them.'
    : 'Delete projects, then remove them from Recently deleted too, and Nebula will save them.';
}

/** Who waits, for GM's (a) counting copy (review 6 of PR #199, N-2):
 * "The canvases you had open, “A” and “B”," with up to 3 names when every
 * name is known, else "2 canvases you had open". Null for one canvas: the
 * singular line, unchanged. */
function manyCanvases(context: CanvasLimitContext): string | null {
  const canvases = context.canvases ?? [];
  if (canvases.length < 2) return null;
  const names = canvases.map((canvas) => canvas.name);
  if (canvases.length <= RESTORE_NAMED_MAX && names.every((name): name is string => typeof name === 'string' && name.length > 0)) {
    return `The canvases you had open, ${namedList(names)},`;
  }
  return `${canvases.length} canvases you had open`;
}

const NOTHING_LOST_MANY = 'Nothing in them is lost.';

/** GM r5/r6, the limit lines: in the restore notice, in the canvas line's
 * place, while the open canvas couldn't be saved as its own project. The
 * canvas survives restarts, so both say nothing in it is lost. Several
 * canvases waiting are counted or named (N-2). */
export function canvasLimitLine(reason: CanvasLimit, context: CanvasLimitContext): string {
  const many = manyCanvases(context);
  if (many) {
    const opening = `${many} couldn't be saved as their own projects because`;
    if (reason === 'projects') {
      return `${opening} you've reached the limit of ${context.projectLimit} projects. ${NOTHING_LOST_MANY} Delete projects and Nebula will save them.`;
    }
    return `${opening} Nebula's project list is full. ${NOTHING_LOST_MANY} ${sizeCapAdviceMany(context.trashHasItems)}`;
  }
  const opening = "The canvas you had open couldn't be saved as its own project because";
  if (reason === 'projects') {
    return `${opening} you've reached the limit of ${context.projectLimit} projects. ${NOTHING_LOST} Delete a project and Nebula will save it.`;
  }
  return `${opening} Nebula's project list is full. ${NOTHING_LOST} ${sizeCapAdvice(context.trashHasItems)}`;
}

/** GM r5 (1)/r6, the waiting line: the Projects home's slim notice while
 * the canvas waits, whether or not a restore notice is open; it can't be
 * dismissed and goes once the canvas is saved. Several canvases waiting
 * (held aside, and the live one) are counted or named: GM's (a), "2
 * canvases you had open aren't saved as projects yet because…" (N-2). */
export function canvasWaitingLine(reason: CanvasLimit, context: CanvasLimitContext): string {
  const many = manyCanvases(context);
  if (many) {
    const opening = `${many} aren't saved as projects yet because`;
    if (reason === 'projects') {
      return `${opening} you've reached the limit of ${context.projectLimit} projects. ${NOTHING_LOST_MANY} Delete projects and Nebula will save them.`;
    }
    return `${opening} Nebula's project list is full. ${NOTHING_LOST_MANY} ${sizeCapAdviceMany(context.trashHasItems)}`;
  }
  const opening = "The canvas you had open isn't saved as a project yet because";
  if (reason === 'projects') {
    return `${opening} you've reached the limit of ${context.projectLimit} projects. ${NOTHING_LOST} Delete a project and Nebula will save it.`;
  }
  return `${opening} Nebula's project list is full. ${NOTHING_LOST} ${sizeCapAdvice(context.trashHasItems)}`;
}

/** The person's line when canvas-held.json couldn't be read and a canvas
 * held aside may be lost (the listing's `canvasHeldUnreadable`; review 6 of
 * PR #199, L-1). Default wording until GM answers. */
export function canvasHeldUnreadableLine(count: number | null | undefined): string {
  if (count === 1) {
    return "Nebula couldn't read a canvas you had open that was waiting to be saved, so it may be lost. The damaged file was kept.";
  }
  if (typeof count === 'number' && count > 1) {
    return `Nebula couldn't read ${count} canvases you had open that were waiting to be saved, so they may be lost. The damaged file was kept.`;
  }
  return "Nebula couldn't read the file that kept the canvases you had open, so some may be lost. The damaged file was kept.";
}

/** GM r6 (bug 3 and its addition): a restore from Recently deleted refused
 * by the project limit, from the Undo toast (in its place) or the list,
 * with the project's real name and the limit. */
export function restoreRefusedLine(name: string, projectLimit: number): string {
  return `Couldn't restore ${quoted(name)}. You've reached the limit of ${projectLimit} projects.`;
}

/** The backend's own verdict on a restore now (the listing's
 * `restoreRoom`, review 6 of PR #199, L-3): how many projects must be
 * deleted first (null: deleting can't make room), and whether the canvases
 * waiting to be saved hold the places the list has left. */
export interface RestoreRoom { refused: 'projects'; deletes: number | null; heldTakesPlace: boolean; waiting?: number }

/** GM r7: Restore in Recently deleted, disabled while the list is at its
 * project limit, says why in its tooltip, with the real limit. GM's answer
 * 3 to review 6: when a canvas waiting to be saved holds the last place,
 * "The canvas you had open is holding the last place.", and the number of
 * deletes is the real one (the next listing saves a waiting canvas into a
 * freed place first, so it can take 2). */
export function restoreAtLimitTooltip(projectLimit: number, room?: RestoreRoom | null): string {
  const deletes = room?.deletes ?? 1;
  const first = deletes === 1 ? 'You can restore it after you delete a project.'
    : `You can restore it after you delete ${deletes} projects.`;
  if (room?.heldTakesPlace) {
    const many = (room.waiting ?? 1) > 1;
    return `${first} ${many ? 'The canvases you had open are holding the last places.' : 'The canvas you had open is holding the last place.'}`;
  }
  return `${first} You've reached the limit of ${projectLimit} projects.`;
}

/** GM's held model (2026-10-28), the person's Agent log line when an
 * agent's write made Nebula hold the waiting canvas aside (``action``
 * "cleared", "replaced", or "changed" for any other write: review 6 of PR
 * #199, M-1; ``agent`` null: "An agent"). */
export function canvasHeldLogLine(agent: string | null | undefined, action: 'cleared' | 'replaced' | 'changed'): string {
  return `${agent || 'An agent'} ${action} the canvas. The one you had open is kept until Nebula can save it as a project.`;
}

/** GM round 5 and GM's answer 1 to review 6, the Agent log line when Nebula
 * refused an agent's write at the limit while the canvas waited (``action``
 * "clear", "replace", or "change" for any other write). */
export function canvasHoldRefusedLogLine(agent: string | null | undefined, action: 'clear' | 'replace' | 'change'): string {
  return `${agent || 'An agent'} tried to ${action} the canvas you had open. Nebula stopped it because that canvas isn't saved as a project yet.`;
}

/** GM r4/r5, the toast once a waiting canvas is saved: the project's real
 * name, and no "nothing in it is lost". GM's answer 2 to review 6: it names
 * each canvas it filed (up to 3; a count from 4). */
export function canvasSavedToast(name: string, filed?: { name: string }[] | null): string {
  const names = filed && filed.length > 1 ? filed.map((row) => row.name) : null;
  if (!names) return `The canvas you had open was saved as its own project, ${quoted(name)}.`;
  if (names.length > RESTORE_NAMED_MAX) return `${names.length} canvases you had open were saved as their own projects.`;
  return `The canvases you had open were saved as their own projects, ${namedList(names)}.`;
}

/** The projects and Recently deleted as they are now, and the canvas
 * waiting to be saved (the listing's `canvasNotFiled`): the notice says
 * only what still holds against them (GM r4's stale-lines rule). */
export interface NoticeNow {
  projects: { id: string; name: string }[];
  trash: { id: string; name?: string }[];
  canvasNotFiled?: { reason: CanvasLimit; projectLimit?: number; canvases?: { name?: string | null }[] } | null;
}

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
  /** Show "Open Recently deleted": Recently deleted holds one of the
   * notice's items (or the size cap's line asks to empty it). */
  openRecentlyDeleted: boolean;
  /** The notice's items Recently deleted holds now: the list opens to these. */
  recentlyDeletedIds: string[];
  /** What the canvas line says: saved, the limit it waits on, or nothing. */
  canvasLine: 'saved' | 'limit' | null;
}

/** The notice from its parts, always stacked: the opening, one outcome per
 * line, then the closing line, from the first render on, however many
 * remain as lines drop (GM round 5, 3; GM r6, bug 1: lines ran together as
 * one paragraph). */
function layout(opening: string, outcomes: string[], closing: string | null, openRecentlyDeleted: boolean,
  recentlyDeletedIds: string[] = [], canvasLine: CatalogRestoreNotice['canvasLine'] = null): CatalogRestoreNotice {
  const all = [opening, ...outcomes, ...(closing ? [closing] : [])];
  return { text: all.join(' '), lines: all, openRecentlyDeleted, recentlyDeletedIds, canvasLine };
}

/** Each row as it holds now (GM r4): ``where`` says where its line puts the
 * project ("projects", "trash", its own group by `trashed`, or "gone": in
 * neither). Without ``current`` every row holds (logs, older callers). */
type Where = 'projects' | 'trash' | 'own' | 'gone';
function holding<R extends { id?: string; trashed?: boolean }>(rows: R[] | undefined, where: Where, current?: NoticeNow): { rows: R[]; dropped: number } {
  const all = rows ?? [];
  if (!current) return { rows: all, dropped: 0 };
  const inProjects = new Set(current.projects.map((project) => project.id));
  const inTrash = new Set(current.trash.map((entry) => entry.id));
  const kept = all.filter((row) => {
    const id = row.id ?? '';
    if (where === 'gone') return !inProjects.has(id) && !inTrash.has(id);
    if (where === 'trash') return inTrash.has(id);
    if (where === 'projects') return inProjects.has(id);
    return row.trashed === true ? inTrash.has(id) : inProjects.has(id);
  });
  return { rows: kept, dropped: all.length - kept.length };
}

type NoticeInput = Pick<CatalogRestore, 'kind' | 'addedBack' | 'addedBackCount' | 'notAddedBackCount'>
  & Partial<Pick<CatalogRestore, 'source' | 'copyAt' | 'damagedFile' | 'setAside' | 'notAddedBack' | 'reverted'
    | 'revertedCount' | 'cameBack' | 'cameBackCount' | 'backInTrash' | 'backInTrashCount' | 'recoveredCanvas'
    | 'canvasNotFiled' | 'damagedReadWhole' | 'openProjectMissing'>>;

/** The open canvas's outcome (GM r3: the last outcome line before the
 * not-read-whole line), if any, as it holds now: the saved project under
 * its name now, dropped once it is gone; the limit line only while the
 * canvas still waits (the listing's `canvasNotFiled`, its limit now). */
function canvasOutcome(restore: NoticeInput, current?: NoticeNow): { line: string; kind: 'saved' | 'limit' } | null {
  const saved = restore.recoveredCanvas;
  if (saved) {
    if (!current) return { line: recoveredCanvasSentence(saved.name), kind: 'saved' };
    const now = current.projects.find((project) => project.id === saved.id) ?? current.trash.find((entry) => entry.id === saved.id);
    return now ? { line: recoveredCanvasSentence(now.name || saved.name), kind: 'saved' } : null;
  }
  const recorded = restore.canvasNotFiled?.reason;
  if (recorded !== 'projects' && recorded !== 'storage') return null;
  if (current && !current.canvasNotFiled) return null;
  const reason = current?.canvasNotFiled?.reason ?? recorded;
  return {
    line: canvasLimitLine(reason, {
      projectLimit: current?.canvasNotFiled?.projectLimit ?? DEFAULT_PROJECT_LIMIT,
      trashHasItems: (current?.trash.length ?? 0) > 0,
      canvases: current?.canvasNotFiled?.canvases,
    }),
    kind: 'limit',
  };
}

/** Whether a limit line asks the person to look in Recently deleted (the
 * size cap, GM r5: "Size cap reason adds the Open Recently deleted button"). */
function limitOpensTrash(restore: NoticeInput, canvas: { kind: string } | null, current?: NoticeNow): boolean {
  if (canvas?.kind !== 'limit') return false;
  const reason = current?.canvasNotFiled?.reason ?? restore.canvasNotFiled?.reason;
  return reason === 'storage' && (current?.trash.length ?? 0) > 0;
}

function rebuiltNotice(restore: NoticeInput, current?: NoticeNow): CatalogRestoreNotice {
  // GM: "Lost Recently deleted entries: not in the notice; log them."
  const all = (restore.notAddedBack ?? []).filter((row) => row.trashed !== true);
  const trashedRows = (restore.notAddedBack ?? []).length - all.length;
  const { rows, dropped } = holding(all, 'gone', current);
  const recorded = Math.max(0, (restore.notAddedBackCount ?? 0) - trashedRows);
  const lost = Math.max(0, recorded - dropped);
  const outcomes: string[] = [];
  if (recorded === 0) {
    outcomes.push("If a project you expect isn't here, it couldn't be recovered.");
  } else if (lost > 0) {
    const names = namesFor(rows, lost);
    const who = names ? namedList(names) : `${lost} ${lost === 1 ? 'project' : 'projects'}`;
    outcomes.push(`${who} couldn't be recovered, and others may be missing too.`);
  }
  const canvas = canvasOutcome(restore, current);
  if (canvas) outcomes.push(canvas.line);
  const opensTrash = limitOpensTrash(restore, canvas, current);
  return layout(REBUILT, outcomes, KEPT, opensTrash, [], canvas?.kind ?? null);
}

/** The notice for `restore`: GM's sentences in GM's order. With `current`
 * (the projects and Recently deleted now), only the lines that still hold
 * (GM r4): a project restored, deleted or deleted for good since drops its
 * line, live, as the person or an agent changes the list. What the notice
 * says around them (the copy's age, "The damaged file was kept.") follows
 * what the restore did, so when every outcome has gone the opening and
 * that line remain until the person closes it. */
export function catalogRestoreNotice(restore: NoticeInput, now: number = Date.now(), current?: NoticeNow): CatalogRestoreNotice {
  if (restore.kind === 'rebuilt') return rebuiltNotice(restore, current);
  const addedRows = restore.addedBack ?? [];
  const recordedTrashedAdded = addedRows.filter((row) => row.trashed === true);
  const recordedLiveAdded = Math.max(0, total(restore.addedBackCount, addedRows) - recordedTrashedAdded.length);
  const liveHeld = holding(addedRows.filter((row) => row.trashed !== true), 'projects', current);
  const liveAddedRows = liveHeld.rows;
  const liveAdded = Math.max(0, recordedLiveAdded - liveHeld.dropped);
  const trashedAdded = holding(recordedTrashedAdded, 'trash', current).rows;
  // The open project that couldn't be added back but whose canvas was saved
  // as its own project: the canvas sentence is its one sentence (GM r3), so
  // its failed add-back isn't said beside "so nothing in it is lost". The
  // Agent log still lists it.
  const savedFrom = restore.recoveredCanvas ? restore.openProjectMissing ?? null : null;
  const failedListed = (restore.notAddedBack ?? []).filter((row) => savedFrom === null || row.id !== savedFrom);
  const failedOut = (restore.notAddedBack ?? []).length - failedListed.length;
  const recordedFailed = Math.max(0, total(restore.notAddedBackCount, restore.notAddedBack) - failedOut);
  const failedHeld = holding(failedListed, 'gone', current);
  const failedRows = failedHeld.rows;
  const failed = Math.max(0, recordedFailed - failedHeld.dropped);
  // (a): the open project whose graph came back from the live canvas isn't
  // reverted for the person, and a project they deleted isn't news.
  const revertedListed = (restore.reverted ?? []).filter((row) => !row.liveCanvas && !row.trashed);
  const revertedOut = (restore.reverted ?? []).length - revertedListed.length;
  const recordedReverted = Math.max(0, total(restore.revertedCount, restore.reverted) - revertedOut);
  const revertedHeld = holding(revertedListed, 'projects', current);
  const revertedRows = revertedHeld.rows;
  const reverted = Math.max(0, recordedReverted - revertedHeld.dropped);
  const recordedCameBack = total(restore.cameBackCount, restore.cameBack);
  const cameBackHeld = holding(restore.cameBack, 'own', current);
  const cameBackRows = cameBackHeld.rows;
  const cameBack = Math.max(0, recordedCameBack - cameBackHeld.dropped);
  const recordedBackInTrash = total(restore.backInTrashCount, restore.backInTrash);
  const backInTrashHeld = holding(restore.backInTrash, 'trash', current);
  const backInTrashRows = backInTrashHeld.rows;
  const backInTrash = Math.max(0, recordedBackInTrash - backInTrashHeld.dropped);
  const kept = Boolean(restore.damagedFile) || (restore.setAside ?? []).length > 0;

  // GM: say the copy's age up front when the copy is the older one, or when
  // it decided something; unknown: the usual opening. No comma before it (GM r3).
  // As the restore decided it, so the opening stays put as lines drop.
  const older = restore.source === 'catalog.json.bak.1' || recordedReverted > 0 || recordedCameBack > 0 || recordedBackInTrash > 0;
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

  // The open canvas, saved as its own project (GM r3 string 1), or the
  // limit it waits on (GM r5).
  const canvas = canvasOutcome(restore, current);
  if (canvas) outcomes.push(canvas.line);

  // GM r3 string 4: a damaged file that wasn't read to its end (cut,
  // zeroed, or a key damaged): what it held past that is unknown. Only
  // where a damaged file was kept (a missing catalog has none to read).
  const readWhole = restore.damagedReadWhole === true;
  if (!readWhole && kept) outcomes.push(NOT_READ_WHOLE);
  // "No projects were missing." only when the restore had nothing else to
  // say, never because the other lines have since gone.
  const saidAtFirst = recordedLiveAdded > 0 || recordedTrashedAdded.length > 0 || recordedFailed > 0
    || recordedReverted > 0 || recordedCameBack > 0 || recordedBackInTrash > 0
    || Boolean(restore.recoveredCanvas) || Boolean(restore.canvasNotFiled) || (!readWhole && kept);
  if (!saidAtFirst && readWhole) outcomes.push('No projects were missing.');
  // Only when the file really is kept AND something may be lost (as the
  // restore found it: it stays when the lines that called for it go).
  const closing = kept && (recordedFailed > 0 || recordedReverted > 0 || Boolean(restore.recoveredCanvas)
    || Boolean(restore.canvasNotFiled) || !readWhole) ? KEPT : null;
  // "Open Recently deleted" while Recently deleted holds one of the notice's
  // items, and opens to them (GM r4); the size cap's line adds it too (GM r5).
  const recentlyDeletedIds = current
    ? [...trashedAdded.map((row) => row.id), ...backInTrashRows.map((row) => row.id)]
    : [];
  const openRecentlyDeleted = current
    ? recentlyDeletedIds.length > 0 || limitOpensTrash(restore, canvas, current)
    : trashedAdded.length > 0 || backInTrash > 0;
  return layout(opening, outcomes, closing, openRecentlyDeleted, recentlyDeletedIds, canvas?.kind ?? null);
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
