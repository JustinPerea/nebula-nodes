import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import {
  analyzeMoodboard,
  createMoodboard,
  editMoodboard,
  type MoodboardCreated,
  fetchMoodboard,
  fetchMoodboards,
  keepMoodboardBriefOverride,
  lookupStoredAsset,
  updateMoodboard,
} from '../../lib/api';
import { RecentlyDeletedAssets, UndoDeleteToast, type TrashOpenRequest } from '../asset-trash/AssetTrash';
import { useAssetDelete } from '../../hooks/useAssetDelete';
import { apiRequest } from '../../lib/apiRequest';
import { failureCopy, failureMessage, isBackendUnreachable, type FailureCopy } from '../../lib/errorCopy';
import { isOfflineRefusal, probeOffline, waitUntilOnline } from '../../lib/backendConnection';
import { useBackendOffline } from '../../lib/useBackendOffline';
import { placeholderLabel } from './boardPlaceholder';
import { boardSaveLine, deletedBoardsLine, restoredBoardsLine, isBoardNotSavedLine, isCreateIdRefusal, isLostAddLine, keptFromBoardLine, lostAddLine } from './boardSaveLine';
import { dropKeptEdit, keepUnsavedDrafts, keptEditsWaiting, replayKeptFields, takeKeptEdit, type KeptEdit } from './unsavedDrafts';
import { restoreTrashed } from '../../lib/trash';
import { FailureLines } from '../failure/FailureLines';
import { storedImageView } from '../../lib/storedImage';
import { OutsideImageNote } from '../OutsideImageNote';
import { WorkspaceHeader } from '../WorkspaceHeader';
import { useAssetStudioDraft } from '../../hooks/useAssetStudioDraft';
import { useOfflineHiddenNotice } from '../../hooks/useOfflineHiddenNotice';
import { assetStudioDraftKey, resolveAssetStudioDraftKey, useAssetStudioDraftStore, type AssetStudioDraftEntry } from '../../store/assetStudioDraftStore';
import { NEW_MOODBOARD_SENTINEL } from '../../lib/studioSentinels';
import { NO_PROJECT_OPEN, currentProject, useCurrentProject } from '../../lib/currentProject';
import { useProjectName } from '../../hooks/useProjectName';
import type { AssetScope } from '../../store/uiStore';
import type { Moodboard, MoodboardAnalysis, MoodboardBrief, MoodboardClashMode, MoodboardImage, MoodboardPinnedColors,
  MoodboardPlacement } from '../../types';
import { BriefFields, BriefPanel, type ColorChoice } from './MoodboardBrief';
import { AnalysisOutdated, BoardSwatches, SourcesOutdated } from './MoodboardColors';
import { overrideAuthor } from './briefAuthor';
import { AutoGrowTextarea } from '../AutoGrowTextarea';
import { assetHome, emptyRailMessage, railNotice, type AssetHome } from '../../lib/assetHome';
import { wsClient } from '../../lib/wsClient';
import { AssetProposalStrip } from '../proposals/AssetProposalStrip';
import { moveChoices, type MoveChoice } from '../../lib/assetMove';
import { useStudioAssetMove } from '../../hooks/useStudioAssetMove';
import { AssetMoveMenu } from '../asset-move/AssetMoveMenu';
import { patchSteers } from './steering';
import { moodboardImagesLabel, setAsideCount } from '../../lib/moodboardCount';
import { BOARD_FIELD_KEYS, MoodboardVersionConflict, applyOps, imagePatchOps, opKey, opSteers, queueOps, rebaseDraft, sameValue, sendableBatch,
  fieldChanges, type BoardFieldKey, type MoodboardEditResult, type MoodboardOp } from '../../lib/moodboardEdits';
import { TAB_ID } from '../../lib/tabId';
import { batchesOf, useBoardUndoStore, type BoardUndoStep } from '../../lib/boardUndo';
import { provisionalForCreate, readImageAspect } from '../../lib/boardDrop';
import { outsideForChip, placeTiles, respot, spotFree, type SeenArea } from '../../lib/boardPlacement';
import type { NodeRect } from '../../lib/nodePlacement';
import { sizeFor } from '../../lib/moodboardLayout';
import { useBoardCanvasStore, useBoardSelection, type MoodboardView } from '../../store/boardCanvasStore';
import { BoardCanvas, type BoardMove, type BoardPlaceholder, type BoardTarget, type OutsideTiles } from './BoardCanvas';
import { BoardSidePanel } from './BoardSidePanel';
import { useHoldBottom } from './useHoldBottom';
import { BoardUndoToast, type BoardToast } from './BoardUndoToast';
import { ALREADY_BEING_ADDED, LINKS_NOT_ADDED, NOTHING_TO_PASTE, fileSignature, isStudioPasteTarget, readClipboardImages, reloadLostLine } from './pasteImages';
import { MoodboardListView } from './MoodboardListView';
import { addHeld, addsInFlight, boardImages, clearPending, recordPending, takeReloadLost, boardStanding, changeHeld, claimFiles, clearOpenBoard, createsWaited, heldOn, nextHolderId,
  dropWaitingSend, isOpenBoard, keepWaitingSend, openBoardFor, releaseFilled, releaseHeld, setOpenBoard, takeWaitingSend, trackBoard, untrackBoard, useBoardAddStore,
  type BoardRef, type OpenBoard } from './boardAdds';
import { selectedImageIds } from './boardNodes';
import { isStudioShortcutTarget, studioKey } from './studioKeys';
import { boardCover } from '../../lib/moodboardCover';
import { FieldStepTracker, fieldGroups, fieldStepKeys, type FieldStep } from './fieldSteps';
import '../../styles/moodboard-studio.css';
import '../../styles/moodboard-board.css';
import { NoticeLeave } from '../../lib/noticeLeave';

/** A filled placeholder goes after this long even when no board ran its fade. */
const FILL_FALLBACK_MS = 3000;

interface MoodboardDraft {
  name: string;
  images: MoodboardImage[];
  notes: string;
  mode: Moodboard['mode'];
  strength: number;
  analysis: MoodboardAnalysis | null;
  // The person's brief fields live on the board, beside the analysis, so
  // analyzing again (or a board change that clears the analysis) keeps them.
  direction: string;
  avoid: string[];
  pinnedColors: MoodboardPinnedColors;
  /** Only the text is sent; the server keeps when it was written. */
  briefOverride: { text: string } | null;
  // Gap 18: what a clash does, the person's Keep anyway / Leave out, and
  // whether the notes reach generators. None of them feed the analysis.
  // Absent in a draft kept from before they existed, so it never sends them.
  clashMode?: MoodboardClashMode;
  colorChoices?: { keep: string[]; leaveOut: string[] };
  sendNotes?: boolean;
  projectId?: string;
  // The image the board opens on (lib/moodboardCover): the board's, with a
  // queued `cover` op on top. Changed only through that op, never a PUT.
  coverImageId?: string | null;
  // A saved board's checked edits (lib/moodboardEdits): its board fields as
  // last read, that board's version, and the image ops not yet confirmed.
  // Never sent as they are.
  base?: Partial<Record<BoardFieldKey, unknown>>;
  version?: number;
  pendingOps?: MoodboardOp[];
}

function emptyDraft(): MoodboardDraft {
  return {
    name: 'Untitled Moodboard',
    images: [],
    notes: '',
    mode: 'look',
    strength: 0.7,
    analysis: null,
    direction: '',
    avoid: [],
    pinnedColors: { include: [], exclude: [] },
    briefOverride: null,
    clashMode: 'leave-out',
    colorChoices: { keep: [], leaveOut: [] },
    sendNotes: false,
    coverImageId: null,
  };
}

// Board fields only: the layout (frames, layoutVersion, ...) is never sent
// back, since the backend refuses it on a save. Images keep their
// placements, which a new board's first save sends.
function moodboardFields(m: Moodboard): Omit<MoodboardDraft, 'base' | 'version' | 'pendingOps'> {
  return {
    name: m.name,
    images: [...m.images],
    notes: m.notes,
    mode: m.mode,
    strength: m.strength,
    analysis: m.analysis,
    direction: m.direction ?? '',
    avoid: [...(m.avoid ?? [])],
    pinnedColors: { include: [...(m.pinnedColors?.include ?? [])], exclude: [...(m.pinnedColors?.exclude ?? [])] },
    briefOverride: m.briefOverride?.text ? { text: m.briefOverride.text } : null,
    clashMode: m.clashMode ?? 'leave-out',
    colorChoices: { keep: [...(m.colorChoices?.keep ?? [])], leaveOut: [...(m.colorChoices?.leaveOut ?? [])] },
    sendNotes: m.sendNotes === true,
    projectId: m.projectId,
    coverImageId: m.coverImageId ?? null,
  };
}

/** The board fields of a board as a draft holds them, to compare with one. */
function boardFieldsOf(m: Moodboard): Partial<Record<BoardFieldKey, unknown>> {
  const fields = moodboardFields(m) as Record<string, unknown>;
  return Object.fromEntries(BOARD_FIELD_KEYS.map((key) => [key, fields[key]]));
}

function moodboardToDraft(m: Moodboard): MoodboardDraft {
  return { ...moodboardFields(m), base: boardFieldsOf(m), version: m.version, pendingOps: [] };
}

/** `draft` moved onto `board` (see rebaseDraft): `sent` are the ops `board`
 *  already has. `asSent`: the board fields a PUT just saved, as the draft
 *  held them when it sent them. They stand in for the board's values in the
 *  base, since the server may have cleaned them (a trimmed name or
 *  Direction, lowercased colours): otherwise the draft would differ from
 *  the base for good, read as the person's change, and hide (then
 *  overwrite) the next outside edit of that field. */
function draftOnBoard(draft: MoodboardDraft, board: Moodboard, sent?: ReadonlySet<MoodboardOp>,
  asSent?: Partial<Record<BoardFieldKey, unknown>>): MoodboardDraft {
  // A field the PUT sent is the person's since only if the draft moved off
  // what was sent: an edit made while the save was out, even one back to the
  // value last read, must not read as untouched and take the sent value.
  // An unsaved draft has no base: what it sent is its base (round 6g), so a
  // field the board changed since and the draft didn't takes the board's.
  const since = asSent ? { ...draft, base: { ...(draft.base ?? {}), ...asSent } } : draft;
  return rebaseDraft(since, board, { ...boardFieldsOf(board), ...asSent }, sent);
}

/** The draft's cover after `ops`: the last `cover` op's pick, and #1 again
 *  (null) when the cover image comes off, as the server does in the same
 *  write (its undo brings both back). */
function coverAfter(cover: string | null, ops: MoodboardOp[], images: MoodboardImage[]): string | null {
  let next = cover;
  for (const op of ops) if (op.op === 'cover') next = op.image;
  return next !== null && !images.some((image) => image.id === next) ? null : next;
}

