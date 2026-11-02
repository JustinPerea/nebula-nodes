import { create } from 'zustand';
import type { MoodboardImage } from '../../types';
import { resolveAssetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import type { MoodboardOp } from '../../lib/moodboardEdits';
import type { BoardPlaceholder } from './boardPlaceholder';

/**
 * Adds in flight, kept per board rather than in the open Studio (GM on
 * review 4: an add whose person left the board mid-upload isn't dropped, it
 * lands on that board). Client-only: never in a draft, never saved, never sent.
 *
 * A board is named by its draft instance, not its draft key (review 5,
 * MEDIUM-1): every unsaved board shares the key "new", and New or a delete
 * resets that key for a fresh draft. So each add holds a `BoardRef`: the key,
 * the draft's epoch (a reset bumps it, a copy keeps it) and, once the board
 * is saved, its id. When a draft is copied to another key (its first save,
 * a move) the ref follows it at once, so a later reset of the old key can't
 * send the add to the fresh draft.
 */
export interface BoardRef {
  key: string;
  epoch: number;
  savedId: string | null;
}

const draftState = () => useAssetStudioDraftStore.getState();
const resolve = (key: string) => resolveAssetStudioDraftKey(draftState(), key);

/** The board the draft at `key` is now. */
export function boardRefOf(key: string): BoardRef {
  const resolved = resolve(key);
  const entry = draftState().entries[resolved];
  return { key: resolved, epoch: entry?.epoch ?? 0, savedId: entry?.savedId ?? null };
}

/** True when the draft at `key` is the board `ref` names: the same draft
 *  instance, or (a saved board, reopened after its draft was reset, as after
 *  an undone delete) the same saved board. */
export function isBoard(ref: BoardRef | undefined, key: string): boolean {
  if (!ref) return false;
  const resolved = resolve(key);
  if (resolved !== ref.key) return false;
  const entry = draftState().entries[resolved];
  if (!entry) return false;
  return entry.epoch === ref.epoch || (ref.savedId !== null && entry.savedId === ref.savedId);
}

/** True when two refs name one board. */
export function sameBoard(a: BoardRef, b: BoardRef): boolean {
  return a.key === b.key && (a.epoch === b.epoch || (a.savedId !== null && a.savedId === b.savedId));
}

/** Where `ref`'s board stands: its draft is still here (`draft`), only its
 *  saved board is left (`saved`), or it is gone (a discarded unsaved draft). */
export function boardStanding(ref: BoardRef): 'draft' | 'saved' | 'gone' {
  const entry = draftState().entries[resolve(ref.key)];
  if (entry && entry.epoch === ref.epoch) return 'draft';
  return ref.savedId ? 'saved' : 'gone';
}

// Every ref an add or a held spot holds, followed as drafts move.
const refs = new Set<BoardRef>();
let following = false;
function follow() {
  if (following) return;
  following = true;
  useAssetStudioDraftStore.subscribe((state) => {
    let moved = false;
    const held = useBoardAddStore.getState().held.flatMap((holder) => (holder.board ? [holder.board] : []));
    for (const ref of new Set([...refs, ...held])) {
      const to = resolveAssetStudioDraftKey(state, ref.key);
      const entry = state.entries[to];
      // Copied on (an alias appeared): the same draft, at its new key.
      if (to !== ref.key && entry?.epoch === ref.epoch) { ref.key = to; moved = true; }
      // Its first save landed: the board has an id now.
      const here = state.entries[ref.key];
      if (here && here.epoch === ref.epoch && here.savedId && here.savedId !== ref.savedId) {
        ref.savedId = here.savedId;
        moved = true;
        recordSaved(ref);
      }
    }
    // The held spots read their refs: redraw.
    if (moved) useBoardAddStore.setState((current) => ({ held: [...current.held] }));
  });
}

/** A ref for an add made now on the board at `key`, followed until `drop`ped. */
export function trackBoard(key: string): BoardRef {
  follow();
  const ref = boardRefOf(key);
  refs.add(ref);
  return ref;
}
export function untrackBoard(ref: BoardRef) { refs.delete(ref); }

/** True while an add is on its way to the board the draft at `key` is now. */
export function addsInFlight(key: string): boolean {
  return [...refs].some((ref) => isBoard(ref, key) && boardStanding(ref) === 'draft');
}

/**
 * Adds on their way, by board, in this tab's session storage (GM r8 answer
 * 5, r10 answer 2): a reload mid-upload loses them, so the next open of that
 * board in this tab says so, once. Session storage is per tab and lives
 * through a reload of it, so another tab never sees or takes them (review 6,
 * MEDIUM-2). Each entry goes when its add lands or fails; one left by an
 * earlier page load is one the reload lost. An add on a board not saved yet
 * is kept here in memory and written under the board's id once its first
 * save gives it one (review 6, LOW-3; GM r10 answer 1): the line shows on
 * that board, and only there. Entries older than a day are dropped when
 * read, and the list is capped (review 6, NIT-6). With no storage, nothing
 * is kept and nothing said.
 */
const PENDING_KEY = 'nebula:moodboard-adds-in-flight';
const PENDING_MAX_AGE = 24 * 60 * 60 * 1000;
const PENDING_CAP = 50;
const PAGE = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());
interface PendingAdd { id: string; board: string; name: string; page: string; at: number }
function readPending(): PendingAdd[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(PENDING_KEY) ?? '[]') as unknown;
    const now = Date.now();
    return Array.isArray(parsed) ? parsed.filter((it): it is PendingAdd => typeof it?.id === 'string' && typeof it?.board === 'string'
      && typeof it?.name === 'string' && typeof it?.page === 'string' && typeof it?.at === 'number'
      && now - it.at < PENDING_MAX_AGE) : [];
  } catch { return []; }
}
/** The list within the cap: earlier page loads' records go first, oldest
 *  first; this page's never do, since their uploads are still running
 *  (review 7, NIT-4). */
