import { emptyAssetStudioEntry, useAssetStudioDraftStore, type AssetStudioDraftEntry, type CreateAttempt,
  type StudioFailure, type StudioRetry } from '../../store/assetStudioDraftStore';
import { BOARD_FIELD_KEYS, sameValue, type MoodboardOp } from '../../lib/moodboardEdits';
import { isOpShape } from './boardAdds';

/**
 * An unsaved board's draft, kept in this tab's session storage so a reload
 * doesn't lose it (round 6g, GM r15 3; review 9 lines-chip LOW-2). A new
 * board that failed to save says "Not saved" because nothing is lost; that
 * holds across a reload too: the next page load puts the draft back, images
 * and all, with its create id and attempts (a resend still makes no second
 * board) and its line, chip and Retry if it had them.
 *
 * As the waiting sends (boardAdds): session storage is per tab and lives
 * through a reload of it, so another tab never takes it; entries older than
 * a day or not shaped as a draft are dropped when read; storage that throws
 * keeps nothing. The page warns before unload only when the last write
 * failed (GM r15 3: only then would a reload lose the board). An image only
 * this page holds (a blob: or data: url, not uploaded yet) can't be kept;
 * its add goes with it.
 */
const UNSAVED_KEY = 'nebula:moodboard-unsaved-drafts';
const UNSAVED_MAX_AGE = 24 * 60 * 60 * 1000;
const UNSAVED_CAP = 10;