/** Whether two rects share any area (touching edges don't). */
function overlaps(a: NodeRect, b: NodeRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** A draft's board fields with the name as it is sent (trimmed). */
function trimmedName<D extends Partial<Record<BoardFieldKey, unknown>>>(fields: D): D {
  return typeof fields.name === 'string' ? { ...fields, name: fields.name.trim() } : fields;
}

/** Resolves once the draft at `key` has no save out. */
function whenNotSaving(key: string): Promise<void> {
  return new Promise((done) => {
    let stop: (() => void) | null = null;
    const check = () => {
      const store = useAssetStudioDraftStore.getState();
      if (store.entries[resolveAssetStudioDraftKey(store, key)]?.pendingSaveId) return false;
      stop?.();
      done();
      return true;
    };
    if (!check()) stop = useAssetStudioDraftStore.subscribe(() => { check(); });
  });
}

/**
 * A board not saved yet, saved where the person isn't (GM r8 answers 1 and
 * 2): its add landed while they were away, or New is about to open a fresh
 * draft over it. It is created as the open Studio's first save creates it
 * (under its name, or the default one if it has none), so it shows in the
 * rail, and its draft moves to the saved key. Returns the board's id, or
 * null if the save failed (its line is on that board's draft).
 */
async function saveAway(key: string, away: 'background' | 'resend' | null = null): Promise<string | null> {
  await whenNotSaving(key);
  const store = useAssetStudioDraftStore.getState();
  const at = resolveAssetStudioDraftKey(store, key);
  const entry = store.entries[at];
  if (!entry) return null;
  if (entry.savedId) return entry.savedId;
  const named = entry.draft as MoodboardDraft;
  if (!named.name.trim()) store.patch(at, { draft: { ...named, name: emptyDraft().name } });
  const attempt = store.beginSave(at);
  if (!attempt) return null;
  const sending = attempt.entry.draft as MoodboardDraft;
  try {
    const sent = new Set(sending.pendingOps ?? []);
    const { requestId, attempt: tried } = createAttemptFor(at, sending);
    const result = await createMoodboard(createBody(sending, requestId, tried));
    const now = useAssetStudioDraftStore.getState().entries[at];
    if (now) {
      const draft = withBriefFields(now.draft as MoodboardDraft);
      if (result.repeated) {
        const repeat = repeatOnBoard(at, draft, result);
        store.patch(at, { draft: repeat.draft, thumbnail: result.thumbnail, notice: keptFromBoardLine(repeat.kept, result) });
      } else store.patch(at, { draft: draftOnBoard(draft, result, sent, asSentOf(sending)), thumbnail: result.thumbnail });
    }
    createsWaited.delete(at);
    if (store.finishSave(at, attempt.id, attempt.revision, result.id, result.thumbnail)) {
      if (result.repeated) markLeftToSend(at);
      const savedKey = assetStudioDraftKey('moodboard', result.projectId ? 'project' : 'global', result.id, result.projectId);
      handOverDraft(at, savedKey);
      void sendQueued(savedKey, result.id);
    }
    return result.id;
  } catch (err) {
    if (await notSentYet(err, away === 'resend' ? 'resend' : away ? 'background' : 'first') || (!away && await createWaits(at, err))) {
      // Not sent: nothing shows (GM r11 4). New stays on the board; an add
      // that saved a board the person had left sends it again on reconnect,
      // unless the person is back on it (its autosave sends it then).
      if (useAssetStudioDraftStore.getState().entries[at]?.pendingSaveId === attempt.id) {
        store.patch(at, { pendingSaveId: null, dirty: true, saveState: 'draft' });
      }
      if (away) void waitUntilOnline().then(() => { if (!isOpenBoard(at)) void saveAway(at, 'resend'); });
      return null;
    }
    // Nothing is lost: the draft keeps it and Retry sends it again (GM r14).
    if (isCreateIdRefusal(err)) store.patch(at, { createRequestId: null });
    failBoardSave(at, attempt.id, err);
    return null;
  }
}

// An unsaved board's draft lives through a reload of this tab (round 6g, GM r15 3).
keepUnsavedDrafts();

/** The view each Board add was made in, and its card's size (a rebase
 *  sizes a queued add's card without its aspect), for a replay that has to move it. */
const addViews = new WeakMap<MoodboardOp, { view: NodeRect | null; seen?: SeenArea | null; band: boolean; size: [number, number] }>();

/**
 * After a 409 the draft is rebased onto the board as the server has it now,
 * its queued ops replayed. A queued add whose spot a concurrent write took
 * (another tab's add, an agent's) moves to the nearest free spot: exactly a
 * held spot's rule when the board changes under it, with the band's up-nudge
 * (GM r11 3; lib/boardPlacement `respot`). The op moves in place, so its Undo
 * step and the send that owns it still know it. `draft` is the rebased
 * draft; returns the adds that moved (any, and the caller rebases again).
 */
function freeQueuedAdds(draft: MoodboardDraft, key: string): Array<Extract<MoodboardOp, { op: 'add' }>> {
  const adds = (draft.pendingOps ?? []).filter((op): op is Extract<MoodboardOp, { op: 'add' }> =>
    op.op === 'add' && Boolean(op.at) && op.images.length === 1 && Boolean(op.images[0].id));
  if (adds.length === 0) return [];
  const queued = new Set(adds.map((op) => op.images[0].id));
  const rectOf = (card: MoodboardPlacement) => ({ x: card.x, y: card.y, width: card.w, height: card.h });
  // The board's tiles, the person's cards with their queued moves, and the
  // spots adds still uploading hold; each add is counted once it has its spot.
  const taken = [...draft.images.filter((image) => !queued.has(image.id)).flatMap((image) => (image.placements ?? []).map(rectOf)),
    ...heldOn(useBoardAddStore.getState().held, key).filter((holder) => !holder.listOnly && !holder.filled)];
  const moved: Array<Extract<MoodboardOp, { op: 'add' }>> = [];
  for (const op of adds) {
    const seen = addViews.get(op);
    const card = draft.images.find((image) => image.id === op.images[0].id)?.placements?.[0];
    const [width, height] = seen?.size ?? (card ? [card.w, card.h] : [0, 0]);
    if (!width || !height) continue;
    const rect = { x: op.at!.x, y: op.at!.y, width, height };
    if (!spotFree(rect, taken)) {
      const spot = respot(rect, taken, seen?.view ?? null, seen?.band);
      op.at = spot;
      Object.assign(rect, spot);
      moved.push(op);
    }
    taken.push(rect);
  }
  return moved;
}

/**
 * Whether a send that failed with `err` isn't sent yet, so it waits for
 * Nebula instead of failing (GM r11 4). A write refused while offline is
 * not sent. A background write that got no answer (review 8, MEDIUM-2: the
 * network or the backend went while it was out) is the same when a health
 * probe then finds Nebula offline: a real loss of the backend shows first as
 * the failed request, not as the banner. A resend on reconnect that gets no
 * answer is a failure: it says why. `first` is a save the person is looking
 * at (New's own create): it fails as before.
 */
async function notSentYet(err: unknown, send: 'first' | 'background' | 'resend'): Promise<boolean> {
  if (isOfflineRefusal(err)) return true;
  if (send !== 'background' || !isBackendUnreachable(err)) return false;
  return probeOffline();
}

/** Whether the create of the unsaved board at `key`, cut off by `err`, waits for Nebula instead of failing. */
async function createWaits(key: string, err: unknown): Promise<boolean> {
  if (createsWaited.has(key) || !isBackendUnreachable(err) || !await probeOffline()) {
    createsWaited.delete(key);
    return false;
  }
  createsWaited.add(key);
  return true;
}

/**
 * What a background send owns (review 8, MEDIUM-1): the ops and board fields
 * the draft held when it began, the fields with the values it sends. A
 * resend on reconnect owns what the refused send owned, passed in, never the
 * draft as it is by then: what the person did meanwhile, on a board open in
 * the Studio, is that board's own steps, which its autosave sends with each
 * step's Undo.
 */
interface SendOwns {
  ops: ReadonlySet<MoodboardOp>;
  fields: Partial<Record<BoardFieldKey, unknown>>;
}

function ownsOf(draft: MoodboardDraft): SendOwns {
  const drafted = draft as Partial<Record<BoardFieldKey, unknown>>;
  return { ops: new Set(draft.pendingOps ?? []),
    fields: Object.fromEntries(Object.keys(unsentFields(draft)).map((field) => [field, drafted[field as BoardFieldKey]])) };
}

/**
 * A background send Nebula refused while offline (GM r11 4): it isn't sent
 * yet, so it is no failure. Nothing shows (the banner says Nebula is
 * offline); the save is let go with the draft still to send. What the send
 * owned (still unsent) is kept for a reload of this tab, and sent again once
 * on reconnect, as its own send.
 */
function waitToResend(key: string, savedId: string, attemptId: string, owns: SendOwns) {
  const store = useAssetStudioDraftStore.getState();
  const at = resolveAssetStudioDraftKey(store, key);
  const entry = store.entries[at];
  if (entry?.pendingSaveId !== attemptId) return;
  store.patch(at, { pendingSaveId: null, dirty: true, saveState: 'draft' });
  const draft = entry.draft as MoodboardDraft;
  const pending = new Set(draft.pendingOps ?? []);
  const left: SendOwns = { ops: new Set([...owns.ops].filter((op) => pending.has(op))), fields: owns.fields };
  keepWaitingSend(savedId, [...left.ops], unsentOf(draft, left.fields));
  void waitUntilOnline().then(() => sendQueued(key, savedId, left));
}

/** The board fields the draft changed that aren't on the server yet. */
function unsentFields(draft: MoodboardDraft): Record<string, unknown> {
  return unsentOf(draft, draft);
}

/** Of `fields`, those that differ from what the draft last read (its base), as they are sent. */
function unsentOf(draft: MoodboardDraft, fields: Partial<Record<BoardFieldKey, unknown>>): Record<string, unknown> {
  const changed: Record<string, unknown> = draft.base ? fieldChanges(trimmedName(draft.base), trimmedName(fields)) : {};
  delete changed.images;
  return changed;
}

/**
 * A kept edit replayed on `board` as the server has it now (round 6i, GM
 * r17): its board fields by the 6g rule (replayKeptFields: a field the board
 * changed since goes to the later edit, and `kept` names those the board
 * won), its queued ops on the board's images. An add whose image the board
 * holds already went (a save that landed before the reload); a remove keeps
 * only the images still there; rebaseDraft drops an op on an image that's gone.
 */
/** A board a kept edit was for, deleted before the edit could replay (round 6j). */
interface GoneBoard { id: string; name: string; scope: AssetScope }

function replayKeptEdit(board: Moodboard, kept: KeptEdit): { draft: MoodboardDraft; kept: BoardFieldKey[] } {
  const fields = boardFieldsOf(board);
  const replay = replayKeptFields(kept, fields, Date.parse(board.updatedAt ?? '') || 0);
  const has = new Set(board.images.flatMap((image) => [image.id, image.url]));
  const ops = kept.ops.flatMap((op): MoodboardOp[] => {
    if (op.op === 'add') return op.images.some((image) => has.has(image.url) || (image.id && has.has(image.id))) ? [] : [op];
    if (op.op === 'remove') {
      const images = op.images.filter((id) => has.has(id));
      return images.length ? [{ ...op, images }] : [];
    }
    return [op];
  });
  return { draft: rebaseDraft({ ...moodboardToDraft(board), ...replay.fields, pendingOps: ops }, board, fields),
    kept: replay.kept as BoardFieldKey[] };
}

/** The draft at `key` still holds ops or board fields the server hasn't (a
 *  save that ended left them): it is dirty again, so they are sent. */
function markLeftToSend(key: string) {
  const store = useAssetStudioDraftStore.getState();
  const entry = store.entries[resolveAssetStudioDraftKey(store, key)];
  const draft = entry?.draft as MoodboardDraft | undefined;
  if (entry && !entry.dirty && draft && ((draft.pendingOps ?? []).length || Object.keys(unsentFields(draft)).length)) {
    store.patch(key, { dirty: true, saveState: 'draft' });
  }
}

/**
 * The id every create of the unsaved board at `key` carries (round 6e): made
 * at its first create and kept on its draft entry, so a create sent again
 * after its answer was lost (New's save that got no answer, then Retry; an
 * add's save sent again on reconnect) returns the board the first one made
 * instead of a second board. A new draft gets a new one.
 */
function createRequestIdFor(key: string): string | undefined {
  const store = useAssetStudioDraftStore.getState();
  const at = resolveAssetStudioDraftKey(store, key);
  const made = store.entries[at]?.createRequestId;
  if (made) return made;
  // The server refused this draft's id (round 6g): its creates go without one.
  if (made === null) return undefined;
  const id = crypto.randomUUID();
  store.patch(at, { createRequestId: id });
  return id;
}

/** The board fields of `draft` as a create sends them (the analysis aside). */
function asSentOf(draft: MoodboardDraft): Partial<Record<BoardFieldKey, unknown>> {
  const drafted = draft as Partial<Record<BoardFieldKey, unknown>>;
  return Object.fromEntries(BOARD_FIELD_KEYS.filter((field) => field !== 'analysis' && field in drafted)
    .map((field) => [field, drafted[field]]));
}

/** Attempts kept per unsaved draft: a repeat names one of the last few. */
const ATTEMPTS_KEPT = 10;

/**
 * The next create of the unsaved board at `key` (round 6g, GM r15 1): its
 * request id and attempt number, with what this attempt sends (its queued
 * ops and fields) kept on the entry, so a repeat whose board this attempt
 * made rebases on exactly what it sent.
 */
function createAttemptFor(key: string, draft: MoodboardDraft): { requestId: string | undefined; attempt: number } {
  const requestId = createRequestIdFor(key);
  const store = useAssetStudioDraftStore.getState();
  const at = resolveAssetStudioDraftKey(store, key);
  const attempts = store.entries[at]?.createAttempts ?? [];
  const attempt = (attempts[attempts.length - 1]?.n ?? 0) + 1;
  store.patch(at, { createAttempts: [...attempts, { n: attempt, sent: [...(draft.pendingOps ?? [])], asSent: asSentOf(draft) }]
    .slice(-ATTEMPTS_KEPT) });
  return { requestId, attempt };
}

/** A name as the server keeps it (trimmed), to tell a real change from its cleaning. */
const keptForm = (field: string, value: unknown) => (field === 'name' && typeof value === 'string' ? value.trim() : value);

/**
 * `draft` on the board a repeated create answered (round 6g, GM r15 1): the
 * board as it is now, with what the attempt that made it sent counted as on
 * it, so the board's own later changes (a rename on the rail, a removed
 * image, an agent's edit) win and only the draft's edits made after that
 * attempt replay. A field both changed goes to the later edit (the draft's
 * edit time against the board's updatedAt); `kept` names each field where
 * the board's won over a draft edit. No record of that attempt (an older
 * Nebula): everything replays, as before.
 */
function repeatOnBoard(key: string, draft: MoodboardDraft, board: MoodboardCreated): { draft: MoodboardDraft; kept: BoardFieldKey[] } {
  const store = useAssetStudioDraftStore.getState();
  const entry = store.entries[resolveAssetStudioDraftKey(store, key)];
  const attempts = entry?.createAttempts ?? [];
  const made = attempts.find((it) => it.n === board.madeAttempt);
  if (!made) return { draft: draftOnBoard(draft, board), kept: [] };
  const asSent = made.asSent as Partial<Record<BoardFieldKey, unknown>>;
  const kept: BoardFieldKey[] = [];
  let mine = draft;
  // The board changed since it was made (its version moved on): a field it
  // holds differently from what was sent is the board's change.
  if (board.madeVersion === undefined || board.version > board.madeVersion) {
    const theirs = boardFieldsOf(board);
    const boardAt = Date.parse(board.updatedAt ?? '') || 0;
    for (const field of Object.keys(asSent) as BoardFieldKey[]) {
      const drafted = (mine as Partial<Record<BoardFieldKey, unknown>>)[field];
      if (sameValue(drafted, asSent[field]) || sameValue(keptForm(field, theirs[field]), keptForm(field, asSent[field]))) continue;
      if ((entry?.fieldEditedAt?.[field] ?? 0) > boardAt) continue;
      mine = { ...mine, [field]: asSent[field] };
      kept.push(field);
    }
  }
  // What was sent is the base; the board's own values are the new one, but
  // where the board kept what was sent (bar its cleaning: a trimmed name),
  // what was sent stands in, as after any save (draftOnBoard).
  const fields = boardFieldsOf(board);
  for (const field of Object.keys(asSent) as BoardFieldKey[]) {
    if (sameValue(keptForm(field, fields[field]), keptForm(field, asSent[field]))) fields[field] = asSent[field];
  }
  return { draft: rebaseDraft({ ...mine, base: { ...(mine.base ?? {}), ...asSent } }, board, fields, new Set(made.sent as MoodboardOp[])), kept };
}

/**
 * The unsaved draft at `key`, now the board `destination` (round 6g, review
 * 9 R9-B): moved there, or, when that board is open in the Studio already
 * (opened from the rail), folded into its draft, which keeps its epoch and
 * Undo; what this one still has to send goes on top and is sent.
 */
function handOverDraft(key: string, destination: string) {
  useAssetStudioDraftStore.getState().handOver(key, destination, (into: AssetStudioDraftEntry, from: AssetStudioDraftEntry) => {
    const left = from.draft as MoodboardDraft;
    const open = into.draft as MoodboardDraft;
    const ops = left.pendingOps ?? [];
    const fields = unsentFields(left);
    const more = ops.length > 0 || Object.keys(fields).length > 0;
    if (!more) return { notice: from.notice ?? into.notice ?? null };
    return { draft: { ...open, ...fields, images: applyOps(open.images, ops), pendingOps: [...(open.pendingOps ?? []), ...ops] },
      dirty: true, revision: into.revision + 1, saveState: into.pendingSaveId ? 'saving' : 'draft',
      notice: from.notice ?? into.notice ?? null };
  });
}

/**
 * What a new board's draft took while saveAway's create was out (an add
 * that landed on the open board meanwhile), sent as the open Studio's save
 * sends it (review 6, MEDIUM-1). saveAway's board is one the person may not
 * be on any more (New opened a fresh draft over it), so no Studio's autosave
 * sends it: the image ops go as one checked edit on the version the create
 * answered (a conflict reads the board and replays), then any board field
 * changed meanwhile goes on a PUT. The draft is clean once the server holds
 * it all; a failure is that board's line, with Retry.
 *
 * `resend` is a resend on reconnect, with what the refused send owned
 * (SendOwns): it never takes what the draft gained since (review 8, MEDIUM-1).
 */
async function sendQueued(key: string, savedId: string, resend: SendOwns | null = null): Promise<void> {
  const store = useAssetStudioDraftStore.getState();
  const entryNow = () => {
    const state = useAssetStudioDraftStore.getState();
    const entry = state.entries[resolveAssetStudioDraftKey(state, key)];
    return entry?.savedId === savedId ? entry : undefined;
  };
  if (!entryNow()?.dirty) return;
  const attempt = store.beginSave(key);
  if (!attempt) return;
  const moveOn = (board: Moodboard, sent?: ReadonlySet<MoodboardOp>, asSent?: Partial<Record<BoardFieldKey, unknown>>) => {
    const now = entryNow();
    if (now) store.patch(key, { draft: draftOnBoard(withBriefFields(now.draft as MoodboardDraft), board, sent, asSent), thumbnail: board.thumbnail });
  };
  // What this send is for: the ops and fields the draft held when it began
  // (a resend: what the refused send held). A change made after that (on the
  // board, open in the Studio now) is its own step, which the Studio's
  // autosave sends with that step's Undo.
  const owns = resend ?? ownsOf(attempt.entry.draft as MoodboardDraft);
  try {
    let thumbnail = attempt.entry.thumbnail;
    for (let tries = 0; ; tries += 1) {
      const draft = entryNow()?.draft as MoodboardDraft | undefined;
      if (!draft) return;
      try {
        let version = draft.version;
        const ops = (draft.pendingOps ?? []).filter((op) => owns.ops.has(op));
        if (ops.length) {
          const edited = await editMoodboard(savedId, sendableBatch(ops), version);
          moveOn(edited.board, new Set(ops));
          version = edited.board.version;
          thumbnail = edited.board.thumbnail;
        }
        const after = entryNow()?.draft as MoodboardDraft | undefined;
        const fields = after ? unsentOf(after, owns.fields) : {};
        if (after && Object.keys(fields).length) {
          const saved = await updateMoodboard(savedId, {
            ...(fields as Parameters<typeof updateMoodboard>[1]),
            ...(after.projectId ? { projectId: after.projectId } : {}),
            ...(version === undefined ? {} : { baseVersion: version }) });
          moveOn(saved, undefined, Object.fromEntries(Object.keys(fields).filter((field) => field !== 'analysis')
            .map((field) => [field, owns.fields[field as BoardFieldKey]])));
          thumbnail = saved.thumbnail;
        }
        break;
      } catch (err) {
        if (!(err instanceof MoodboardVersionConflict) || tries >= 2) throw err;
        moveOn(err.board);
        const rebased = entryNow()?.draft as MoodboardDraft | undefined;
        if (rebased && freeQueuedAdds(rebased, key).length) moveOn(err.board);
      }
    }
    // Another change landed while this send was out, or (a resend) before
    // it: the draft holds it still. On a board open in the Studio, its
    // autosave sends it (once this save is off the entry), one batch per
    // step with each step's Undo (GM r11 1: a board New just saved keeps
    // Undo like any saved board). On a board no Studio has open, it goes the
    // same way as this one.
    if (store.finishSave(key, attempt.id, attempt.revision, savedId, thumbnail)) {
      dropWaitingSend(savedId);
      markLeftToSend(key);
      if (entryNow()?.dirty && !isOpenBoard(key)) void sendQueued(key, savedId);
    }
  } catch (err) {
    if (await notSentYet(err, resend ? 'resend' : 'background')) waitToResend(key, savedId, attempt.id, owns);
    // Sent again on reconnect and failed: the board says why (GM r11 4).
    else failBoardSave(key, attempt.id, err);
  }
}

/** True when the unsaved draft at `key` holds something of the person's:
 *  images, or an add still on its way (GM r8 answer 1: it counts as content). */
function unsavedWithContent(key: string): boolean {
  const store = useAssetStudioDraftStore.getState();
  const at = resolveAssetStudioDraftKey(store, key);
  const entry = store.entries[at];
  if (!entry || entry.savedId || at !== key) return false;
  return (entry.draft as MoodboardDraft).images.length > 0 || addsInFlight(key);
}

/** Before New (or a delete) opens a fresh draft at the unsaved key `key`:
 *  an unsaved board with content is saved first, so New never drops a paste
 *  (GM r8 answer 1). `kept` is false if that save failed: keep the draft.
 *  `savedId` is the board it saved, if it saved one. */
async function keepUnsaved(key: string): Promise<{ kept: boolean; savedId: string | null }> {
  if (!unsavedWithContent(key)) return { kept: true, savedId: null };
  const savedId = await saveAway(key);
  return { kept: savedId !== null, savedId };
}

/** A failed write of an add to a board the person isn't on (review 5, LOW-4). */
class AwayWriteFailed extends Error {
  readonly failure: unknown;
  constructor(failure: unknown) { super('away write failed'); this.failure = failure; }
}

/**
 * An add whose person left its board while it uploaded (GM on review 4: it's
 * their paste, so it isn't dropped). It lands on that board, never the one
 * open now, written through the draft store:
 * - a saved board: the add goes to the server as an edit of that board (no
 *   base version, so it lands on the board as it is now, at the spot it
 *   held). Its draft takes the board once no save of it is out, if it
 *   holds nothing unsent; otherwise the send or the next open reads it
 *   (review 5, LOW-3);
 * - a board not saved yet: the add goes in its draft, and the board is saved
 *   now, so it shows in the rail (GM r8 answer 2);
 * - a board deleted meanwhile (its edit answers 404), or an unsaved draft
 *   discarded: the add is cancelled, silently (GM r8 answer 1).
 * There's no undo step: the board's undo history went when the person left it.
 * Resolves to whether it landed; a failed write throws AwayWriteFailed.
 */
async function landAway(board: BoardRef, ops: MoodboardOp[], aspects: Record<string, number>): Promise<boolean> {
  for (;;) {
    const standing = boardStanding(board);
    if (standing === 'gone') return false;
    const store = useAssetStudioDraftStore.getState();
    if (standing === 'draft' && !board.savedId) {
      // Its first save is out: once it lands, the board has an id.
      if (store.entries[board.key]?.pendingSaveId) {
        await whenNotSaving(board.key);
        continue;
      }
      store.edit(board.key, (draft) => {
        const current = draft as MoodboardDraft;
        const images = applyOps(current.images, ops, { aspects });
        return { ...current, images, coverImageId: coverAfter(current.coverImageId ?? null, ops, images),
          pendingOps: queueOps(current.pendingOps, ops) };
      });
      if (await saveAway(board.key, 'background') === null) throw new AwayWriteFailed(null);
      return true;
    }
    const savedId = board.savedId!;
    let edited: Awaited<ReturnType<typeof editMoodboard>>;
    try {
      edited = await editMoodboard(savedId, sendableBatch(ops));
    } catch (err) {
      // Deleted meanwhile (in the trash, or gone): cancelled.
      if ((err as { status?: unknown }).status === 404) return false;
      throw new AwayWriteFailed(err);
    }
    // The board's draft takes it if it is behind it. A save of the board out
    // now is waited out first: one that reached the server after the add
    // holds it already (a newer version). Edits not sent yet wait for their
    // own send, which rebases them on the board as it is; a draft not loaded
    // reads the board when it loads; a kept draft reads it again when the
    // board next opens (follow).
    await whenNotSaving(board.key);
    const key = resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), board.key);
    const now = useAssetStudioDraftStore.getState().entries[key];
    if (now?.loaded && now.savedId === savedId && !now.dirty && !now.pendingSaveId
      && ((now.draft as MoodboardDraft).version ?? 0) < edited.board.version) {
      store.patch(key, { draft: draftOnBoard(withBriefFields(now.draft as MoodboardDraft), edited.board), thumbnail: edited.board.thumbnail });
    }
    return true;
  }
}

