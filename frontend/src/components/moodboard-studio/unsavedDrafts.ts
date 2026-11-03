import { emptyAssetStudioEntry, useAssetStudioDraftStore, type AssetStudioDraftEntry, type CreateAttempt,
  type StudioFailure, type StudioRetry } from '../../store/assetStudioDraftStore';
import type { MoodboardOp } from '../../lib/moodboardEdits';
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

/** Whether a reload now would lose an unsaved board: one is open and its last write to storage failed. */
export function unsavedWouldBeLost(): boolean {
  return lastWriteFailed && Object.entries(useAssetStudioDraftStore.getState().entries)
    .some(([key, entry]) => isUnsavedBoardKey(key) && worthKeeping(entry));
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
  lastWriteFailed = false;
}