interface KeptAttempt { n: number; sent: number[]; asSent: Record<string, unknown> }
interface KeptDraft {
  key: string;
  draft: Record<string, unknown> & { images: unknown[]; pendingOps?: unknown[] };
  createRequestId?: string | null;
  attempts: KeptAttempt[];
  fieldEditedAt?: Record<string, number>;
  saveError: StudioFailure | null;
  retry: StudioRetry | null;
  failed: boolean;
  at: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const storableUrl = (url: unknown) => typeof url === 'string' && !/^(blob|data):/i.test(url);
const isFailure = (value: unknown): value is StudioFailure | null => value === null || typeof value === 'string'
  || (isRecord(value) && typeof value.heading === 'string' && typeof value.reason === 'string');

/** Whether `key` is an unsaved moodboard's draft key (its last part 'new'). */
export function isUnsavedBoardKey(key: string): boolean {
  try {
    const parts = JSON.parse(key) as unknown;
    return Array.isArray(parts) && parts[0] === 'moodboard' && parts[parts.length - 1] === 'new';
  } catch { return false; }
}

function readKept(): KeptDraft[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(UNSAVED_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    const now = Date.now();
    return parsed.filter((it): it is KeptDraft => isRecord(it) && typeof it.key === 'string' && isUnsavedBoardKey(it.key)
      && isRecord(it.draft) && typeof it.draft.name === 'string' && Array.isArray(it.draft.images)
      && it.draft.images.every((image) => isRecord(image) && typeof image.id === 'string' && storableUrl(image.url))
      && (it.draft.pendingOps === undefined || (Array.isArray(it.draft.pendingOps) && it.draft.pendingOps.every(isOpShape)))
      && Array.isArray(it.attempts) && it.attempts.every((attempt) => isRecord(attempt) && typeof attempt.n === 'number'
        && Array.isArray(attempt.sent) && attempt.sent.every((index) => typeof index === 'number') && isRecord(attempt.asSent))
      && (it.createRequestId === undefined || it.createRequestId === null || typeof it.createRequestId === 'string')
      && isFailure(it.saveError) && typeof it.failed === 'boolean'
      && typeof it.at === 'number' && now - it.at < UNSAVED_MAX_AGE);
  } catch { return []; }
}

/** Set when the last write threw: then (only then) the page asks before it unloads. */
let lastWriteFailed = false;

function writeKept(list: KeptDraft[]): void {
  try {
    if (list.length) window.sessionStorage.setItem(UNSAVED_KEY, JSON.stringify(list.slice(-UNSAVED_CAP)));
    else window.sessionStorage.removeItem(UNSAVED_KEY);
    lastWriteFailed = false;
  } catch {
    lastWriteFailed = list.length > 0;
  }
}

/** The entry as kept: its images that a later page load can show, the ops not on an image only this page held, its attempts' sent ops as indices. */
function keptOf(key: string, entry: AssetStudioDraftEntry): KeptDraft {
  const draft = entry.draft as Record<string, unknown> & { images: Array<{ url: unknown }>; pendingOps?: MoodboardOp[] };
  const images = draft.images.filter((image) => storableUrl(image.url));
  const ops = (draft.pendingOps ?? []).filter((op) => op.op !== 'add' || op.images.every((image) => storableUrl(image.url)));
  const attempts = (entry.createAttempts ?? []).map((attempt: CreateAttempt) => ({ n: attempt.n, asSent: attempt.asSent,
    sent: attempt.sent.map((op) => ops.indexOf(op as MoodboardOp)).filter((index) => index >= 0) }));
  return { key, draft: { ...draft, images, pendingOps: ops }, createRequestId: entry.createRequestId, attempts,
    fieldEditedAt: entry.fieldEditedAt, saveError: entry.saveState === 'error' ? entry.saveError : null,
    retry: entry.saveState === 'error' ? entry.retry ?? null : null, failed: entry.saveState === 'error', at: Date.now() };
}

/** Whether `entry` is an unsaved board worth keeping: loaded, not saved, with an image. */
function worthKeeping(entry: AssetStudioDraftEntry | undefined): entry is AssetStudioDraftEntry {
  return Boolean(entry && entry.loaded && !entry.savedId && ((entry.draft as { images?: unknown[] }).images?.length ?? 0) > 0);
}

const written = new Map<string, AssetStudioDraftEntry>();

/** Keep each unsaved board's draft in step with the store: written when it changes, dropped once it is saved, emptied or gone. */
function sync(entries: Record<string, AssetStudioDraftEntry>): void {
  syncEdits(entries);
  let changed = false;
  for (const [key, entry] of Object.entries(entries)) {
    if (!isUnsavedBoardKey(key)) continue;
    if (worthKeeping(entry) ? written.get(key) !== entry : written.has(key)) changed = true;
  }
  for (const key of written.keys()) if (!entries[key]) changed = true;
  if (!changed) return;
  // Kept entries this page never held stay; one it held whose draft is gone
  // (discarded, or handed over to its saved board) goes with it.
  const held = new Set(written.keys());
  written.clear();
  const others = readKept().filter((it) => !entries[it.key] && !held.has(it.key));
  const mine: KeptDraft[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (!isUnsavedBoardKey(key) || !worthKeeping(entry)) continue;
    written.set(key, entry);
    mine.push(keptOf(key, entry));
  }
  writeKept([...others, ...mine]);
}

/** Put each kept draft back in the store, under its key, unless that key holds a loaded draft already. */
export function restoreUnsavedDrafts(): void {
  const store = useAssetStudioDraftStore.getState();
  const entries = { ...store.entries };
  let restored = false;
  for (const kept of readKept()) {
    if (entries[kept.key]?.loaded) continue;
    const ops = (kept.draft.pendingOps ?? []) as MoodboardOp[];
    entries[kept.key] = {
      ...emptyAssetStudioEntry(kept.draft),
      loaded: true, dirty: true,
      saveState: kept.failed ? 'error' : 'draft',
      saveError: kept.failed ? kept.saveError : null,
      retry: kept.failed ? kept.retry ?? 'save' : null,
      createRequestId: kept.createRequestId,
      createAttempts: kept.attempts.map((attempt) => ({ n: attempt.n, asSent: attempt.asSent,
        sent: attempt.sent.map((index) => ops[index]).filter(Boolean) })),
      fieldEditedAt: kept.fieldEditedAt,
    };
    restored = true;
  }
  if (restored) useAssetStudioDraftStore.setState({ entries });
}

/** Whether a reload now would lose an unsaved board, or a saved board's kept edit: one is open and its last write to storage failed. */
export function unsavedWouldBeLost(): boolean {
  const entries = Object.entries(useAssetStudioDraftStore.getState().entries);
  return (lastWriteFailed && entries.some(([key, entry]) => isUnsavedBoardKey(key) && worthKeeping(entry)))
    || (lastEditsWriteFailed && entries.some(([key, entry]) => keptEditOf(key, entry) !== null));
}

let installed = false;
/** Restore kept drafts, then keep them in step with the store, and warn before unload only when a write failed. Once per page. */
export function keepUnsavedDrafts(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  restoreUnsavedDrafts();
  sync(useAssetStudioDraftStore.getState().entries);
  useAssetStudioDraftStore.subscribe((state) => sync(state.entries));
  window.addEventListener('beforeunload', (event) => {
    if (!unsavedWouldBeLost()) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

/** Tests: forget what this page wrote and installed. */
export function resetUnsavedDrafts(): void {
  written.clear();
  writtenEdits.clear();
  seenDrafts.clear();
  lastWriteFailed = false;
  lastEditsWriteFailed = false;
}

/**
 * A saved board's kept edit (round 6i, GM r17 2+3): what its draft holds that
 * the server doesn't have yet (a save that failed, one still out, one
 * waiting for Nebula), kept in this tab's session storage beside the unsaved
 * boards, so a reload doesn't lose it. Only the edit is kept, never the
 * board: its changed board fields (with the values they were changed from,
 * `base`, and when each was edited) and its queued ops. The board's next
 * load in this tab takes it (takeKeptEdit) and replays it on the board as
 * the server has it then, by the 6g rule (replayKeptFields). Gone once the
 * draft holds nothing unsent. Keyed by the board's id, so a project switch,
 * or the board moving, still finds it.
 *
 * Per tab, as everything here: a second tab on the same board keeps (and
 * replays) only its own edit; the server's version decides between them as
 * it does live. A duplicated tab copies session storage, so both copies
 * would replay it (the same Duplicate Tab follow-up as the reload records).
 */
export interface KeptEdit {
  board: string;
  /** The board's saved name (the draft's when it has none), to name the board if it's gone when the edit would replay (round 6j):
   *  the name Recently deleted and the rail show, not a rename that never saved. */
  name?: string;
  fields: Record<string, unknown>;
  base: Record<string, unknown>;
  fieldEditedAt?: Record<string, number>;
  ops: MoodboardOp[];
  /** Each op's KeptOpMeta, by index (null: not known, as for a record from before round 6l). */
  opMeta?: Array<KeptOpMeta | null>;
  at: number;
}
const EDITS_KEY = 'nebula:moodboard-kept-edits';

/**
 * When a queued op was made and what it changed from (round 6l, review 10
 * MEDIUM-1, GM r21 Q1), so a kept image change replays by the same rule as a
 * board field: the board still holding `from` takes it; one that changed the
 * image since keeps its own change unless the op came later (`at` against
 * the board's `updatedAt`). `from` is the image's value before the person's
 * first unsent change of it (its weight, set-aside, notes or private note,
 * a card's spot, or the board's cover); a `restore` (an Undo) records the
 * board `version` it was made against instead, and replays only on that
 * version.
 */
export interface KeptOpMeta { at: number; from?: unknown; version?: number }
const opMeta = new WeakMap<MoodboardOp, KeptOpMeta>();

/** The meta of `op`, a queued op this page saw made (or a kept one a load put back). */
export function keptOpMeta(op: MoodboardOp): KeptOpMeta | undefined {
  return opMeta.get(op);
}

/** A kept op a load put back in a draft keeps the time and from-value it was made with (a second reload replays it by them). */
export function rememberKeptOpMeta(op: MoodboardOp, meta: KeptOpMeta | null | undefined): void {
  if (meta) opMeta.set(op, meta);
}

type ImageLike = { id?: unknown; weight?: unknown; excluded?: unknown; notes?: unknown; privateNote?: unknown;
  placements?: Array<{ id?: unknown; x?: unknown; y?: unknown }> };
type DraftLike = { images?: ImageLike[]; coverImageId?: unknown; version?: unknown; pendingOps?: MoodboardOp[] };

/** What `op` sets, as one key per thing it changes (two ops with the same key change the same thing), or null for an add, a remove or an Undo. */
export function opTarget(op: MoodboardOp): string | null {
  switch (op.op) {
    case 'weight': return `weight:${op.image}`;
    case 'setAside': return `aside:${op.image}`;
    case 'note': return `note:${op.image}:${'notes' in op ? 'notes' : ''}:${'privateNote' in op ? 'private' : ''}`;
    case 'place': return `place:${op.placement}`;
    case 'cover': return 'cover';
    default: return null;
  }
}

/** The value `op`'s target has on `board` (a draft or a board as read), or undefined when the board has no such image or card. */
export function valueOnBoard(op: MoodboardOp, board: DraftLike): unknown {
  const image = 'image' in op ? board.images?.find((it) => it.id === op.image) : undefined;
  switch (op.op) {
    case 'weight': return image ? image.weight : undefined;
    case 'setAside': return image ? Boolean(image.excluded) : undefined;
    case 'note': return image ? {
      ...('notes' in op ? { notes: typeof image.notes === 'string' ? image.notes : '' } : {}),
      ...('privateNote' in op ? { privateNote: typeof image.privateNote === 'string' ? image.privateNote : '' } : {}),
    } : undefined;
    case 'place': {
      const card = board.images?.flatMap((it) => it.placements ?? []).find((it) => it.id === op.placement);
      return card ? { x: card.x, y: card.y } : undefined;
    }
    case 'cover': return board.coverImageId ?? null;
    default: return undefined;
  }
}

/** The value `op` sets, in valueOnBoard's form. */
export function valueOfOp(op: MoodboardOp): unknown {
  switch (op.op) {
    case 'weight': return op.value;
    case 'setAside': return Boolean(op.value);
    case 'note': return { ...('notes' in op ? { notes: op.notes ?? '' } : {}), ...('privateNote' in op ? { privateNote: op.privateNote ?? '' } : {}) };
    case 'place': return { x: op.x, y: op.y };
    case 'cover': return op.image;
    default: return undefined;
  }
}

/** The drafts this page last saw, by key: what an op that just appeared changed from. */
const seenDrafts = new Map<string, DraftLike>();

/** Stamp each queued op that just appeared in a board's draft: now, and its target's value in the draft before it
 *  (an earlier unsent op on the same target already holds the first from-value, which the board still has; so does
 *  one the queue just replaced: queueOps keeps one op per target, so a slider's second step replaces its first). */
function stampNewOps(entries: Record<string, AssetStudioDraftEntry>): void {
  for (const [key, entry] of Object.entries(entries)) {
    if (!isBoardKey(key)) continue;
    const draft = entry.draft as DraftLike;
    const before = seenDrafts.get(key);
    const queued = draft.pendingOps ?? [];
    const replaced = (before?.pendingOps ?? []).filter((op) => !queued.includes(op));
    const firstFrom = (ops: readonly MoodboardOp[], target: string) => ops.slice().reverse()
      .find((it) => opTarget(it) === target && opMeta.get(it) && 'from' in opMeta.get(it)!);
    queued.forEach((op, index) => {
      if (opMeta.has(op)) return;
      const at = Date.now();
      if (op.op === 'restore') {
        opMeta.set(op, typeof draft.version === 'number' ? { at, version: draft.version } : { at });
        return;
      }
      const target = opTarget(op);
      if (!target) { opMeta.set(op, { at }); return; }
      const earlier = firstFrom(queued.slice(0, index), target) ?? firstFrom(replaced, target);
      if (earlier) { opMeta.set(op, { at, from: opMeta.get(earlier)!.from }); return; }
      const from = before ? valueOnBoard(op, before) : undefined;
      opMeta.set(op, from === undefined ? { at } : { at, from });
    });
    seenDrafts.set(key, draft);
  }
  for (const key of [...seenDrafts.keys()]) if (!entries[key]) seenDrafts.delete(key);
}

/** Whether `key` is a moodboard draft key (of a saved or an unsaved board). */
const isBoardKey = (key: string) => {
  try { const parts = JSON.parse(key) as unknown; return Array.isArray(parts) && parts[0] === 'moodboard'; } catch { return false; }
};
/** A name is compared trimmed, as its save is (the server trims it). */
const fieldForm = (field: string, value: unknown) => (field === 'name' && typeof value === 'string' ? value.trim() : value);

/** The kept edit of the saved board at `key`: its unsent board fields and storable queued ops, or null when it holds none. */
export function keptEditOf(key: string, entry: AssetStudioDraftEntry | undefined): KeptEdit | null {
  if (!entry?.loaded || !entry.savedId || !isBoardKey(key) || isUnsavedBoardKey(key)) return null;
  const draft = entry.draft as Record<string, unknown> & { base?: Record<string, unknown>; pendingOps?: MoodboardOp[] };
  const base = draft.base ?? {};
  const fields: Record<string, unknown> = {};
  const from: Record<string, unknown> = {};
  if (draft.base) {
    for (const field of BOARD_FIELD_KEYS) {
      if (!(field in draft) || sameValue(fieldForm(field, draft[field]), fieldForm(field, base[field]))) continue;
      fields[field] = draft[field];
      from[field] = base[field];
    }
  }
  const ops = (draft.pendingOps ?? []).filter((op) => op.op !== 'add' || op.images.every((image) => storableUrl(image.url)));
  if (!ops.length && !Object.keys(fields).length) return null;
  const nameOf = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const name = nameOf(base.name) || nameOf(draft.name);
  return { board: entry.savedId, ...(name ? { name } : {}), fields, base: from, fieldEditedAt: entry.fieldEditedAt, ops,
    opMeta: ops.map((op) => opMeta.get(op) ?? null), at: Date.now() };
}

function readEdits(): KeptEdit[] {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(EDITS_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((it): it is KeptEdit => isRecord(it) && typeof it.board === 'string' && isRecord(it.fields) && isRecord(it.base)
      && (it.name === undefined || typeof it.name === 'string')
      && Object.keys(it.fields).every((field) => (BOARD_FIELD_KEYS as readonly string[]).includes(field))
      && (it.fieldEditedAt === undefined || (isRecord(it.fieldEditedAt) && Object.values(it.fieldEditedAt).every((at) => typeof at === 'number')))
      && Array.isArray(it.ops) && it.ops.every(isOpShape)
      && (it.opMeta === undefined || (Array.isArray(it.opMeta) && it.opMeta.length === it.ops.length && it.opMeta.every(isOpMeta)))
      // No age limit (round 6l, GM r21): a kept edit lives as long as its board, or its project, can be restored.
      && typeof it.at === 'number');
  } catch { return []; }
}

const isOpMeta = (meta: unknown) => meta === null || (isRecord(meta) && typeof meta.at === 'number'
  && (meta.version === undefined || typeof meta.version === 'number'));

/** Set when the last write of the kept edits threw: then (only then) the page asks before it unloads. */
let lastEditsWriteFailed = false;

function writeEdits(list: KeptEdit[]): void {
  try {
    // No cap either (round 6l): dropping the oldest would lose an edit silently. A write the storage
    // refuses sets the flag, and the page warns before it unloads.
    if (list.length) window.sessionStorage.setItem(EDITS_KEY, JSON.stringify(list));
    else window.sessionStorage.removeItem(EDITS_KEY);
    lastEditsWriteFailed = false;
  } catch {
    lastEditsWriteFailed = list.length > 0;
  }
}

/** The saved boards' entries this page last wrote, by draft key, and the board each was. */
const writtenEdits = new Map<string, { entry: AssetStudioDraftEntry; board: string }>();

/** Keep each saved board's kept edit in step with the store. A kept edit this page doesn't hold stays until its board's load takes it. */
function syncEdits(entries: Record<string, AssetStudioDraftEntry>): void {
  stampNewOps(entries);
  let changed = false;
  for (const [key, entry] of Object.entries(entries)) {
    if (!isBoardKey(key) || isUnsavedBoardKey(key)) continue;
    if (writtenEdits.has(key) ? writtenEdits.get(key)!.entry !== entry : keptEditOf(key, entry) !== null) changed = true;
  }
  for (const key of writtenEdits.keys()) if (!entries[key]) changed = true;
  if (!changed) return;
  const held = new Set([...writtenEdits.values()].map((it) => it.board));
  const loaded = new Set(Object.values(entries).filter((entry) => entry.loaded && entry.savedId).map((entry) => entry.savedId as string));
  writtenEdits.clear();
  const mine: KeptEdit[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    const kept = keptEditOf(key, entry);
    if (!kept) continue;
    writtenEdits.set(key, { entry, board: kept.board });
    mine.push(kept);
  }
  const ours = new Set(mine.map((it) => it.board));
  // One this page held whose board has nothing unsent now (saved) goes; one
  // from an earlier page load stays until its board loads and takes it.
  const others = readEdits().filter((it) => !ours.has(it.board) && !held.has(it.board) && !loaded.has(it.board));
  writeEdits([...others, ...mine]);
}

/** The kept edits earlier page loads of this tab left that this page doesn't hold: each waits for its board's load (round 6j: the Studio
 *  looks up their boards when it opens, to say so when one was deleted). */
export function keptEditsWaiting(): KeptEdit[] {
  const held = new Set([...writtenEdits.values()].map((it) => it.board));
  return readEdits().filter((it) => !held.has(it.board));
}

/** The boards with a kept edit in this tab: waiting from an earlier page load, or held in a draft here (round 6l: a Delete
 *  forever or Empty that takes one says so first, GM r21 Q2). */
export function keptEditBoards(): Set<string> {
  return new Set([...readEdits().map((it) => it.board), ...[...writtenEdits.values()].map((it) => it.board)]);
}

/** Forget the kept edit for `board` an earlier page load left (its board is gone for good, and the person has been told). */
export function dropKeptEdit(board: string): void {
  if ([...writtenEdits.values()].some((it) => it.board === board)) return;
  const list = readEdits();
  const left = list.filter((it) => it.board !== board);
  if (left.length !== list.length) writeEdits(left);
}

/** The kept edit an earlier page load of this tab left for `board`, taken once (null if none, or if this page holds the board's edit itself). */
export function takeKeptEdit(board: string): KeptEdit | null {
  if ([...writtenEdits.values()].some((it) => it.board === board)) return null;
  const list = readEdits();
  const found = list.find((it) => it.board === board) ?? null;
  if (found) writeEdits(list.filter((it) => it !== found));
  return found;
}

/**
 * The 6g rule for a kept edit replayed on the board as it is now (GM r17):
 * a field the board still holds as the edit found it takes the edit's value;
 * one the board changed since goes to the later edit, the edit's time
 * against the board's `updatedAt`. `kept` names each field where the
 * board's value won (the "Kept …" line). A field the board already holds
 * as the edit has it is left alone.
 */
export function replayKeptFields(kept: KeptEdit, board: Record<string, unknown>, boardUpdatedAt: number): { fields: Record<string, unknown>; kept: string[] } {
  const fields: Record<string, unknown> = {};
  const won: string[] = [];
  for (const [field, value] of Object.entries(kept.fields)) {
    if (sameValue(fieldForm(field, board[field]), fieldForm(field, value))) continue;
    if (sameValue(fieldForm(field, board[field]), fieldForm(field, kept.base[field])) || (kept.fieldEditedAt?.[field] ?? 0) > boardUpdatedAt) {
      fields[field] = value;
    } else won.push(field);
  }
  return { fields, kept: won };
}