/** A board save failed: its line (boardSaveLine, GM r16) and what the
 *  header offers for it, a Retry or (the line says Reload) none. */
function failBoardSave(key: string, id: string, err: unknown) {
  const line = boardSaveLine(err);
  useAssetStudioDraftStore.getState().failSave(key, id, line.failure, { retry: line.retry });
}

/** A failed away write keeps the image (review 5, LOW-4): its add waits in
 *  that board's draft, which the next save sends, and the board says why. */
function keepFailedAway(board: BoardRef, ops: MoodboardOp[], aspects: Record<string, number>, err: unknown, names: readonly string[]) {
  const store = useAssetStudioDraftStore.getState();
  const key = resolveAssetStudioDraftKey(store, board.key);
  const entry = store.entries[key];
  if (!entry || !(entry.epoch === board.epoch || (board.savedId && entry.savedId === board.savedId))) return;
  const savedId = board.savedId;
  const failed = () => {
    const line = boardSaveLine(err);
    store.patch(key, { saveState: 'error', saveError: line.failure, retry: line.retry });
  };
  if (entry.loaded && savedId) {
    store.edit(key, (draft) => {
      const current = draft as MoodboardDraft;
      const images = applyOps(current.images, ops, { aspects });
      return { ...current, images, coverImageId: coverAfter(current.coverImageId ?? null, ops, images),
        pendingOps: queueOps(current.pendingOps, ops) };
    });
    void notSentYet(err, 'background').then((waits) => {
      const now = useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key)];
      const draft = now?.savedId === savedId ? now.draft as MoodboardDraft : undefined;
      const unsent = (draft?.pendingOps ?? []).filter((op) => ops.includes(op));
      // Sent meanwhile (the board's own save took it): nothing to say.
      if (unsent.length === 0) return;
      // Not sent while offline (GM r11 4; review 8, MEDIUM-2): nothing shows;
      // kept for a reload of this tab, and sent again once on reconnect, as
      // its own send: just this add, never what the person did on the board
      // meanwhile (review 8, MEDIUM-1).
      if (waits) {
        keepWaitingSend(savedId, unsent, {});
        void waitUntilOnline().then(() => sendQueued(key, savedId, { ops: new Set(unsent), fields: {} }));
      } else if (err !== null) failed();
    });
    return;
  }
  if (err === null || isOfflineRefusal(err)) return;
  // A saved board whose draft isn't loaded never took the add (review 9
  // NIT-2): it is lost, so not the neutral "nothing is lost" line; GM r16's
  // red line naming its files, with no Retry (nothing is left to send). The
  // board itself saved fine, so its chip stays as it is ("Saved"): the red
  // line carries the loss (GM r17).
  if (savedId) store.patch(key, { saveError: lostAddLine(names), retry: null });
  // An unsaved board's draft holds the add (landAway): its line.
  else failed();
}

/** A new board's first save: everything but the checked-edit bookkeeping,
 *  with the board's create id (createRequestIdFor) when it is a create. */
function createBody(draft: MoodboardDraft, requestId?: string, attempt?: number) {
  const body: MoodboardDraft & { requestId?: string; attempt?: number } = { ...withBriefFields(draft), name: draft.name.trim(),
    images: provisionalForCreate(draft.images), ...(requestId ? { requestId, ...(attempt ? { attempt } : {}) } : {}) };
  delete body.base;
  delete body.version;
  delete body.pendingOps;
  return body;
}

/** The person's Keep anyway / Leave out after one choice: a colour is in
 *  one list at most, and Reset takes it off both. The backend decides what
 *  each choice does to the brief. */
function nextColorChoices(
  choices: { keep: string[]; leaveOut: string[] } | undefined,
  choice: ColorChoice,
  hexes: string[],
): { keep: string[]; leaveOut: string[] } {
  const drop = new Set(hexes.map((hex) => hex.toLowerCase()));
  const keep = (choices?.keep ?? []).filter((hex) => !drop.has(hex.toLowerCase()));
  const leaveOut = (choices?.leaveOut ?? []).filter((hex) => !drop.has(hex.toLowerCase()));
  const added = [...drop];
  if (choice === 'keep') return { keep: [...keep, ...added], leaveOut };
  if (choice === 'leaveOut') return { keep, leaveOut: [...leaveOut, ...added] };
  return { keep, leaveOut };
}

/** A draft as an older store entry may hold it (saved before the brief fields). */
function withBriefFields(draft: MoodboardDraft): MoodboardDraft {
  return {
    ...draft,
    direction: draft.direction ?? '',
    avoid: draft.avoid ?? [],
    pinnedColors: draft.pinnedColors ?? { include: [], exclude: [] },
    briefOverride: draft.briefOverride ?? null,
  };
}

function createDraftImage(url: string): MoodboardImage {
  return {
    id: crypto.randomUUID?.() ?? Math.random().toString(16).slice(2),
    url,
    weight: 1,
    notes: '',
    privateNote: '',
    excluded: false,
  };
}

/** The board fields whose change clears the analysis (it reads them). */
const STEERING_FIELDS = ['mode', 'strength', 'notes'] as const;

/** A step's name for the undo toast: what changed on which reference. */
function imagePatchLabel(patch: Partial<MoodboardImage>, number: number): string {
  if ('excluded' in patch) return patch.excluded ? `Set aside #${number}` : `Used #${number} again`;
  if ('weight' in patch) return `Weight of #${number}`;
  if ('privateNote' in patch) return `Private note on #${number}`;
  return `Note on #${number}`;
}

/** What an undo left as it was, in the server's words (contract 07, 1.12),
 *  each once: a field step that saved twice undoes in two restores. */
function skippedLines(edited: MoodboardEditResult): string[] {
  return [...new Set(edited.applied.flatMap((entry) => {
    const skipped = Array.isArray(entry.skipped) ? entry.skipped as Array<{ message?: unknown; number?: unknown }> : [];
    return skipped.map((slice) => (typeof slice.message === 'string' && slice.message ? slice.message
      : typeof slice.number === 'number' ? `#${slice.number} changed since, left as is` : 'Part of it changed since, left as is'));
  }))];
}