function capped<T extends { page: string }>(list: T[], cap: number): T[] {
  let drop = list.length - Math.max(cap, list.filter((it) => it.page === PAGE).length);
  return drop <= 0 ? list : list.filter((it) => it.page === PAGE || (drop -= 1) < 0);
}
function writePending(list: PendingAdd[]) {
  try {
    if (list.length) window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(capped(list, PENDING_CAP)));
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch { /* no storage: nothing kept */ }
}
// Adds on boards not saved yet, by board, until the board has an id.
const unsavedPending = new Map<BoardRef, Array<{ id: string; name: string; at: number }>>();
/** Files on their way to the board `board` names, by holder id. */
export function recordPending(board: BoardRef, files: Array<{ id: string; name: string }>) {
  if (!files.length) return;
  const at = Date.now();
  if (board.savedId) {
    const id = board.savedId;
    writePending([...readPending(), ...files.map((file) => ({ ...file, board: id, page: PAGE, at }))]);
  } else {
    unsavedPending.set(board, [...(unsavedPending.get(board) ?? []), ...files.map((file) => ({ ...file, at }))]);
  }
}
/** `ref`'s board has its id now: its adds on their way are written under it. */
function recordSaved(ref: BoardRef) {
  const files = unsavedPending.get(ref);
  if (!files || !ref.savedId) return;
  unsavedPending.delete(ref);
  const id = ref.savedId;
  writePending([...readPending(), ...files.map((file) => ({ ...file, board: id, page: PAGE }))]);
}
// A page going away (a reload, a close) cuts its uploads short, and the
// browser can still run their failure on the way out: those adds didn't
// end, so their records stay for the next load to say (GM r8 answer 5).
let leaving = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { leaving = true; });
  window.addEventListener('pageshow', () => { leaving = false; });
}
/** The adds `ids` name have ended (landed, failed or cancelled). */
export function clearPending(ids: Iterable<string>) {
  if (leaving) return;
  const gone = new Set(ids);
  for (const [ref, files] of unsavedPending) {
    const kept = files.filter((file) => !gone.has(file.id));
    if (kept.length) unsavedPending.set(ref, kept); else unsavedPending.delete(ref);
  }
  const list = readPending();
  const kept = list.filter((it) => !(gone.has(it.id) && it.page === PAGE));
  if (kept.length !== list.length) writePending(kept);
}
/** The names of `board`'s adds an earlier page load left on their way (lost to a reload), taken once. */
export function takeReloadLost(board: string): string[] {
  const list = readPending();
  const lost = list.filter((it) => it.board === board && it.page !== PAGE);
  if (lost.length) writePending(list.filter((it) => !lost.includes(it)));
  return lost.map((it) => it.name);
}