export function MoodboardStudioView() {
  const moodboardEditorId = useUIStore((s) => s.moodboardEditorId);
  const moodboardEditorScope = useUIStore((s) => s.moodboardEditorScope);
  const enterMoodboardEditor = useUIStore((s) => s.enterMoodboardEditor);
  const exitMoodboardEditor = useUIStore((s) => s.exitMoodboardEditor);

  const studio = useAssetStudioDraft('moodboard', moodboardEditorScope, moodboardEditorId, emptyDraft);
  const { draft: storedDraft, savedId, saveState, saveError, retry, retryStep, loadError, loaded, notice,
    dirty, pendingSaveId, pendingAnalysisId, key, revision, epoch, projectId, projectReady, verifyProject, setDraft, initialize, patch } = studio;
  // The steps undo and redo would take next: a failed undo's Retry runs only
  // while its step is still that one (round 3; else it is hidden).
  const nextUndoId = useBoardUndoStore((state) => state.history(key, epoch).done.at(-1)?.id ?? null);
  const nextRedoId = useBoardUndoStore((state) => state.history(key, epoch).undone.at(-1)?.id ?? null);
  // One object per stored draft: the autosave waits 600 ms from the draft's
  // last change, and a new object on every render would restart that wait on
  // any re-render (a held spot, an upload row), so a save could wait forever.
  const draft = useMemo(() => withBriefFields(storedDraft), [storedDraft]);
  const loading = !loaded;
  // Tiles the last add placed outside the view: the board's edge chip (GM, #210).
  const [outsideTiles, setOutsideTiles] = useState<OutsideTiles | null>(null);
  const outsideSeq = useRef(0);
  const dismissOutside = useCallback(() => setOutsideTiles(null), []);
  // Placeholder tiles (GM r4 answer 1): each added file's spot (or, added
  // from the List, its row), held from the moment it is placed until its
  // upload fills it (or fails and it goes). Kept per board outside the Studio
  // (boardAdds.ts), so an add outlives leaving the board and still lands on it.
  const heldAll = useBoardAddStore((state) => state.held);
  const aliases = useAssetStudioDraftStore((state) => state.aliases);
  // Which spots are this board's reads the draft's key, epoch and saved id (a fresh draft at the same key holds none).
  // eslint-disable-next-line react-hooks/exhaustive-deps -- aliases, epoch and savedId change which board this is
  const placeholders = useMemo(() => heldOn(heldAll, key), [heldAll, key, aliases, epoch, savedId]);
  // The List shows each file still uploading as its own row (GM): a filled one is its image's row already.
  const listUploads = useMemo(() => placeholders.filter((holder) => !holder.filled), [placeholders]);
  /** Filled placeholders whose image has faded in (or ran out of time): gone. */
  const dropFilled = useCallback((ids: string[]) => { releaseFilled(ids); }, []);
  // What generators get from the saved board (computed by the backend on
  // every read and save), for the board it belongs to.
  // The saved override comes with it, so Studio can say who wrote it.
  const [serverBrief, setServerBrief] = useState<
    { id: string; brief: MoodboardBrief; override: Moodboard['briefOverride'] } | null>(null);
  const brief = serverBrief && serverBrief.id === savedId ? serverBrief.brief : null;
  const savedOverride = serverBrief && serverBrief.id === savedId ? serverBrief.override : null;
  const rememberBrief = useCallback((board: Moodboard) => {
    if (board.brief) setServerBrief({ id: board.id, brief: board.brief, override: board.briefOverride ?? null });
  }, []);
  const analyzing = Boolean(pendingAnalysisId);
  // Analyze clearing the "old colors" lines doesn't move a panel scrolled to the bottom (GM r6 on #208, item 4).
  const holdSpacer = useHoldBottom('.moodboard-analysis__outdated');
  const [railScope, setRailScope] = useState<AssetScope>(moodboardEditorScope);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isCurrent = useCallback(() => {
    const ui = useUIStore.getState();
    return mounted.current && ui.viewMode === 'moodboard-editor' && ui.moodboardEditorId === moodboardEditorId
      && ui.moodboardEditorScope === moodboardEditorScope
      && projectReady && (moodboardEditorScope !== 'project' || (currentProject()?.id ?? null) === projectId)
      && useAssetStudioDraftStore.getState().entries[key]?.epoch === epoch;
  }, [moodboardEditorId, moodboardEditorScope, key, epoch, projectReady, projectId]);
  const isDraftId = !moodboardEditorId || moodboardEditorId === NEW_MOODBOARD_SENTINEL;
  const canSave = draft.name.trim().length > 0 && draft.images.length > 0;

  // The Board view (moodboard canvas PR5): which view, the selected cards
  // (per board draft), and this tab's undo steps for the board.
  const view = useBoardCanvasStore((state) => state.view);
  const setView = useBoardCanvasStore((state) => state.setView);
  // The chip goes on a board switch and on any view switch (GM r4 answer 8):
  // back on the Board it would point at what List already showed.
  useEffect(() => { setOutsideTiles(null); }, [key, view]);
  // The chip points only at tiles still on the board (review 8, LOW-1): an
  // Undo or a remove of its add takes its tile out of it, and the chip goes
  // with the last one. A tile counts while a card or a held spot covers it.
  useEffect(() => {
    if (!outsideTiles) return;
    const covers = [...draft.images.flatMap((image) => (image.placements ?? []).map((card) => ({ x: card.x, y: card.y, width: card.w, height: card.h }))),
      ...placeholders.filter((holder) => !holder.listOnly)];
    const standing = outsideTiles.rects.filter((rect) => covers.some((cover) => overlaps(rect, cover)));
    if (standing.length === outsideTiles.rects.length) return;
    setOutsideTiles((current) => (current !== outsideTiles ? current : standing.length ? { ...current, rects: standing } : null));
  }, [outsideTiles, draft.images, placeholders]);
  const selection = useBoardSelection(key);
  const selectedIds = view === 'board' ? selectedImageIds(draft.images, selection) : [];
  // `undoOf`: a removal's toast, whose Undo takes back that step.
  type StudioToast = BoardToast & { key: string; undoOf?: string };
  const [toast, setToast] = useState<StudioToast | null>(null);
  // The toast up now, for lines decided after an await (an undo's answer).
  const toastNow = useRef<StudioToast | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((next: Omit<BoardToast, 'id'> & { undoOf?: string }) => {
    toastSeq.current += 1;
    toastNow.current = { ...next, id: toastSeq.current, key };
    setToast(toastNow.current);
  }, [key]);
  const dismissToast = useCallback(() => { toastNow.current = null; setToast(null); }, []);
  // An info line (no action: the reload line, "Undid…") says something about
  // the board it was on, once: leaving that board ends it, so a quick return
  // doesn't show (or read) it again (review 7, NIT-1).
  useEffect(() => {
    if (toastNow.current && toastNow.current.key !== key && !toastNow.current.action) dismissToast();
  }, [key, dismissToast]);
  // A polite announcement with no line on screen: the live region is
  // emptied, then given its words, so the same words twice are read twice.
  const [spoken, setSpoken] = useState('');
  const announce = (text: string) => {
    setSpoken('');
    window.requestAnimationFrame(() => setSpoken(text));
  };
  const liveToast = () => (toastNow.current && toastNow.current.key === key ? toastNow.current : null);
  // An info line (a paste's nothing-to-add or links line) never replaces a
  // toast with an action (GM, #210 review answer 1): it shows only when no
  // Undo or Redo is up, isn't queued, and is announced politely either way.
  const showInfoLine = (text: string) => {
    if (liveToast()?.action) {
      announce(text);
      return;
    }
    showToast({ text });
  };
  // "Undid…" is an info line too (GM r4 answer 5): it never replaces a live
  // "Removed · Undo" toast, unless the step just undone is that toast's own
  // (its Undo button, or Cmd+Z taking that removal back), whose offer is used up.
  const showUndone = (next: Omit<BoardToast, 'id'>, stepId: string) => {
    const up = liveToast();
    if (up?.undoOf && up.undoOf !== stepId) {
      announce(next.text);
      return;
    }
    showToast(next);
  };
  const spokenLine = <span className="moodboard-board__sr-only" role="status" aria-live="polite">{spoken}</span>;
  // Undo steps are this board's, in this tab, at this epoch: a board switch,
  // a new epoch or leaving the Studio clears them (plan section 5.4).
  // Board field steps (Q83, fieldSteps.ts) go with them.
  const steps = useRef({ key, epoch, canRecord: false });
  const [fieldSteps] = useState(() => new FieldStepTracker({
    record: (label, keys) => (steps.current.canRecord
      ? useBoardUndoStore.getState().recordFields(steps.current.key, steps.current.epoch, label, keys) : null),
    forget: (stepId) => useBoardUndoStore.getState().forget(steps.current.key, stepId),
  }));
  useEffect(() => () => { useBoardUndoStore.getState().clear(key); fieldSteps.reset(); }, [key, epoch, fieldSteps]);
  // A drag, a drop or a removal goes at once, not 600 ms later.
  const urgent = useRef(false);

  // A load-failure notice ("Moodboard not found…") is hidden while Nebula is
  // offline, and the board is checked again on reconnect (GM, PR #198 r2): a
  // failed load is retried, and a not-found one reloaded unless the person
  // has started a new board here since.
  const shownLoadError = useOfflineHiddenNotice(loadError, () => {
    if (!projectReady) return;
    if (!loaded) patch({ loadError: null, revision: revision + 1 });
    else if (!dirty && !isDraftId && moodboardEditorId) patch({ loaded: false, loadError: null, revision: revision + 1 });
  });

  useEffect(() => {
    if (!projectReady || loaded) return;
    let cancelled = false;
    const current = () => !cancelled && isCurrent()
      && useAssetStudioDraftStore.getState().entries[key]?.revision === revision;
    // An add lost while the board wasn't loaded (keepFailedAway) says so on
    // this load, the first time the person sees the board since: its red
    // line stays through it (round 6h; the load used to clear it unseen).
    const lostAdd = () => {
      const failure = useAssetStudioDraftStore.getState().entries[key]?.saveError;
      return isLostAddLine(failure) ? failure : null;
    };
    patch({ loadError: null, saveError: lostAdd() });
    if (isDraftId || !moodboardEditorId) {
      initialize(moodboardEditorScope === 'project' ? { ...emptyDraft(), projectId: projectId! } : emptyDraft());
    } else {
      // Load the board by id. The scope it was opened with is only a hint (a
      // node's Open button doesn't know it, and a list can be stale); the
      // board's own projectId says where it lives.
      void fetchMoodboard(moodboardEditorId).then((found) => {
        if (!current()) return;
        if (!found) {
          const fresh = moodboardEditorScope === 'project' ? { ...emptyDraft(), projectId: projectId! } : emptyDraft();
          // In Recently deleted? Say so; the list in the rail restores it.
          void lookupStoredAsset('moodboard', moodboardEditorId!).catch(() => null).then((stored) => {
            if (!current()) return;
            // In Recently deleted with a kept edit: the kept edit's line says it, with its Restore (GM r19), so not this one too.
            const kept = keptEditsWaiting().some((it) => it.board === moodboardEditorId);
            initialize(fresh, null, '', stored?.status === 'trashed'
              ? (kept ? null : 'This board is in Recently deleted. Restore it from the list on the left.')
              : 'Moodboard not found. Add images to save a new one.');
          });
          return;
        }
        const scope: AssetScope = found.projectId ? 'project' : 'global';
        if (scope !== moodboardEditorScope) {
          enterMoodboardEditor(found.id, scope);
          return;
        }
        setRailScope(scope);
        rememberBrief(found);
        const lost = lostAdd();
        // A kept edit an earlier page load of this tab left (round 6i, GM
        // r17): replayed on the board as it is now, and sent. It replaces any
        // send that waited for Nebula then, which it holds too.
        const kept = takeKeptEdit(found.id);
        if (kept) takeWaitingSend(found.id);
        const replay = kept ? replayKeptEdit(found, kept) : null;
        initialize(replay?.draft ?? moodboardToDraft(found), found.id, found.thumbnail);
        if (lost) patch({ saveError: lost, retry: null });
        if (kept && replay) {
          patch({ fieldEditedAt: kept.fieldEditedAt ?? {}, notice: keptFromBoardLine(replay.kept, found) });
          markLeftToSend(key);
        }
      }).catch((err) => {
        if (current()) patch({ loadError: failureCopy(err, { heading: "Couldn't load the board." }) });
      });
    }
    return () => { cancelled = true; };
  }, [key, revision, loaded, projectReady, projectId, moodboardEditorId, moodboardEditorScope, initialize, patch, isDraftId, isCurrent,
    enterMoodboardEditor, rememberBrief]);

  useEffect(() => {
    if (isDraftId && loaded && savedId && isCurrent()) enterMoodboardEditor(savedId, moodboardEditorScope);
  }, [isDraftId, loaded, savedId, isCurrent, moodboardEditorScope, enterMoodboardEditor]);

  // The newest version someone else announced for the open board, so a save
  // in flight when it came reads the board again once it lands.
  const announced = useRef(0);
  const draftNow = useCallback(() => useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(
    useAssetStudioDraftStore.getState(), key)]?.draft as MoodboardDraft | undefined, [key]);

  // The board's own Updates (Justin's Q113 c): the corner shows them under
  // "This board" while this saved board is open. Say which board that is,
  // with its images in board order (their numbers), and forget it on leaving.
  const imageOrder = draft.images.map((image) => image.id).join('\n');
  useEffect(() => {
    useBoardCanvasStore.getState().setStudioBoard(loaded && savedId
      ? { boardId: savedId, boardKey: key, imageIds: imageOrder ? imageOrder.split('\n') : [] }
      : null);
  }, [loaded, savedId, key, imageOrder]);
  useEffect(() => () => useBoardCanvasStore.getState().setStudioBoard(null), []);
  // An Update's Show ("Show #37", "Show on board"): the Board view, with the
  // cards of the images it names selected and framed. It writes nothing.
  const showRequest = useBoardCanvasStore((state) => state.showRequest);
  useEffect(() => {
    if (!showRequest || !loaded || !savedId || showRequest.boardId !== savedId) return;
    const boards = useBoardCanvasStore.getState();
    useBoardCanvasStore.setState({ showRequest: null });
    const wanted = new Set(showRequest.imageIds);
    const cards = (draftNow()?.images ?? []).filter((image) => wanted.has(image.id))
      .flatMap((image) => (image.placements ?? []).map((card) => card.id));
    if (cards.length === 0) return;
    boards.setView('board');
    boards.setSelection(key, cards);
    boards.requestFrame(key, cards);
  }, [showRequest, loaded, savedId, key, draftNow]);
  const moveDraft = useCallback((board: Moodboard, sent?: ReadonlySet<MoodboardOp>,
    asSent?: Partial<Record<BoardFieldKey, unknown>>) => {
    const store = useAssetStudioDraftStore.getState();
    const current = draftNow();
    if (current) store.patch(key, { draft: draftOnBoard(current, board, sent, asSent), thumbnail: board.thumbnail });
    rememberBrief(board);
  }, [key, draftNow, rememberBrief]);

  /** Read the open board again after someone else saved it, and replay the
   *  draft's own edits on top. Not mid-save: the save does it when it lands. */
  const follow = useCallback(async () => {
    const entry = useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key)];
    if (!entry?.loaded || !entry.savedId || entry.pendingSaveId) return;
    const board = await fetchMoodboard(entry.savedId).catch(() => null);
    const latest = useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key)];
    if (!board || !mounted.current || !latest || latest.pendingSaveId || latest.savedId !== board.id) return;
    // Not newer: nothing to move, but the brief is read from it all the same.
    if (board.version <= ((latest.draft as MoodboardDraft).version ?? 0)) { rememberBrief(board); return; }
    moveDraft(board);
  }, [key, moveDraft, rememberBrief]);

  useEffect(() => wsClient.subscribe((event) => {
    // Back after the socket was down: what was said meanwhile isn't replayed,
    // so read the board again (follow keeps it only if it's newer).
    if (event.type === 'socketReconnected') {
      void follow();
      return;
    }
    if (event.type !== 'storedAssetChanged' || event.kind !== 'moodboard' || event.deleted) return;
    // The echo of this tab's own write.
    if (event.edit?.tab && event.edit.tab === TAB_ID) return;
    const entry = useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key)];
    if (!entry?.loaded || entry.savedId !== event.id) return;
    const known = (entry.draft as MoodboardDraft).version ?? 0;
    if (typeof event.version === 'number' && event.version <= known) return;
    announced.current = Math.max(announced.current, event.version ?? known + 1);
    void follow();
  }), [key, follow]);

  /** Steps none of whose ops wait any more, and that never landed: a later
   *  edit of the same thing replaced them in the queue (it is its own step),
   *  or a rebase dropped them (someone removed the image). Nothing to undo. */
  const forgetUnsentSteps = useCallback(() => {
    const queued = new Set(draftNow()?.pendingOps ?? []);
    const undoStore = useBoardUndoStore.getState();
    for (const step of undoStore.history(key, epoch).done) {
      if (step.fields) continue;  // a field step goes with its PUT, not an op
      if (step.state === 'pending' && !step.ops.some((op) => queued.has(op))) undoStore.forget(key, step.id);
    }
    const current = draftNow();
    const unsent = current?.base ? fieldChanges(trimmedName(current.base),
      trimmedName(current as Partial<Record<BoardFieldKey, unknown>>)) : {};
    fieldSteps.settle((field) => field in unsent);
  }, [key, epoch, draftNow, fieldSteps]);

  // A draft kept from an earlier visit opens as it was left, without a fetch,
  // and what was said while the Studio was closed isn't replayed: read the
  // board once (follow keeps it only if it's newer, replays the draft's own
  // edits, and reads the brief either way), so its cover, name, images and
  // brief match the rail. A fresh load reads it anyway.
  const followedKey = useRef<string | null>(null);
  useEffect(() => {
    if (followedKey.current === key) return;
    followedKey.current = key;
    if (loaded && savedId) void follow();
  }, [key, loaded, savedId, follow]);

  /** Adds a 409 replay moved (freeQueuedAdds) with less than half of them
   *  now in the view they were made in get the edge chip, as a moved held
   *  spot does (review 8, NIT-3; GM r11 3: the held spot's rule; GM r13). */
  const chipMovedAdds = useCallback((moved: ReadonlyArray<Extract<MoodboardOp, { op: 'add' }>>) => {
    if (!isCurrent()) return;
    const outside = moved.flatMap((op) => {
      const seen = addViews.get(op);
      if (!seen?.view || !op.at) return [];
      const rect = { x: op.at.x, y: op.at.y, width: seen.size[0], height: seen.size[1] };
      return outsideForChip(rect, seen.seen ?? seen.view) ? [{ rect, thumb: op.images[0]?.url ?? null }] : [];
    });
    if (outside.length === 0) return;
    outsideSeq.current += 1;
    setOutsideTiles({ id: outsideSeq.current, rects: outside.map((it) => it.rect), thumb: outside[0].thumb });
  }, [isCurrent]);

  const persist = useCallback(async () => {
    if (!isCurrent() || !await verifyProject() || !isCurrent()) return null;
    const store = useAssetStudioDraftStore.getState();
    const current = store.entries[key];
    const currentDraft = current?.draft as MoodboardDraft | undefined;
    if (!currentDraft || !currentDraft.name.trim() || !currentDraft.images.length) return null;
    const attempt = store.beginSave(key);
    if (!attempt) return null;
    urgent.current = false;
    try {
      const savedId = attempt.entry.savedId;
      let result: Moodboard | null = null;
      let repeated = false;
      if (!savedId) {
        const sent = new Set(currentDraft.pendingOps ?? []);
        const { requestId, attempt: tried } = createAttemptFor(key, currentDraft);
        const made = await createMoodboard(createBody(currentDraft, requestId, tried));
        // A repeat (round 6g): the board is the earlier send's, as it is now,
        // rebased on the attempt that made it; what came after replays and
        // goes next.
        if (made.repeated) {
          repeated = true;
          const current = draftNow();
          if (current) {
            const repeat = repeatOnBoard(key, current, made);
            store.patch(key, { draft: repeat.draft, thumbnail: made.thumbnail, notice: keptFromBoardLine(repeat.kept, made) });
          }
          rememberBrief(made);
        } else {
          moveDraft(made, sent, asSentOf(currentDraft));
        }
        result = made;
      } else {
        // Image edits go as checked edits, then the board fields the person
        // changed go on a PUT; both with the version last read. Someone else
        // saved since (409): take the board as it is, replay, send again.
        for (let tries = 0; ; tries += 1) {
          const snapshot = draftNow();
          if (!snapshot) return null;
          try {
            const ops = snapshot.pendingOps ?? [];
            let version = snapshot.version;
            // One batch per undo step, so each batch's `undo` is that step's.
            for (const batch of batchesOf(ops)) {
              const edited = await editMoodboard(savedId, sendableBatch(batch.ops), version);
              moveDraft(edited.board, new Set(batch.ops));
              result = edited.board;
              version = edited.board.version;
              if (batch.stepId) {
                const undo = (edited.undo?.ops ?? []) as MoodboardOp[];
                const undoStore = useBoardUndoStore.getState();
                // A batch that changed nothing: the step goes only if none of
                // it ever landed. An open note's later batch typed back to what
                // the server holds keeps the undo its first batch got.
                if (undo.length) undoStore.landed(key, batch.stepId, undo);
                else if (undoStore.history(key, epoch).done.find((step) => step.id === batch.stepId)?.state !== 'saved') {
                  undoStore.forget(key, batch.stepId);
                }
              }
            }
            const after = draftNow() ?? snapshot;
            const drafted = snapshot as Partial<Record<BoardFieldKey, unknown>>;
            const fields = after.base ? fieldChanges(trimmedName(after.base), trimmedName(drafted)) : createBody(snapshot);
            delete (fields as { images?: unknown }).images;
            // One PUT per field step (Q83), so each answer's `undo` is that step's.
            for (const group of fieldGroups(fields as Record<string, unknown>, (field) => fieldSteps.owner(field))) {
              if (group.stepId) fieldSteps.sending(group.stepId);
              const { undo, ...saved } = await updateMoodboard(savedId, {
                ...(group.fields as Parameters<typeof updateMoodboard>[1]),
                ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
                ...(version === undefined ? {} : { baseVersion: version }) });
              result = saved;
              version = saved.version;
              const asSent = Object.fromEntries(Object.keys(group.fields).filter((field) => field !== 'analysis')
                .map((field) => [field, drafted[field as BoardFieldKey]]));
              moveDraft(saved, undefined, asSent);
              const ops = (undo?.ops ?? []) as MoodboardOp[];
              if (group.stepId && ops.length) {
                useBoardUndoStore.getState().landed(key, group.stepId, ops);
                fieldSteps.landed(group.stepId);
              }
            }
            break;
          } catch (err) {
            if (!(err instanceof MoodboardVersionConflict) || tries >= 2) throw err;
            moveDraft(err.board);
            const rebased = draftNow();
            const moved = rebased ? freeQueuedAdds(rebased, key) : [];
            if (moved.length) {
              moveDraft(err.board);
              chipMovedAdds(moved);
            }
          }
        }
      }
      const thumbnail = result?.thumbnail ?? attempt.entry.thumbnail;
      const id = result?.id ?? savedId!;
      createsWaited.delete(key);
      forgetUnsentSteps();
      if (!store.finishSave(key, attempt.id, attempt.revision, id, thumbnail)) return null;
      if (repeated) markLeftToSend(key);
      if (!savedId && result) {
        const createdScope: AssetScope = result.projectId ? 'project' : 'global';
        const selectedAtCompletion = isCurrent();
        handOverDraft(key, assetStudioDraftKey('moodboard', createdScope, result.id, result.projectId));
        if (selectedAtCompletion) {
          setRailScope(createdScope);
          enterMoodboardEditor(result.id, createdScope);
        }
      }
      if (announced.current > (draftNow()?.version ?? 0)) void follow();
      dropWaitingSend(id);
      return id;
    } catch (err) {
      // Refused while offline: not sent, so no failure (GM r11 4: never an
      // empty error box). It waits; the autosave sends it on reconnect.
      // A new board's create cut off with Nebula then offline waits the same
      // way, and goes once on reconnect (round 6g, GM r15 4).
      if (isOfflineRefusal(err) || (!attempt.entry.savedId && await createWaits(key, err))) {
        if (useAssetStudioDraftStore.getState().entries[key]?.pendingSaveId === attempt.id) {
          store.patch(key, { pendingSaveId: null, dirty: true, saveState: 'draft' });
        }
        return null;
      }
      // Nothing is lost: the edit stays in the draft and Retry sends it again,
      // a saved board's own save as a new board's create, so both say r12's
      // neutral line (GM r14; round 6g, brief 7a).
      if (!attempt.entry.savedId && isCreateIdRefusal(err)) store.patch(key, { createRequestId: null });
      failBoardSave(key, attempt.id, err);
      return null;
    }
  }, [key, epoch, isCurrent, verifyProject, enterMoodboardEditor, moveDraft, draftNow, follow, forgetUnsentSteps, fieldSteps, chipMovedAdds,
    rememberBrief]);

  /** Text sends 600 ms after the last key, or when it loses focus. */
  const sendNow = () => {
    const entry = useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key)];
    if (entry?.dirty && !entry.pendingSaveId && canSave) void persist();
  };

  // Not while Nebula is offline: a write would be refused. Back online, what
  // waited goes.
  const offline = useBackendOffline();
  useEffect(() => {
    if (!loaded || !dirty || !canSave || pendingSaveId || saveState === 'error' || offline) return;
    const timer = window.setTimeout(() => { void persist(); }, urgent.current ? 0 : 600);
    return () => window.clearTimeout(timer);
  }, [loaded, dirty, canSave, pendingSaveId, saveState, draft, savedId, persist, offline]);

  /** Undo steps belong to a saved board: a new board's first save has no undo. */
  const canRecord = Boolean(savedId) && !isDraftId;
  useLayoutEffect(() => { steps.current = { key, epoch, canRecord }; }, [key, epoch, canRecord]);
  /** A board field's values now (its keys, fieldSteps.ts), to tell whether its step changed it. */
  const fieldValues = (field: FieldStep) => {
    const current = (draftNow() ?? draft) as unknown as Record<string, unknown>;
    return fieldStepKeys(field).map((name) => current[name]);
  };
  /** A board field is about to change: its step opens (it joins one already open). */
  const beginField = (field: FieldStep) => { if (isCurrent()) fieldSteps.begin(field, fieldValues(field)); };
  /** The field lost focus, or a control's change is done: its step closes.
   *  A text field's blur sends what waits ('now'); a control's step goes at
   *  once, but only when it changed something ('soon'). */
  const endField = (field: FieldStep, send: 'now' | 'soon' = 'now') => {
    const closed = fieldSteps.end(field, fieldValues(field));
    if (send === 'now') sendNow();
    else if (closed) sendSoon();
  };
  /** A control's change (a pick, a switch, a mode): one step, sent at once
   *  (or, `send: false`, by whatever saves next). */
  const changeField = (field: FieldStep, apply: () => void, send = true) => {
    beginField(field);
    apply();
    if (send) endField(field, 'soon');
    else fieldSteps.end(field, fieldValues(field));
  };
  /** A step for `ops`, which the caller is about to queue (lib/boardUndo). */
  const recordStep = (label: string, ops: MoodboardOp[], joinKey?: string, open?: boolean): string | null => {
    if (!canRecord || ops.length === 0) return null;
    return useBoardUndoStore.getState().record(key, epoch, label, ops, joinKey, open);
  };
  /** Send the queue now: a drag, a drop or a removal doesn't wait 600 ms. */
  const sendSoon = () => {
    urgent.current = true;
    const entry = useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key)];
    if (entry?.dirty && !entry.pendingSaveId) void persist();
  };
  /** Image ops as one step: applied to the draft at once, queued, and sent now when `now`. */
  const commitOps = (ops: MoodboardOp[], label: string,
    options: { now?: boolean; aspects?: Record<string, number>; joinKey?: string } = {}) => {
    if (ops.length === 0 || !isCurrent()) return null;
    const stepId = recordStep(label, ops, options.joinKey);
    setDraft((current) => {
      const images = applyOps(current.images, ops, { aspects: options.aspects });
      return {
        ...current,
        analysis: ops.some(opSteers) ? null : current.analysis,
        images,
        coverImageId: coverAfter(current.coverImageId ?? null, ops, images),
        pendingOps: queueOps(current.pendingOps, ops),
      };
    });
    if (options.now) sendSoon();
    return stepId;
  };
  const numberOf = (images: MoodboardImage[], id: string) => images.findIndex((image) => image.id === id) + 1;

  const uploadFiles = (files: File[]) => Promise.all(files.map((file) => {
    const fd = new FormData();
    fd.append('file', file);
    return apiRequest(`Couldn't upload ${file.name || 'the image'}.`, '/api/uploads', { method: 'POST', body: fd })
      .then((r) => r.json())
      .then((data: { url: string }) => data.url);
  }));

  // The open board takes an add as its own step (its undo), whichever add
  // started it: one on this visit, or one started before the person left and
  // came back (boardAdds.ts).
  const landHere = useRef<OpenBoard['commit']>(() => false);
  useLayoutEffect(() => {
    // Taken only if the ops were applied (review 5, M17): a Studio still
    // drawn but no longer current (left mid-render, its project changing)
    // takes nothing, so the add lands through the draft store instead of
    // being lost. Applied, not "an undo step recorded": an unsaved board
    // records none, and its add mustn't also go the away path (review 6,
    // MEDIUM-1).
    landHere.current = (ops, label, aspects, now) => {
      if (ops.length === 0 || !isCurrent()) return false;
      commitOps(ops, label, { now, aspects });
      return true;
    };
  });
  useLayoutEffect(() => {
    if (!loaded) return undefined;
    const board: OpenBoard = { key, commit: (ops, label, aspects, now) => landHere.current(ops, label, aspects, now) };
    setOpenBoard(board);
    return () => clearOpenBoard(board);
  }, [loaded, key]);

  /** Files added to the board: pasted, dropped or picked with Add images, in
   *  Board or List. On the Board they are sized from their aspect and placed
   *  by lib/boardPlacement (one helper for all three, GM's #210 rulings):
   *  never on top of a tile, in view when there's room, else just outside it
   *  with the edge chip, in the view the person had when they added them (GM
   *  r4 answer 1). A placeholder tile holds each spot at once while the
   *  upload runs, and the upload fills it where it sits, as one step sent at
   *  once. From the List (`target` null) each file is an uploading row, and
   *  the images go at the end of the board, as Add Images always put them.
   *  A failed upload takes its placeholders (and their chip) away.
   *
   *  The add belongs to its board, not to the view (GM on review 4): if the
   *  person leaves the board while it uploads (another board, or out of the
   *  Studio), it still lands on that board, placed as if they had stayed,
   *  and written through the draft store, never to the board open now. */
  const addFiles = (files: File[], target: BoardTarget | null, board: BoardRef = trackBoard(key)): Promise<void> => {
    if (files.length === 0) return Promise.resolve();
    // Still this Studio on the add's board (the chip and the toast are this view's).
    const here = () => isCurrent() && openBoardFor(board) !== null;
    // Each new add replaces the last one's chip.
    if (target) setOutsideTiles(null);
    const uploads = uploadFiles(files);
    // Read once the spots are held; until then a refusal waits here.
    uploads.catch(() => {});
    let held: BoardPlaceholder[] = [];
    let all: BoardPlaceholder[] = [];
    let chip: number | null = null;
    const release = () => {
      releaseHeld(held.map((holder) => holder.id));
      held = [];
    };
    const rectOf = (card: MoodboardPlacement) => ({ x: card.x, y: card.y, width: card.w, height: card.h });
    return Promise.all(files.map((file) => readImageAspect(file)))
      .then(async (aspects) => {
        const sizes = aspects.map((aspect) => sizeFor(1, aspect));
        let outside: number[] = [];
        if (target) {
          // The board's tiles and the spots earlier adds still hold.
          const occupied = [...boardImages(board.key).flatMap((image) => (image.placements ?? []).map(rectOf)),
            ...heldOn(useBoardAddStore.getState().held, board.key).filter((holder) => !holder.listOnly)];
          const placed = placeTiles({ at: target.at, sizes, occupied, view: target.view, seen: target.seen, aim: target.aim, band: target.band });
          outside = placed.outside;
          held = placed.spots.map((spot, index) => ({ id: nextHolderId(), ...spot, width: sizes[index][0], height: sizes[index][1],
            source: { kind: 'file' as const, name: files[index].name }, board }));
        } else {
          held = files.map((file) => ({ id: nextHolderId(), x: 0, y: 0, width: 0, height: 0, listOnly: true,
            source: { kind: 'file' as const, name: file.name }, board }));
        }
        const holders = held;
        all = holders;
        addHeld(holders);
        // A reload from here on loses these: the board's next open says so
        // (GM r8 answer 5), once it has an id (review 6, LOW-3).
        recordPending(board, holders.map((holder, index) => ({ id: holder.id, name: files[index].name })));
        if (outside.length > 0 && here()) {
          outsideSeq.current += 1;
          chip = outsideSeq.current;
          setOutsideTiles({ id: chip, thumb: null,
            rects: outside.map((index) => ({ x: holders[index].x, y: holders[index].y, width: holders[index].width, height: holders[index].height })) });
        }
        let urls: string[];
        try {
          urls = await uploads;
        } catch (err) {
          // The chip pointed at spots that are gone now.
          const gone = chip;
          if (gone !== null) setOutsideTiles((current) => (current?.id === gone ? null : current));
          release();
          throw err;
        }
        const batch = new Set(holders.map((holder) => holder.id));
        // A file the server gave no image for holds nothing from here on.
        const live = holders.map((_, index) => Boolean(urls[index]));
        // The board as it is now. A saved board that isn't open is read from
        // the server: its draft is as the person left it, and someone may
        // have added to it since (review 5, LOW-5).
        let images = boardImages(board.key);
        if (target && !openBoardFor(board) && boardStanding(board) !== 'gone' && board.savedId) {
          const fresh = await fetchMoodboard(board.savedId).catch(() => null);
          if (fresh) images = fresh.images;
        }
        // The board may have changed under a held spot meanwhile (an Undo, an
        // agent's add, a drag): a spot now on a tile moves to the nearest free
        // one, in the view the person had (review 3, LOW-2; GM: move). The
        // batch's spots still free keep theirs and are counted first, so a
        // moved one never pushes a sibling off a spot the board left alone
        // (review 4, LOW-2).
        const moved = new Map<string, { x: number; y: number }>();
        if (target) {
          const taken = [...images.flatMap((image) => (image.placements ?? []).map(rectOf)),
            ...heldOn(useBoardAddStore.getState().held, board.key).filter((holder) => !batch.has(holder.id) && !holder.listOnly)];
          const rect = (holder: BoardPlaceholder) => ({ x: holder.x, y: holder.y, width: holder.width, height: holder.height });
          const blocked = holders.filter((holder, index) => live[index] && !spotFree(rect(holder), taken));
          for (const holder of holders) if (live[holders.indexOf(holder)] && !blocked.includes(holder)) taken.push(rect(holder));
          for (const holder of blocked) {
            const spot = respot(rect(holder), taken, target.view, target.band);
            moved.set(holder.id, spot);
            taken.push({ ...rect(holder), ...spot });
          }
        }
        const spotOf = (holder: BoardPlaceholder) => moved.get(holder.id) ?? { x: holder.x, y: holder.y };
        // The new images' ids, made here so the fill can be keyed by them (review 4, MEDIUM-1).
        const placed = holders.flatMap((holder, index) => (live[index]
          ? [{ holder, url: urls[index], aspect: aspects[index], imageId: createDraftImage(urls[index]).id, at: spotOf(holder) }] : []));
        // A spot with no image goes now.
        held = holders.filter((_, index) => !live[index]);
        release();
        held = placed.map((item) => item.holder);
        if (placed.length === 0) return;
        const ops: MoodboardOp[] = target
          ? placed.map((item) => ({ op: 'add', images: [{ id: item.imageId, url: item.url }], at: item.at }))
          : [{ op: 'add', images: placed.map((item) => ({ id: item.imageId, url: item.url })) }];
        if (target) ops.forEach((op, index) => addViews.set(op, { view: target.view, seen: target.seen, band: Boolean(target.band),
          size: [placed[index].holder.width, placed[index].holder.height] }));
        const count = images.length;
        const label = placed.length === 1 ? `Added #${count + 1}` : `Added ${placed.length} references`;
        // On the Board the new cards are sized from their aspect at once; a List add leaves that to the server, as it always has.
        const aspectsOf: Record<string, number> = target ? Object.fromEntries(placed.map((item) => [item.url, item.aspect])) : {};
        // Each uploaded image takes its spot: its placeholder stays under it
        // while it fades in (the board drops it then, `dropFilled`).
        const fills = new Map(placed.map((item) => [item.holder.id, item] as const));
        const fill = (away: boolean) => changeHeld(fills.keys(), (holder) => {
          const item = fills.get(holder.id)!;
          return { ...holder, ...item.at, filled: { imageId: item.imageId, url: item.url }, away };
        });
        const open = openBoardFor(board);
        if (open && target) {
          fill(false);
          // If no board is drawn to run the fade (List meanwhile), it goes anyway.
          window.setTimeout(() => releaseFilled([...fills.keys()]), FILL_FALLBACK_MS);
        }
        // A Board add is sent at once; a List add waits for the List's usual save.
        if (open?.commit(ops, label, aspectsOf, Boolean(target))) {
          // Rows (List) and spots that won't fade go now; filled spots wait for their fade.
          if (!target) release(); else held = [];
          if (target && here()) followMovedSpots(chip, holders, live, spotOf, target, urls);
          return;
        }
        // Not open here any more: it lands on its own board (GM on review 4).
        if (!target) release();
        try {
          if (!await landAway(board, ops, aspectsOf)) return;
        } catch (err) {
          if (!(err instanceof AwayWriteFailed)) throw err;
          keepFailedAway(board, ops, aspectsOf, err.failure, placed.map((item) => placeholderLabel(item.holder.source)));
          return;
        }
        // Landed: its spots wait, filled, for the person to come back to the
        // board, where the images fade in with the chip if outside the view
        // (GM r8, review 5 LOW-3). If they're on it again already, now.
        if (target) {
          fill(true);
          held = [];
        }
      })
      .catch((err: unknown) => {
        // Refused while offline (a drop or paste on a paused board): nothing
        // was sent, the banner pulsed, and no empty line shows (GM r12 2).
        if (isOfflineRefusal(err)) return;
        const line = failureCopy(err, { heading: "Couldn't upload the image." });
        // On the board the add was made on, wherever the person is now.
        if (here()) patch({ saveError: line });
        else if (boardStanding(board) !== 'gone') {
          const store = useAssetStudioDraftStore.getState();
          store.patch(resolveAssetStudioDraftKey(store, board.key), { saveError: line });
        }
      })
      .finally(() => {
        release();
        clearPending(all.map((holder) => holder.id));
        untrackBoard(board);
      });
  };

  /** The chip after a held spot moved (review 4, LOW-3): it points at where
   *  the tiles are now. A moved spot with less than half of it in the
   *  paste-time view joins it (a new chip if there was none; GM r13); one
   *  that came into view leaves it. Its thumbnail is the first outside tile's
   *  image, now that it has landed (review 9 NIT-1: a moved spot's chip had none). */
  const followMovedSpots = (chip: number | null, holders: BoardPlaceholder[], live: boolean[],
    spotOf: (holder: BoardPlaceholder) => { x: number; y: number }, target: BoardTarget, urls: ReadonlyArray<string | undefined>) => {
    const view = target.view;
    if (!view) return;
    let firstThumb: string | null = null;
    const rects = holders.flatMap((holder, index) => {
      if (!live[index]) return [];
      const rect = { ...spotOf(holder), width: holder.width, height: holder.height };
      // An aimed tile counts as outside only when wholly out of view (GM r4
      // answers 3 and 4), or reaching into the toolbar band (lib/boardPlacement);
      // any tile only while less than half of it is in view (GM r13).
      const bottom = view.y + view.height;
      const aimedOut = !(target.aim && index === 0)
        || rect.x >= view.x + view.width || rect.x + rect.width <= view.x || rect.y >= bottom || rect.y + rect.height <= view.y
        || Boolean(target.band && rect.y + rect.height > bottom);
      if (!aimedOut || !outsideForChip(rect, target.seen ?? view)) return [];
      firstThumb ??= urls[index] ?? null;
      return [rect];
    });
    if (chip !== null) {
      setOutsideTiles((current) => (current?.id !== chip ? current
        : rects.length ? { ...current, rects, thumb: current.thumb ?? firstThumb } : null));
    } else if (rects.length) {
      outsideSeq.current += 1;
      setOutsideTiles({ id: outsideSeq.current, rects, thumb: firstThumb });
    }
  };

  const handleFiles = (files: FileList | File[] | null): Promise<void> => addFilesOnce(Array.from(files ?? []), null);

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'));
    void handleFiles(files);
  };

  /** Files dropped, added or pasted on the Board view (BoardCanvas's `onDropFiles`). */
  const dropFiles = (files: File[], target: BoardTarget): Promise<void> => {
    // The chip goes at once, as on a paste (each new add replaces it).
    setOutsideTiles(null);
    return addFilesOnce(files, target);
  };

  const updateImage = (id: string, patch: Partial<MoodboardImage>) => {
    // Only what the analysis reads clears it: a private note or a card's
    // place keeps it.
    const steers = patchSteers(patch);
    const ops = imagePatchOps(id, patch);
    // A note or a weight being set joins its step until the step is sent.
    const typed = 'notes' in patch || 'privateNote' in patch;
    const joinKey = typed || ('weight' in patch && !('excluded' in patch)) ? ops.map(opKey).join('+') : undefined;
    // A note is one step until its box loses focus (Q83), however often it saved meanwhile.
    recordStep(imagePatchLabel(patch, numberOf(draftNow()?.images ?? draft.images, id)), ops, joinKey, typed);
    setDraft((current) => ({
      ...current,
      analysis: steers ? null : current.analysis,
      images: current.images.map((img) => (img.id === id ? { ...img, ...patch } : img)),
      pendingOps: queueOps(current.pendingOps, ops),
    }));
  };

  /** An image's note box lost focus: its step is done, and it saves now. */
  const imageTextDone = () => {
    useBoardUndoStore.getState().seal(key);
    sendNow();
  };

  /** Remove references as one step, sent at once, with Undo in the toast (Q15). */
  const removeImages = (ids: string[]) => {
    if (ids.length === 0) return;
    const images = draftNow()?.images ?? draft.images;
    const label = ids.length === 1 ? `Removed #${numberOf(images, ids[0])}` : `Removed ${ids.length} references`;
    const stepId = commitOps([{ op: 'remove', images: ids }], label, { now: true });
    if (stepId) showToast({ text: label, action: { label: 'Undo', run: () => { void runUndo('undo', stepId); } }, undoOf: stepId });
  };
  const removeImage = (id: string) => removeImages([id]);

  /** Cards moved on the board: one `place` op each, one step, sent at once. */
  const moveCards = (moves: BoardMove[]) => {
    if (moves.length === 0) return;
    const images = draftNow()?.images ?? draft.images;
    const owner = images.findIndex((image) => image.placements?.some((card) => card.id === moves[0].placement));
    const label = moves.length === 1 ? `Moved #${owner + 1}` : `Moved ${moves.length} references`;
    commitOps(moves.map(({ placement, x, y }) => ({ op: 'place', placement, x, y })), label, { now: true });
  };

  /** Resolves once the open board has no save in flight (at most 10 s). */
  const saveSettled = useCallback(() => new Promise<void>((resolve) => {
    const busy = () => Boolean(useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(
      useAssetStudioDraftStore.getState(), key)]?.pendingSaveId);
    if (!busy()) {
      resolve();
      return;
    }
    let unsubscribe = () => {};
    const done = () => {
      window.clearTimeout(timer);
      unsubscribe();
      resolve();
    };
    const timer = window.setTimeout(done, 10_000);
    unsubscribe = useAssetStudioDraftStore.subscribe(() => { if (!busy()) done(); });
  }), [key]);

  /** Undo (or redo) a step of this tab's (plan section 5.4). Edits not sent
   *  yet go first, so the step undone is the one the person sees last. The
   *  undo is the `restore` the server gave for the step's batch: it puts back
   *  only what is still as the step left it and names the rest. Its answer
   *  carries the `restore` that redoes it, checked the same way; the step's
   *  own ops are the fallback. Sent without `baseVersion`: a restore is
   *  checked slice by slice instead. */
  const runUndo = async (direction: 'undo' | 'redo', stepId?: string) => {
    if (!isCurrent() || !savedId || isDraftId) return;
    // A field step still open (a slider never let go) closes first.
    fieldSteps.endAll(fieldValues);
    // A step still saving (a Cmd+Z right after a drag), an earlier undo still
    // on its way, or edits not sent yet: wait for them, so this undo takes
    // the step the person sees last and is never dropped for a busy save.
    for (let tries = 0; tries < 5; tries += 1) {
      await saveSettled();
      if (!isCurrent()) return;
      const entry = useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key)];
      if (entry?.pendingSaveId) continue;
      if (!entry?.dirty || !canSave) break;
      await persist();
    }
    if (!isCurrent()) return;
    const undoStore = useBoardUndoStore.getState();
    // The newest step is a field change nothing could save (a blank name, a
    // board with no images): none of it is on the server, so undoing it is
    // putting the field back in the draft. Then the step under it is next.
    const unsent = draftNow();
    if (direction === 'undo' && !stepId && unsent && (!unsent.name.trim() || !unsent.images.length)) {
      const { done } = undoStore.history(key, epoch);
      const top = done[done.length - 1];
      const start = top?.fields && top.state === 'pending' ? fieldSteps.unsentStart(top.id) : undefined;
      if (top?.fields && start) {
        const fields = top.fields;
        setDraft((current) => {
          const next = { ...current, ...Object.fromEntries(fields.map((field, index) => [field, start[index]])) };
          // Mode, strength and notes clear the analysis when they change: back
          // as the board has them, with nothing else steering queued, the
          // analysis the server holds still fits, so it is kept, not cleared.
          const base = current.base;
          const fits = base && base.analysis != null && next.analysis == null
            && STEERING_FIELDS.every((field) => sameValue(next[field], base[field]))
            && !(next.pendingOps ?? []).some(opSteers);
          return fits ? { ...next, analysis: base.analysis as MoodboardDraft['analysis'] } : next;
        });
        fieldSteps.release(top.id);
        undoStore.forget(key, top.id);
        showUndone({ text: `Undid: ${top.label}` }, top.id);
        return;
      }
    }
    const step: BoardUndoStep | null = direction === 'undo' ? undoStore.takeUndo(key, epoch, stepId) : undoStore.takeRedo(key, epoch);
    if (!step) return;
    const from = direction === 'undo' ? 'done' : 'undone';
    // Redo is only ever the undo's own checked `restore`, never the step's
    // ops again: those would overwrite what changed since.
    const ops = direction === 'undo' ? step.undo ?? [] : step.redo ?? [];
    const store = useAssetStudioDraftStore.getState();
    const attempt = store.beginSave(key);
    if (!attempt || ops.length === 0) {
      undoStore.restoreTaken(key, step, from);
      return;
    }
    try {
      const edited = await editMoodboard(savedId, ops);
      moveDraft(edited.board);
      const next = (edited.undo?.ops ?? []) as MoodboardOp[];
      // Put nothing back (all of it changed since): there is nothing to redo
      // (or undo again), so the step goes rather than wait to overwrite it.
      if (!next.length) undoStore.forget(key, step.id);
      else if (direction === 'undo') undoStore.redone(key, step.id, next);
      else undoStore.reapplied(key, step.id, next);
      store.finishSave(key, attempt.id, attempt.revision, savedId, edited.board.thumbnail ?? attempt.entry.thumbnail);
      if (!isCurrent()) return;
      const line = { text: `${direction === 'undo' ? 'Undid' : 'Redid'}: ${step.label}`, skipped: skippedLines(edited),
        action: direction === 'undo' && next.length ? { label: 'Redo' as const, run: () => { void runUndo('redo'); } } : undefined };
      if (direction === 'undo') showUndone(line, step.id);
      else showToast(line);
    } catch (err) {
      undoStore.restoreTaken(key, step, from);
      // The step names its own action (the edit request's heading is the
      // board save's), and the toolbar's Retry runs the same undo (or redo)
      // of this step again (GM, round 3: "Make Retry redo the failed action").
      store.failSave(key, attempt.id, {
        ...failureCopy(err),
        heading: direction === 'undo' ? "Couldn't undo the change." : "Couldn't redo the change.",
      }, { retry: direction, step: step.id });
    }
  };

  // The Studio's keys (plan section 5.4): on the document, in the capture
  // phase, so they run before the canvas's own (GraphFileActions' Cmd+S
  // yields to a handled key) and work wherever focus is in the Studio,
  // except text fields and dialogs. Read through a ref: the handler stays
  // bound once and always sees this render.
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  useLayoutEffect(() => {
    keyHandler.current = (event: KeyboardEvent) => {
      const action = studioKey(event);
      if (!action || action === 'fit' || event.defaultPrevented || !isStudioShortcutTarget(event.target, action)) return;
      if (action === 'save') {
        event.preventDefault();
        if (!loading) sendSoon();
        return;
      }
      if (action === 'delete') {
        if (view !== 'board' || selectedIds.length === 0 || loading) return;
        event.preventDefault();
        removeImages(selectedIds);
        return;
      }
      event.preventDefault();
      void runUndo(action);
    };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => keyHandler.current(event);
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  // Cmd+V (Justin decided, 2026-10-31): the clipboard's images join the
  // board as a drop's do, through the same upload, checks and one undo
  // step. Board view: the shared placement from the pointer, else the middle
  // of the view (lib/boardPlacement). List view: at the end, in clipboard
  // order. A paste meant for a text field (Direction, Avoid, a colour, a
  // note) or a dialog stays the field's. Bound only while the Studio is
  // mounted, so no other screen gets it. A paste another listener already
  // handled (defaultPrevented) is left alone. Nothing in the Studio refuses
  // a paste for a tab following an agent's switch, as nothing refuses a
  // drop there (hooks/useFollowingReadOnly is the canvas's only).
  const pasteTarget = useRef<(() => BoardTarget) | null>(null);
  const pasteHandler = useRef<(event: ClipboardEvent) => void>(() => {});
  // One physical press is one paste (GM, #210 review answer 2): the paste
  // events of a held Cmd/Ctrl+V's repeats are ignored. Only a repeat keydown
  // of the paste key sets it; any other keydown, the window losing focus or
  // the page being hidden clears it (a keyup that went elsewhere must not
  // swallow a later Edit > Paste, review 2 L1). Edit > Paste (no keydown)
  // and separate presses always add.
  const heldPaste = useRef(false);
  // The backstop if the shell's key events aren't reliable: files still
  // being added to this board from an earlier add, by size, type and bytes
  // hash. An identical file meanwhile is ignored, silently on screen with a
  // polite announcement (GM r4 answer 7); a different one goes, and so does
  // the same image on another board (GM r8 answer 3). Kept per board in
  // boardAdds.ts, so it holds across a board switch and the Studio closing.
  const addFilesOnce = (files: File[], target: BoardTarget | null) => {
    const board = trackBoard(key);
    return claimFiles(board, () => Promise.all(files.map(fileSignature))).then(async ({ free, release }) => {
      const fresh = files.filter((_, index) => free[index]);
      if (fresh.length < files.length) announce(ALREADY_BEING_ADDED);
      try {
        if (fresh.length > 0) await addFiles(fresh, target, board);
      } finally {
        release();
        if (fresh.length === 0) untrackBoard(board);
      }
    });
  };
  // Back on a board an add landed on while the person was away (GM r8,
  // review 5 LOW-3): the new images fade in over their spots as any arrival
  // does, with the edge chip for those outside the view. No new line. (A
  // kept draft reads its board again on each open, so a landing its draft
  // couldn't take shows then.)
  const awayHere = useMemo(() => placeholders.filter((holder) => holder.away), [placeholders]);
  useEffect(() => {
    if (!loaded || awayHere.length === 0) return undefined;
    const ids = awayHere.map((holder) => holder.id);
    changeHeld(ids, (holder) => ({ ...holder, away: false }));
    // The List has no fade: they go. On the Board, the fade drops them, or this does if it can't run.
    if (view !== 'board') {
      releaseFilled(ids);
      return undefined;
    }
    const timer = window.setTimeout(() => releaseFilled(ids), FILL_FALLBACK_MS);
    let frame = 0;
    let tries = 0;
    const chipFor = () => {
      frame = 0;
      const shown = pasteTarget.current?.();
      const shownView = shown?.seen ?? shown?.view ?? null;
      if (!shownView) {
        if (tries++ < 60) frame = window.requestAnimationFrame(chipFor);
        return;
      }
      const rects = awayHere.map((holder) => ({ x: holder.x, y: holder.y, width: holder.width, height: holder.height }))
        .filter((rect) => outsideForChip(rect, shownView));
      if (rects.length === 0) return;
      outsideSeq.current += 1;
      setOutsideTiles({ id: outsideSeq.current, rects, thumb: awayHere[0].filled?.url ?? null });
    };
    chipFor();
    return () => { window.clearTimeout(timer); if (frame) window.cancelAnimationFrame(frame); };
  }, [loaded, awayHere, view]);
  // Adds a reload lost on their way here (GM r8 answer 5): said once, on this board's next open.
  useEffect(() => {
    if (!loaded || !savedId) return;
    // A send that waited for Nebula when this tab reloaded (GM r11 4): back
    // in the draft, which sends it. An add the board holds already went.
    const waiting = takeWaitingSend(savedId);
    if (waiting) {
      useAssetStudioDraftStore.getState().edit(key, (stored) => {
        const current = stored as MoodboardDraft;
        const has = new Set(current.images.flatMap((image) => [image.id, image.url]));
        const ops = waiting.ops.filter((op) => op.op !== 'add' || !op.images.some((image) => has.has(image.url) || (image.id && has.has(image.id))));
        const images = applyOps(current.images, ops);
        return { ...current, ...(waiting.fields as Partial<MoodboardDraft>), images,
          coverImageId: coverAfter(current.coverImageId ?? null, ops, images), pendingOps: queueOps(current.pendingOps, ops) };
      });
    }
    const lost = takeReloadLost(savedId);
    if (lost.length) showInfoLine(reloadLostLine(lost));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open of the board
  }, [loaded, savedId]);
  useLayoutEffect(() => {
    pasteHandler.current = (event: ClipboardEvent) => {
      if (event.defaultPrevented || loading || !isCurrent() || !isStudioPasteTarget(event.target)) return;
      if (heldPaste.current) {
        event.preventDefault();
        return;
      }
      const { files, links } = readClipboardImages(event.clipboardData);
      // The next paste replaces the last one's chip, whatever it holds.
      setOutsideTiles(null);
      if (files.length > 0) {
        event.preventDefault();
        void addFilesOnce(files, view === 'board' ? pasteTarget.current?.() ?? null : null);
        return;
      }
      event.preventDefault();
      // Only links: Nebula fetches none for a board yet (decision D6; pasted
      // links come in their own PR), so it says so and adds nothing (GM, #210 item 2).
      showInfoLine(links.length > 0 ? LINKS_NOT_ADDED : NOTHING_TO_PASTE);
    };
  });
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => pasteHandler.current(event);
    // By the key or its place (KeyV), so a non-Latin layout counts too.
    const isV = (event: KeyboardEvent) => event.key.toLowerCase() === 'v' || event.code === 'KeyV';
    const isPasteKey = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey) && !event.altKey && isV(event);
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.repeat) heldPaste.current = false;
      else if (isPasteKey(event)) heldPaste.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (isV(event) || event.key === 'Meta' || event.key === 'Control') heldPaste.current = false;
    };
    const release = () => { heldPaste.current = false; };
    document.addEventListener('paste', onPaste);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    return () => {
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
    };
  }, []);

  /** The image the board opens on, or null for #1: a pick, not a reorder,
   *  so no image moves and the analysis stays. One undo step, like any image
   *  change: its batch's `undo` restores the cover field. Picks made before
   *  the step is sent join it, so one undo goes back to the cover before them. */
  const setCover = (id: string | null) => {
    const label = id ? `Made #${numberOf(draftNow()?.images ?? draft.images, id)} the cover` : 'Cover back to #1';
    commitOps([{ op: 'cover', image: id }], label, { joinKey: 'cover' });
  };

  const runAnalyze = async () => {
    if (!isCurrent() || !await verifyProject() || !isCurrent()) return;
    // Read from the store, not this render: a change made just before (such
    // as Regenerate dropping the override) must be saved first.
    const entry = useAssetStudioDraftStore.getState().entries[key];
    const id = entry?.dirty || !entry?.savedId ? await persist() : entry.savedId;
    if (!id || !mounted.current) return;
    const ui = useUIStore.getState();
    if (ui.viewMode !== 'moodboard-editor') return;
    const store = useAssetStudioDraftStore.getState();
    const openProjectId = currentProject()?.id ?? null;
    const targetKey = assetStudioDraftKey('moodboard', ui.moodboardEditorScope, id, openProjectId);
    const selectedKey = resolveAssetStudioDraftKey(store, assetStudioDraftKey('moodboard', ui.moodboardEditorScope, ui.moodboardEditorId, openProjectId));
    if (selectedKey !== targetKey) return;
    const target = store.entries[targetKey];
    if (!target || target.pendingSaveId || target.dirty) {
      store.patch(targetKey, { saveError: 'Settings changed while saving. Analyze again when ready.' });
      return;
    }
    const attempt = store.beginAnalysis(targetKey);
    if (!attempt) return;
    const ownsAnalysis = () => {
      const selected = useUIStore.getState();
      const latest = useAssetStudioDraftStore.getState();
      return mounted.current && selected.viewMode === 'moodboard-editor'
        && resolveAssetStudioDraftKey(latest, assetStudioDraftKey('moodboard', selected.moodboardEditorScope,
          selected.moodboardEditorId, currentProject()?.id ?? null)) === targetKey
        && latest.entries[targetKey]?.revision === attempt.revision
        && latest.entries[targetKey]?.pendingAnalysisId === attempt.id;
    };
    try {
      const updated = await analyzeMoodboard(id);
      rememberBrief(updated);
      if (ownsAnalysis()) store.patch(targetKey, { draft: moodboardToDraft(updated), savedId: updated.id,
        thumbnail: updated.thumbnail, dirty: false, loaded: true, saveState: 'saved' });
    } catch (err) {
      if (ownsAnalysis()) {
        store.patch(targetKey, { saveError: failureCopy(err, { heading: "Couldn't analyze the board." }), saveState: 'error',
          retry: 'analyze', retryStep: null });
      }
    } finally {
      store.clearAnalysis(targetKey, attempt.id);
    }
  };

  // Brief fields don't feed the analysis, so changing them keeps it.
  const setBriefFields = (fields: Partial<Pick<MoodboardDraft, 'direction' | 'avoid' | 'pinnedColors' | 'briefOverride'
    | 'clashMode' | 'colorChoices' | 'sendNotes'>>) => {
    setDraft((current) => {
      const next = { ...withBriefFields(current), ...fields };
      // A colour pinned to keep out can't also be kept anyway: the pin wins.
      if (fields.pinnedColors && next.colorChoices) {
        const out = new Set(next.pinnedColors.exclude);
        next.colorChoices = { ...next.colorChoices, keep: next.colorChoices.keep.filter((hex) => !out.has(hex)) };
      }
      return next;
    });
  };
  const chooseColors = (choice: ColorChoice, hexes: string[]) => changeField('colorChoices', () => {
    setDraft((current) => {
      const board = withBriefFields(current);
      return { ...board, colorChoices: nextColorChoices(board.colorChoices, choice, hexes) };
    });
  });

  const keepOverride = async () => {
    if (!isCurrent()) return;
    const id = dirty || !savedId ? await persist() : savedId;
    if (!id || !isCurrent()) return;
    try {
      const kept = await keepMoodboardBriefOverride(id);
      // Keep writes the board (a new version): the draft follows, so its next save isn't a 409.
      if (isCurrent() && !useAssetStudioDraftStore.getState().entries[key]?.pendingSaveId) moveDraft(kept);
      else rememberBrief(kept);
    } catch (err) {
      if (isCurrent()) patch({ saveError: failureCopy(err, { heading: "Couldn't save your brief." }) });
    }
  };

  const regenerateBrief = () => {
    // Not sent here: Analyze, when it runs, saves first.
    changeField('briefOverride', () => setBriefFields({ briefOverride: null }), false);
    // The generated brief needs an analysis of the board as it is now.
    if (!draft.analysis) void runAnalyze();
  };

  /** Where the person is in the Studio now (null: not in it). */
  const routeNow = () => {
    const ui = useUIStore.getState();
    return mounted.current && ui.viewMode === 'moodboard-editor' ? { id: ui.moodboardEditorId, scope: ui.moodboardEditorScope } : null;
  };
  /** True while the person is still where they were at `route`, or on the
   *  board `savedId` that a draft open there was just saved as (the Studio
   *  follows a first save). New and a delete await a save; if the person
   *  picked another board or left meanwhile, they aren't pulled back
   *  (review 6, NIT-5). */
  const stillOn = (route: ReturnType<typeof routeNow>, savedId: string | null) => {
    const now = routeNow();
    return route !== null && now !== null && now.scope === route.scope
      && (now.id === route.id || (savedId !== null && now.id === savedId));
  };
  const deleting = useAssetDelete('moodboard');

  // Kept edits whose boards were deleted before they could replay (round 6j,
  // GM r18): looked up when the Studio opens, and again after a board
  // changes or a delete. One in Recently deleted gets the neutral line with
  // Restore; one gone for good gets the red line, and its edit is dropped
  // once that line is up (nothing could replay it).
  const [goneEdits, setGoneEdits] = useState<{ trashed: GoneBoard[]; purged: GoneBoard[] }>({ trashed: [], purged: [] });
  // The red line goes by its × or when another board opens (GM r19 1); its edits are already dropped.
  const [purgedOn, setPurgedOn] = useState(moodboardEditorId);
  if (purgedOn !== moodboardEditorId) {
    setPurgedOn(moodboardEditorId);
    if (goneEdits.purged.length) setGoneEdits({ ...goneEdits, purged: [] });
  }
  const [restoreError, setRestoreError] = useState<FailureCopy | null>(null);
  const [trashRequest, setTrashRequest] = useState<(TrashOpenRequest & { scope: AssetScope }) | null>(null);
  // The boards a Restore is bringing back (GM r19 2, 3): once each is loaded (so back, its kept edit replayed)
  // and saved, one confirmation names them, on the board open then. A board in the trash never loads.
  const [restoring, setRestoring] = useState<string[] | null>(null);
  const [restoredLine, setRestoredLine] = useState<{ text: string; title: string; at: string | null } | null>(null);
  // Read only while a Restore waits on its boards' saves.
  const draftEntries = useAssetStudioDraftStore((state) => (restoring ? state.entries : null));
  if (restoring && draftEntries) {
    const saved = restoring.map((id) => Object.values(draftEntries).find((entry) => entry.savedId === id && entry.loaded));
    // Dirty until its save lands (a save out leaves it dirty), so clean here is saved.
    if (saved.every((entry) => entry && !entry.dirty)) {
      setRestoring(null);
      setRestoredLine({ ...restoredBoardsLine(saved.map((entry) => String((entry!.draft as MoodboardDraft).name ?? ''))), at: moodboardEditorId });
    }
  }
  /** A board the line named came back (its Restore, or Recently deleted's): the line names the ones left, and
   *  either way it is confirmed once saved (GM r19 2: the two Restores match). */
  const boardRestored = (id: string) => {
    if (!goneEdits.trashed.some((it) => it.id === id)) return;
    setGoneEdits((gone) => ({ ...gone, trashed: gone.trashed.filter((it) => it.id !== id) }));
    setRestoring((batch) => (batch?.includes(id) ? batch : [...(batch ?? []), id]));
  };
  /** Open `id`: the board open already but not loaded as it (not found, or in Recently deleted, until a
   *  Restore) loads again, since the same route wouldn't. */
  const openBoard = (id: string, scope: AssetScope) => {
    const ui = useUIStore.getState();
    if (ui.moodboardEditorId === id && ui.moodboardEditorScope === scope) {
      const state = useAssetStudioDraftStore.getState();
      const entry = state.entries[resolveAssetStudioDraftKey(state, key)];
      if (isCurrent() && entry?.savedId !== id) patch({ loaded: false, loadError: null, revision: (entry?.revision ?? revision) + 1 });
      return;
    }
    enterMoodboardEditor(id, scope);
  };
  useEffect(() => {
    let cancelled = false;
    void Promise.all(keptEditsWaiting().map((kept) => lookupStoredAsset('moodboard', kept.board).then((stored) => ({ kept, stored }), () => null)))
      .then((found) => {
        if (cancelled || !mounted.current) return;
        const trashed: GoneBoard[] = [];
        const purged: GoneBoard[] = [];
        for (const it of found) {
          if (!it) continue; // Nebula didn't answer: say nothing yet
          if (it.stored.status === 'trashed') {
            const item = it.stored.trashed;
            trashed.push({ id: it.kept.board, name: item.name || it.kept.name || '', scope: item.projectId ? 'project' : 'global' });
          } else if (it.stored.status === 'missing') {
            purged.push({ id: it.kept.board, name: it.kept.name ?? '', scope: 'global' });
          }
        }
        // A board gone for good is found once (its edit is dropped below), so a re-check adds nothing and the
        // red line stays as it was: said once.
        setGoneEdits((gone) => ({ trashed, purged: purged.length ? [...gone.purged, ...purged] : gone.purged }));
        for (const board of purged) dropKeptEdit(board.id);
      });
    return () => { cancelled = true; };
  }, [moodboardEditorId, deleting.refreshKey]);
  /** Restore: one board comes back and opens, its edit replayed by the load; for several, Recently deleted opens. */
  const restoreGone = async (keyboard: boolean) => {
    const trashed = goneEdits.trashed;
    setRestoreError(null);
    if (trashed.length !== 1) {
      if (!trashed[0]) return;
      // Recently deleted opens on the first board's scope, its Restore focused (the ring only from the keyboard).
      const scope = trashed[0].scope;
      setRestoring(trashed.map((it) => it.id));
      setTrashRequest((request) => ({ n: (request?.n ?? 0) + 1, scope, keyboard,
        focus: trashed.filter((it) => it.scope === scope).map((it) => it.id) }));
      return;
    }
    const [board] = trashed;
    try {
      await restoreTrashed('moodboard', board.id);
    } catch (err) {
      if (mounted.current) setRestoreError(failureCopy(err, { heading: "Couldn't restore the board." }));
      return;
    }
    if (!mounted.current) return;
    boardRestored(board.id);
    setRailScope(board.scope);
    openBoard(board.id, board.scope);
  };

  const deleteBoard = async () => {
    if (!savedId || !isCurrent()) return;
    const scope = moodboardEditorScope;
    const deletedKey = key;
    const route = routeNow();
    // Save edits made since the last autosave first, so Undo and Restore
    // bring back what the person last saw. If that save fails, don't delete.
    if (dirty && canSave) {
      await persist();
      if (!mounted.current || useAssetStudioDraftStore.getState().entries[deletedKey]?.dirty) return;
    }
    const removed = await deleting.remove({ id: savedId, name: draft.name.trim(), scope });
    if (!removed || !mounted.current) return;
    useBoardUndoStore.getState().clear(deletedKey);
    const store = useAssetStudioDraftStore.getState();
    // Forget the session draft, so reopening it after a restore loads what was saved.
    store.reset(deletedKey, emptyDraft());
    const ui = useUIStore.getState();
    if (ui.viewMode !== 'moodboard-editor') return;
    const openProjectId = currentProject()?.id ?? null;
    const newKey = assetStudioDraftKey('moodboard', scope, NEW_MOODBOARD_SENTINEL, openProjectId);
    // Another unsaved board with content is saved first, as New does (GM r8 answer 1).
    const kept = await keepUnsaved(newKey);
    if (kept.kept) {
      store.reset(newKey, scope === 'project' && openProjectId ? { ...emptyDraft(), projectId: openProjectId } : emptyDraft());
    }
    if (!stillOn(route, kept.savedId)) return;
    setRailScope(scope);
    enterMoodboardEditor(NEW_MOODBOARD_SENTINEL, scope);
  };
  // Move to Global / Move to <open project> (contract 07, 1.10).
  const openProject = useCurrentProject();
  const moving = useStudioAssetMove('moodboard');
  const moveBoard = (choice: MoveChoice) => {
    if (!savedId) return;
    const id = savedId;
    void moving.move({ id, key, target: choice.target, persist, canSave, isCurrent,
      isOpen: () => mounted.current && useUIStore.getState().viewMode === 'moodboard-editor'
        && useUIStore.getState().moodboardEditorId === id,
      open: (movedId, scope) => { setRailScope(scope); enterMoodboardEditor(movedId, scope); } });
  };
  const openRestored = (id: string, scope: AssetScope) => {
    if (!mounted.current || useUIStore.getState().viewMode !== 'moodboard-editor') return;
    setRailScope(scope);
    enterMoodboardEditor(id, scope);
  };

  // Where the open board lives, once it's a saved board: its own projectId
  // says, whatever scope it was opened with. The rail opens on that scope,
  // and says so when it's another project's board.
  const boardProjectName = useProjectName(draft.projectId);
  const boardHome: AssetHome | null = loaded && savedId ? assetHome(draft.projectId, projectId, boardProjectName) : null;
  const shownRailScope = boardHome?.scope ?? railScope;

  // What the board opens on, as the server's thumbnail reads it: the chosen
  // cover, else #1, from the draft so a pick shows before it is saved.
  const cover = boardCover(draft.images, draft.coverImageId);
  const previewThumbnail = cover ? draft.images[cover.number - 1].url : '';
  // Only Nebula's own files are loaded (lib/storedImage.ts): an old board's
  // link to another site gets the placeholder (Q98).
  const previewView = storedImageView(previewThumbnail);
  const analysis = draft.analysis;

  /** The toolbar's Retry runs exactly the action that failed (GM, error-copy
   * round 3: "A Retry that does something else is a defect."): a save, an
   * analyze, or the same undo or redo while its step is still the next one.
   * A line no button redoes (an upload, the brief) gets no Retry of its own,
   * so it keeps its full reason. But a failed save it replaced is still
   * owed (Error, dirty, and autosave waits while it says Error): the toolbar
   * keeps a Retry for it, and that Retry saves (round 3 review). */
  const canRetry = saveState === 'error' && (retry === 'save' || retry === 'analyze'
    || (retry === 'undo' && Boolean(retryStep) && nextUndoId === retryStep)
    || (retry === 'redo' && Boolean(retryStep) && nextRedoId === retryStep));
  const saveOwed = saveState === 'error' && dirty && retry == null;
  // A background send that failed on reconnect (GM r12 1): nothing is lost,
  // so its line and the chip are neutral, and the header's Retry is its one retry.
  const notSaved = saveState === 'error' && isBoardNotSavedLine(saveError);
  const retryFailed = () => {
    if (retry === 'analyze') void runAnalyze();
    else if (retry === 'undo' && retryStep) void runUndo('undo', retryStep);
    else if (retry === 'redo') void runUndo('redo');
    else void persist();
  };

  const header = (
    <WorkspaceHeader title="Moodboard" onBack={exitMoodboardEditor} className="moodboard-studio-toolbar">
      <ViewSwitch view={view} onChange={setView} />
      <div className={`moodboard-studio-toolbar__state moodboard-studio-toolbar__state--${notSaved ? 'not-saved' : saveState}`}>
        {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : notSaved ? 'Not saved' : saveState === 'error' ? 'Error' : 'Draft'}
      </div>
      {(canRetry || saveOwed) && (
        <button type="button" className="moodboard-studio-toolbar__button" onClick={retryFailed}>
          Retry
        </button>
      )}
      {savedId && !isDraftId && loaded && (
        <AssetMoveMenu noun="board" buttonClassName="moodboard-studio-toolbar__button"
          choices={moveChoices(draft.projectId, openProject)} onChoose={moveBoard} busy={moving.busy}
          disabled={deleting.busy || Boolean(pendingSaveId) || analyzing} />
      )}
      {savedId && !isDraftId && (
        <button type="button" className="moodboard-studio-toolbar__button moodboard-studio-toolbar__button--delete" title="Move to Recently deleted"
          disabled={deleting.busy || Boolean(pendingSaveId) || analyzing} onClick={() => void deleteBoard()}>
          Delete
        </button>
      )}
    </WorkspaceHeader>
  );

  const rail = (
    <aside className="moodboard-studio-view__rail">
      <MoodboardRail
        key={shownRailScope}
        activeId={savedId ?? (isDraftId ? NEW_MOODBOARD_SENTINEL : moodboardEditorId)}
        initialScope={shownRailScope}
        boardHome={boardHome}
        projectId={projectId}
        refreshKey={`${deleting.refreshKey}:${moving.moves}`}
        trashRequest={trashRequest}
        onRestored={boardRestored}
        onSelect={(id, scope) => {
          setRailScope(scope);
          openBoard(id, scope);
        }}
        onNew={async (scope) => {
          if (!isCurrent()) return;
          const project = scope === 'project' ? currentProject() : null;
          if (scope === 'project' && !project) {
            patch({ saveError: NO_PROJECT_OPEN });
            return;
          }
          const newKey = assetStudioDraftKey('moodboard', scope, NEW_MOODBOARD_SENTINEL, project?.id);
          // An unsaved board with content (an add on its way counts) is saved
          // first: New never drops a paste (GM r8 answer 1). If that save
          // fails, the board stays open with its line.
          const route = routeNow();
          const kept = await keepUnsaved(newKey);
          if (kept.kept) useAssetStudioDraftStore.getState().reset(newKey, emptyDraft());
          if (!stillOn(route, kept.savedId)) return;
          setRailScope(scope);
          enterMoodboardEditor(NEW_MOODBOARD_SENTINEL, scope);
        }}
      />
    </aside>
  );

  const loadingBlock = (
    <div className="moodboard-studio-view__loading">
      {/* Retry loading reloads the board, so it shows (with GM's short line)
          only for a load that failed; with no project open there's nothing
          to reload, and the line says what to do (round 3b). */}
      {shownLoadError ? <div role="alert"><FailureLines failure={shownLoadError} retry={projectReady} /></div> : 'Loading Moodboard...'}
      {shownLoadError && projectReady && <button type="button" className="moodboard-studio-toolbar__button"
        onClick={() => patch({ loadError: null, revision: revision + 1 })}>Retry loading</button>}
    </div>
  );

  const notices = (
    <>
      {shownLoadError && <div className="moodboard-studio__notice moodboard-studio__notice--warn"><FailureLines failure={shownLoadError} /></div>}
      {/* A delete's failure shows here even while the last delete's Undo toast is up (round 3b). */}
      {deleting.deleteError && (
        <div className="moodboard-studio__notice moodboard-studio__notice--error" role="alert"><FailureLines failure={deleting.deleteError} /></div>
      )}
      {/* Beside the toolbar's Retry (it redoes this failure) the reason is GM's short line (WRAP rule). */}
      {saveError && (notSaved
        ? <div className="moodboard-studio__notice moodboard-studio__notice--neutral" data-line-neutral="" role="status">
          <FailureLines failure={saveError} /></div>
        : <div className="moodboard-studio__notice moodboard-studio__notice--error">
          <FailureLines failure={saveError} retry={canRetry} /></div>)}
      {/* A Restore's confirmation (round 6k, GM r19 2): before any "Kept …" line its replay gives. */}
      {restoredLine && restoredLine.at === moodboardEditorId && (
        <div className="moodboard-studio__notice moodboard-studio__notice--neutral" data-line-neutral="" data-restored="" role="status"
          title={restoredLine.title}>{restoredLine.text}</div>
      )}
      {/* The Studio's own neutral line about this board (round 6g: what a repeat kept from the board). */}
      {notice && <div className="moodboard-studio__notice moodboard-studio__notice--neutral" data-line-neutral="" role="status"
        title={typeof notice === 'string' ? undefined : notice.title}>{typeof notice === 'string' ? notice : notice.text}</div>}
      {moving.error && (
        <div className="moodboard-studio__notice moodboard-studio__notice--error" role="alert"><FailureLines failure={moving.error} /></div>
      )}
      {/* Kept edits whose boards were deleted (round 6j): the Restore line first, then the gone-for-good one. */}
      {goneEdits.trashed.length > 0 && (() => {
        const line = deletedBoardsLine(goneEdits.trashed.map((board) => board.name), 'trashed');
        return (
          <div className="moodboard-studio__notice moodboard-studio__notice--neutral moodboard-studio__notice--action" data-line-neutral=""
            data-gone="trashed" role="status" title={line.title}>
            <span>{line.text}</span>
            <button type="button" className="moodboard-studio-toolbar__button moodboard-studio__notice-action"
              onClick={(event) => { void restoreGone(event.detail === 0); }}>Restore</button>
          </div>
        );
      })()}
      {restoreError && (
        <div className="moodboard-studio__notice moodboard-studio__notice--error" role="alert"><FailureLines failure={restoreError} /></div>
      )}
      {goneEdits.purged.length > 0 && (() => {
        const line = deletedBoardsLine(goneEdits.purged.map((board) => board.name), 'purged');
        // Said once, in the status region; its edit is already gone, so only the × (GM r19 1).
        return (
          <div className="moodboard-studio__notice moodboard-studio__notice--error moodboard-studio__notice--action" data-gone="purged"
            role="status" title={line.title}>
            <span>{line.text}</span>
            <button type="button" className="moodboard-studio__notice-close" aria-label="Dismiss"
              onClick={() => setGoneEdits((gone) => ({ ...gone, purged: [] }))}><X aria-hidden="true" /></button>
          </div>
        );
      })()}
    </>
  );

  const boardFields = (
    <div className="moodboard-def__fields">
      <label className="moodboard-field">
        <span>Name</span>
        <input
          value={draft.name}
          onChange={(event) => { const name = event.target.value; beginField('name'); setDraft((current) => ({ ...current, name })); }}
          onBlur={() => endField('name')}
        />
      </label>
      <div className="moodboard-def__row">
        <label className="moodboard-field">
          <span>Mode</span>
          <select
            value={draft.mode}
            onChange={(event) => {
              const mode = event.target.value as Moodboard['mode'];
              changeField('mode', () => setDraft((current) => ({ ...current, analysis: null, mode })));
            }}
          >
            <option value="look">Look</option>
            <option value="world">World</option>
            <option value="subject">Subject</option>
          </select>
        </label>
        <label className="moodboard-field moodboard-field--grow">
          {/* Q21 b: Krea 2's board references share out this strength.
              Q36 a: at 0 no node gets the board, text included. */}
          <span>Strength {draft.strength.toFixed(2)} · {draft.strength <= 0
            ? 'board off: connected nodes get none of it'
            : <>the total the board&apos;s images share on Krea 2</>}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={draft.strength}
            onChange={(event) => {
              const strength = Number(event.target.value);
              beginField('strength');
              setDraft((current) => ({ ...current, analysis: null, strength }));
            }}
            // One step per drag, closed when let go; arrow keys make one step
            // until the slider loses focus (or Cmd+Z closes it).
            onPointerUp={() => endField('strength', 'soon')}
            onBlur={() => endField('strength', 'soon')}
          />
        </label>
      </div>
      <label className="moodboard-field">
        <span>Notes</span>
        <AutoGrowTextarea
          rows={3}
          value={draft.notes}
          onChange={(event) => { const notes = event.target.value; beginField('notes'); setDraft((current) => ({ ...current, analysis: null, notes })); }}
          onBlur={() => endField('notes')}
          placeholder="Anything about the board, in your words."
        />
      </label>
      <NotesSwitch on={draft.sendNotes === true}
        onChange={(sendNotes) => changeField('sendNotes', () => setBriefFields({ sendNotes }))} />
      {/* An agent asking to turn it on: only the person may. */}
      {savedId && <AssetProposalStrip kind="moodboard" targetId={savedId} />}
    </div>
  );

  const briefFields = (
    <BriefFields
      direction={draft.direction}
      avoid={draft.avoid}
      pinnedColors={draft.pinnedColors}
      clashMode={draft.clashMode ?? 'leave-out'}
      onChange={(fields) => {
        // Direction is typed: its step closes when it loses focus. The rest
        // are picks (an Avoid item, a pinned colour, the clash mode).
        if ('direction' in fields) {
          beginField('direction');
          setBriefFields(fields);
          return;
        }
        const field: FieldStep = 'avoid' in fields ? 'avoid' : 'pinnedColors' in fields ? 'pinnedColors' : 'clashMode';
        changeField(field, () => setBriefFields(fields));
      }}
      onTextDone={() => endField('direction')}
    />
  );

  const analysisSection = (
    <section className="moodboard-analysis">
      <div className="moodboard-analysis__head">
        <div>
          <span className="moodboard-analysis__label">Extraction</span>
          <span className="moodboard-analysis__hint">
            Produces the editable creative-direction object used by nodes.
          </span>
        </div>
        <button type="button" onClick={() => void runAnalyze()} disabled={!canSave || analyzing || Boolean(pendingSaveId)}>
          {analyzing ? 'Analyzing' : 'Analyze'}
        </button>
      </div>

      <BriefPanel
        brief={brief}
        override={draft.briefOverride}
        author={overrideAuthor(savedOverride, draft.briefOverride)}
        saving={dirty || Boolean(pendingSaveId)}
        busy={analyzing}
        onEdit={(text) => { beginField('briefOverride'); setBriefFields({ briefOverride: { text } }); }}
        onEditDone={() => endField('briefOverride')}
        onKeep={() => void keepOverride()}
        onRegenerate={regenerateBrief}
        onColorChoice={(choice, hex) => chooseColors(choice, [hex])}
        onLeaveOutAll={(hexes) => chooseColors('leaveOut', hexes)}
      />

      {analysis ? (
        <div className="moodboard-analysis__body">
          <BoardSwatches label="Palette" role="dominant" analysis={analysis} leftOut={brief?.leftOut} />
          <BoardSwatches label="Accents" role="accent" analysis={analysis} leftOut={brief?.leftOut} />
          <SourcesOutdated analysis={analysis} />
          <div className="moodboard-analysis__summary">{analysis.summary}</div>
          <AnalysisOutdated analysis={analysis} />
        </div>
      ) : (
        <div className="moodboard-analysis__empty">
          Analyze after adding images to extract palette, representative references, a style brief, and provider hints.
        </div>
      )}
    </section>
  );

  const shownToast = toast && toast.key === key ? toast : null;
  // Both toasts leave as they entered (fix round 7 of PR #200, GM r11 answer 2).
  const trashToast = (
    <NoticeLeave value={deleting.lastDeleted}>{(last, leave) => (
      <UndoDeleteToast key={last.id} name={last.name} busy={deleting.busy}
        error={deleting.undoError} onDismiss={deleting.dismiss}
        onUndo={() => { void deleting.undo().then((asset) => { if (asset) openRestored(asset.id, asset.scope); }); }} leave={leave} />
    )}</NoticeLeave>
  );

  if (view === 'board') {
    return (
      <div className="moodboard-studio-view moodboard-studio-view--board">
        {header}
        {rail}
        <main className="moodboard-studio-view__board">
          {loading ? loadingBlock : (
            <>
              <div className="moodboard-studio-view__board-notices">{notices}</div>
              <BoardCanvas key={key} boardKey={key} images={draft.images} onMove={moveCards} onDropFiles={dropFiles}
                pasteTarget={pasteTarget} placeholders={placeholders} onPlaceholdersFilled={dropFilled}
                outside={outsideTiles} onOutsideDone={dismissOutside} offline={offline} />
              <NoticeLeave value={shownToast}>{(last, leave) => <BoardUndoToast key={last.id} toast={last} onDismiss={dismissToast} leave={leave} />}</NoticeLeave>
            </>
          )}
        </main>
        {!loading && (
          <BoardSidePanel images={draft.images} selected={selectedIds} analysis={analysis} onUpdate={updateImage}
            onRemove={removeImages} onTextDone={imageTextDone}>
            <div className="moodboard-board-panel__section">{boardFields}</div>
            {briefFields}
            {analysisSection}
            <div ref={holdSpacer} className="moodboard-hold-spacer" aria-hidden="true" />
          </BoardSidePanel>
        )}
        {trashToast}
        {spokenLine}
      </div>
    );
  }

  return (
    <div className="moodboard-studio-view">
      {header}
      {rail}
      <main className="moodboard-studio-view__main">
        {loading ? loadingBlock : (
          <>
            {notices}
            <section className="moodboard-def">
              <div className="moodboard-def__cover-col">
                <div className="moodboard-def__cover">
                  {previewView.src ? (
                    // Keyed by the image, so a new cover enters on the spring.
                    <img key={previewThumbnail} src={previewView.src} alt="" draggable={false} />
                  ) : previewView.outside ? <OutsideImageNote /> : (
                    <span>No images</span>
                  )}
                </div>
                {cover && (
                  <p className="moodboard-def__cover-caption" aria-live="polite">
                    {cover.chosen ? `Cover: #${cover.number}` : 'Cover: #1, the first image'}
                  </p>
                )}
              </div>
              {boardFields}
            </section>

            <MoodboardListView images={draft.images} analysis={analysis} cover={cover} uploads={listUploads}
              onFiles={handleFiles} onDrop={handleDrop} onRemove={removeImage} onUpdate={updateImage}
              onSetCover={setCover} onTextDone={imageTextDone} offline={offline} />

            {briefFields}
            {analysisSection}
            <div ref={holdSpacer} className="moodboard-hold-spacer" aria-hidden="true" />
          </>
        )}
      </main>
      <NoticeLeave value={shownToast}>{(last, leave) => <BoardUndoToast key={last.id} toast={last} onDismiss={dismissToast} leave={leave} />}</NoticeLeave>
      {trashToast}
      {spokenLine}
    </div>
  );
}

/** Board or List (moodboard canvas PR5). Board is a preview for now; List stays the default. */
function ViewSwitch({ view, onChange }: { view: MoodboardView; onChange: (view: MoodboardView) => void }) {
  const options: Array<{ id: MoodboardView; label: string }> = [{ id: 'board', label: 'Board' }, { id: 'list', label: 'List' }];
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const index = options.findIndex((option) => option.id === view);
  return (
    <div className="moodboard-view-switch" role="radiogroup" aria-label="View"
      style={{ ['--mb-view-index' as string]: index }}>
      <span className="moodboard-view-switch__thumb" aria-hidden="true" />
      {options.map((option) => (
        <button key={option.id} ref={(node) => { refs.current[option.id] = node; }} type="button" role="radio"
          aria-checked={view === option.id} tabIndex={view === option.id ? 0 : -1}
          className="moodboard-view-switch__option"
          title={option.id === 'board' ? 'The board as a canvas (preview)' : 'The board as a list'}
          onClick={() => onChange(option.id)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const next = options[(options.findIndex((candidate) => candidate.id === option.id) + 1) % options.length];
            onChange(next.id);
            refs.current[next.id]?.focus();
          }}>
          {option.label}
          {option.id === 'board' && <span className="moodboard-view-switch__badge" aria-hidden="true">Preview</span>}
        </button>
      ))}
    </div>
  );
}