/**
 * A board's background send waiting for Nebula to come back (GM r11 4): the
 * queued send of a board New just saved, or an add that couldn't reach a
 * board the person had left, refused while offline. It waits and is sent
 * again on reconnect; meanwhile it is kept in this tab's session storage
 * beside the adds on their way, so a reload of the tab doesn't lose it: the
 * board's next open in this tab takes it back into its draft, which sends
 * it. An image only this page holds (not uploaded yet) can't be kept: the
 * reload line names it, as for an upload a reload cut short.
 */
const WAITING_KEY = 'nebula:moodboard-sends-waiting';
interface WaitingSend { board: string; ops: MoodboardOp[]; fields: Record<string, unknown>; page: string; at: number }
function readWaiting(): WaitingSend[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(WAITING_KEY) ?? '[]') as unknown;
    const now = Date.now();
    return Array.isArray(parsed) ? parsed.filter((it): it is WaitingSend => typeof it?.board === 'string' && Array.isArray(it?.ops)
      && typeof it?.fields === 'object' && it.fields !== null && typeof it?.page === 'string' && typeof it?.at === 'number'
      && now - it.at < PENDING_MAX_AGE) : [];
  } catch { return []; }
}
function writeWaiting(list: WaitingSend[]) {
  try {
    if (list.length) window.sessionStorage.setItem(WAITING_KEY, JSON.stringify(capped(list, PENDING_CAP)));
    else window.sessionStorage.removeItem(WAITING_KEY);
  } catch { /* no storage: nothing kept */ }
}
/** An image a later page load can still add: one on Nebula's server. */
const storableUrl = (url: string) => !/^(blob|data):/i.test(url);
const nameOf = (url: string) => {
  const last = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? url;
  try { return decodeURIComponent(last); } catch { return last; }
};
const lostId = (board: string) => `waiting:${board}:`;
/** The saved board `board`'s send waits for Nebula: kept for a reload of this tab, in place of what was kept for it before. */
export function keepWaitingSend(board: string, ops: readonly MoodboardOp[], fields: Record<string, unknown>) {
  const kept: MoodboardOp[] = [];
  const lost: string[] = [];
  for (const op of ops) {
    if (op.op === 'add' && op.images.some((image) => !storableUrl(image.url))) lost.push(...op.images.map((image) => nameOf(image.url)));
    else kept.push(op);
  }
  const at = Date.now();
  writeWaiting([...readWaiting().filter((it) => !(it.board === board && it.page === PAGE)),
    ...(kept.length || Object.keys(fields).length ? [{ board, ops: kept, fields, page: PAGE, at }] : [])]);
  const prefix = lostId(board);
  writePending([...readPending().filter((it) => !(it.page === PAGE && it.id.startsWith(prefix))),
    ...lost.map((name, index) => ({ id: `${prefix}${index}`, board, name, page: PAGE, at }))]);
}
/** `board`'s waiting send went (or there is nothing to send any more). */
export function dropWaitingSend(board: string) {
  const list = readWaiting();
  const kept = list.filter((it) => !(it.board === board && it.page === PAGE));
  if (kept.length !== list.length) writeWaiting(kept);
  const prefix = lostId(board);
  const pending = readPending();
  const left = pending.filter((it) => !(it.page === PAGE && it.id.startsWith(prefix)));
  if (left.length !== pending.length) writePending(left);
}
/** What an earlier page load of this tab left waiting for `board`, taken once: its ops in order, and its fields. */
export function takeWaitingSend(board: string): { ops: MoodboardOp[]; fields: Record<string, unknown> } | null {
  const list = readWaiting();
  const mine = list.filter((it) => it.board === board && it.page !== PAGE);
  if (!mine.length) return null;
  writeWaiting(list.filter((it) => !mine.includes(it)));
  return { ops: mine.flatMap((it) => it.ops), fields: Object.assign({}, ...mine.map((it) => it.fields)) as Record<string, unknown> };
}

interface BoardAddsState {
  /** Every spot and List row held, each with its board. */
  held: BoardPlaceholder[];
}

export const useBoardAddStore = create<BoardAddsState>(() => ({ held: [] }));

/** Held spots' ids, unique across every board. */
let holderSeq = 0;
export function nextHolderId(): string {
  holderSeq += 1;
  return `placeholder-${holderSeq}`;
}