function MoodboardRail({
  activeId,
  initialScope,
  boardHome,
  projectId,
  refreshKey,
  trashRequest,
  onRestored,
  onSelect,
  onNew,
}: {
  activeId: string | null;
  initialScope: AssetScope;
  /** Where the open saved board lives; null for a new draft. */
  boardHome: AssetHome | null;
  /** The canvas project open now (null: none), whose boards the Project tab lists. */
  projectId: string | null;
  refreshKey?: unknown;
  /** A Studio line's Restore for several deleted boards: show this scope's Recently deleted, open (round 6j). */
  trashRequest?: (TrashOpenRequest & { scope: AssetScope }) | null;
  /** A board came back from this rail's Recently deleted (before it opens). */
  onRestored?: (id: string) => void;
  onSelect: (id: string, scope: AssetScope) => void;
  onNew: (scope: AssetScope) => void;
}) {
  const [scope, setScope] = useState<AssetScope>(initialScope);
  // A new request (not one made before this rail mounted) switches to its scope.
  const [seenRequest, setSeenRequest] = useState(trashRequest?.n ?? 0);
  if (trashRequest && trashRequest.n !== seenRequest) {
    setSeenRequest(trashRequest.n);
    setScope(trashRequest.scope);
  }
  // Bumped when Recently deleted changes (a delete or restore elsewhere), to list again.
  const [relistKey, setRelistKey] = useState(0);
  const relist = useCallback(() => setRelistKey((value) => value + 1), []);
  // The list with the tab and project it was fetched for, so a list from
  // before a project switch is never shown as this project's.
  const [listing, setListing] = useState<{ for: string; items: Moodboard[] }>({ for: '', items: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A board saved or deleted elsewhere (an agent, the CLI) shows up here too.
  useEffect(() => wsClient.subscribe((event) => {
    if ((event.type === 'storedAssetChanged' && event.kind === 'moodboard') || event.type === 'socketReconnected') relist();
  }), [relist]);

  const noProject = scope === 'project' && !projectId;
  const listKey = `${scope}:${scope === 'project' ? projectId : ''}`;
  useEffect(() => {
    // No project open: nothing to fetch; the empty state says to open one.
    if (noProject) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading gate before async fetch; not derived state, does not cascade
    setLoading(true);
    setError(null);
    fetchMoodboards(scope, scope === 'project' ? projectId ?? undefined : undefined)
      .then((list) => {
        if (!cancelled) setListing({ for: listKey, items: list });
      })
      .catch((err) => {
        if (!cancelled) {
          setError(failureMessage(err, "Couldn't load the boards."));
          setListing({ for: listKey, items: [] });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, projectId, noProject, listKey, activeId, refreshKey, relistKey]);
  const notice = railNotice('moodboard', boardHome);
  const shown = noProject || listing.for !== listKey ? [] : listing.items;
  const busy = !noProject && loading;
  const failed = noProject ? null : error;

  return (
    <div className="moodboard-rail">
      <div className="moodboard-rail__scope" role="tablist" aria-label="Moodboard scope">
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'project'}
          className={scope === 'project' ? 'moodboard-rail__scope-tab moodboard-rail__scope-tab--active' : 'moodboard-rail__scope-tab'}
          onClick={() => setScope('project')}
        >
          Project
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'global'}
          className={scope === 'global' ? 'moodboard-rail__scope-tab moodboard-rail__scope-tab--active' : 'moodboard-rail__scope-tab'}
          onClick={() => setScope('global')}
        >
          Global
        </button>
      </div>
      <button type="button" className="moodboard-rail__new" disabled={noProject}
        title={noProject ? NO_PROJECT_OPEN : undefined} onClick={() => onNew(scope)}>+ New Moodboard</button>
      <div className="moodboard-rail__list">
        {notice && <div className="moodboard-rail__empty moodboard-rail__empty--notice" role="status">{notice}</div>}
        {busy && <div className="moodboard-rail__empty">Loading...</div>}
        {failed && !busy && <div className="moodboard-rail__empty moodboard-rail__empty--error">{failed}</div>}
        {!busy && !failed && shown.length === 0 && (
          <div className="moodboard-rail__empty">{emptyRailMessage('moodboard', scope, boardHome, !noProject)}</div>
        )}
        {shown.map((m) => {
          const thumb = storedImageView(m.thumbnail);
          return (
          <button
            key={m.id}
            type="button"
            className={m.id === activeId ? 'moodboard-rail__item moodboard-rail__item--active' : 'moodboard-rail__item'}
            onClick={() => onSelect(m.id, scope)}
          >
            <span className="moodboard-rail__thumb">
              {thumb.src ? <img src={thumb.src} alt="" draggable={false} /> : <span>MB</span>}
            </span>
            <span className="moodboard-rail__meta">
              <span className="moodboard-rail__name">{m.name || 'Untitled'}</span>
              <span className="moodboard-rail__sub">
                {moodboardImagesLabel(m.images.length, setAsideCount(m.images))} · {m.mode}
              </span>
              {thumb.outside && <OutsideImageNote />}
            </span>
          </button>
          );
        })}
      </div>
      <RecentlyDeletedAssets kind="moodboard" scope={scope} refreshKey={`${String(refreshKey)}:${activeId}`}
        onRestored={(item) => { onRestored?.(item.id); onSelect(item.id, scope); }} onTrashChanged={relist} openRequest={trashRequest ?? undefined} />
    </div>
  );
}

/** Whether the board's notes go to generators (gap 18). Off by default:
 *  notes are the person's words about the board, for them, their team and
 *  agents. Only the person can turn it on (the backend refuses an agent). */
function NotesSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const hintId = useId();
  return (
    <div className="moodboard-switch">
      <button type="button" role="switch" aria-checked={on} aria-describedby={hintId}
        className="moodboard-switch__control" onClick={() => onChange(!on)}>
        <span className="moodboard-switch__track" aria-hidden="true"><span className="moodboard-switch__thumb" /></span>
        <span className="moodboard-switch__label">Send these notes to generators</span>
      </button>
      <span id={hintId} className="moodboard-switch__hint">
        {on ? 'On: generators get these notes with the brief.' : 'Off: notes are for you, your team and agents.'}
      </span>
    </div>
  );
}