/** Nothing held (tests). Ids keep counting, as in a page: a fade's late
 *  release left by one test can never take a later test's spot. */
export function resetBoardAdds() {
  openBoard = null;
  refs.clear();
  unsavedPending.clear();
  claims.length = 0;
  turn = Promise.resolve();
  useBoardAddStore.setState({ held: [] });
}

/** Every spot and row held on the board `key` names now. */
export function heldOn(held: readonly BoardPlaceholder[], key: string): BoardPlaceholder[] {
  return held.filter((holder) => isBoard(holder.board, key));
}

/** Hold `holders` (each with its board). */
export function addHeld(holders: BoardPlaceholder[]) {
  if (holders.length) useBoardAddStore.setState((state) => ({ held: [...state.held, ...holders] }));
}

/** Change the held spots `ids` name. */
export function changeHeld(ids: Iterable<string>, change: (holder: BoardPlaceholder) => BoardPlaceholder) {
  const which = new Set(ids);
  if (which.size === 0) return;
  useBoardAddStore.setState((state) => ({ held: state.held.map((holder) => (which.has(holder.id) ? change(holder) : holder)) }));
}

/** The holders `ids` name, gone. */
export function releaseHeld(ids: Iterable<string>) {
  const gone = new Set(ids);
  if (gone.size === 0) return;
  useBoardAddStore.setState((state) => ({ held: state.held.filter((holder) => !gone.has(holder.id)) }));
}

/** Of the holders `ids` name, the filled ones (their image has faded in), gone. */
export function releaseFilled(ids: Iterable<string>) {
  const gone = new Set(ids);
  useBoardAddStore.setState((state) => ({ held: state.held.filter((holder) => !(gone.has(holder.id) && holder.filled)) }));
}

/** The board open in the Studio now, and how it takes an add as its own
 *  step (with its undo). Null while no board is open. */
export interface OpenBoard {
  key: string;
  /** Adds the ops as one step of the open board (sent at once with `now`); false if it can't take them now. */
  commit: (ops: MoodboardOp[], label: string, aspects: Record<string, number>, now: boolean) => boolean;
}
let openBoard: OpenBoard | null = null;

export function setOpenBoard(board: OpenBoard) { openBoard = board; }
export function clearOpenBoard(board: OpenBoard) { if (openBoard === board) openBoard = null; }
/** The open Studio is on the board `key` names (an alias resolves to it). */
export function isOpenBoard(key: string): boolean {
  return openBoard !== null && resolve(openBoard.key) === resolve(key);
}
/** The open board, if it is the board `ref` names. */
export function openBoardFor(ref: BoardRef): OpenBoard | null {
  return openBoard && isBoard(ref, openBoard.key) ? openBoard : null;
}

/** The images of the board `key` names, as its draft holds them. */
export function boardImages(key: string): MoodboardImage[] {
  const draft = draftState().entries[resolve(key)]?.draft as { images?: MoodboardImage[] } | undefined;
  return draft?.images ?? [];
}

/**
 * The paste backstop (GM r4 answer 7), per board (GM r8 answer 3): a file
 * identical (by size, type and bytes hash) to one still being added to the
 * same board is ignored there; the same image on another board goes. Kept
 * here, not in the Studio, so it holds across a board switch or the Studio
 * closing and opening again. Adds take turns: each one's files are checked
 * only after the add before it has claimed its own.
 */
const claims: Array<{ signature: string; board: BoardRef }> = [];
let turn: Promise<unknown> = Promise.resolve();

/** Claims `signatures` for `board` in turn; resolves to which of them were free (already being added there: false). */
export function claimFiles(board: BoardRef, signatures: () => Promise<string[]>): Promise<{ free: boolean[]; release: () => void }> {
  const claim = turn.then(async () => {
    const list = await signatures();
    const taken = (signature: string) => claims.some((it) => it.signature === signature && sameBoard(it.board, board));
    const mine: Array<{ signature: string; board: BoardRef }> = [];
    const free = list.map((signature) => {
      if (taken(signature)) return false;
      mine.push({ signature, board });
      return true;
    });
    claims.push(...mine);
    const release = () => { for (const it of mine) { const at = claims.indexOf(it); if (at >= 0) claims.splice(at, 1); } };
    return { free, release };
  });
  turn = claim.catch(() => undefined);
  return claim;
}
