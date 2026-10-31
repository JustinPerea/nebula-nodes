import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useUIStore } from '../../store/uiStore';
import {
  analyzeMoodboard,
  createMoodboard,
  editMoodboard,
  fetchMoodboard,
  fetchMoodboards,
  keepMoodboardBriefOverride,
  lookupStoredAsset,
  SAVE_BOARD,
  updateMoodboard,
} from '../../lib/api';
import { RecentlyDeletedAssets, UndoDeleteToast } from '../asset-trash/AssetTrash';
import { useAssetDelete } from '../../hooks/useAssetDelete';
import { apiRequest } from '../../lib/apiRequest';
import { failureCopy, failureMessage } from '../../lib/errorCopy';
import { FailureLines } from '../failure/FailureLines';
import { storedImageView } from '../../lib/storedImage';
import { OutsideImageNote } from '../OutsideImageNote';
import { WorkspaceHeader } from '../WorkspaceHeader';
import { useAssetStudioDraft } from '../../hooks/useAssetStudioDraft';
import { useOfflineHiddenNotice } from '../../hooks/useOfflineHiddenNotice';
import { assetStudioDraftKey, resolveAssetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { NEW_MOODBOARD_SENTINEL } from '../../lib/studioSentinels';
import { NO_PROJECT_OPEN, currentProject, useCurrentProject } from '../../lib/currentProject';
import { useProjectName } from '../../hooks/useProjectName';
import type { AssetScope } from '../../store/uiStore';
import type { Moodboard, MoodboardAnalysis, MoodboardBrief, MoodboardClashMode, MoodboardImage, MoodboardPinnedColors } from '../../types';
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
import { dropLayout, provisionalForCreate, readImageAspect } from '../../lib/boardDrop';
import { sizeFor } from '../../lib/moodboardLayout';
import { useBoardCanvasStore, useBoardSelection, type MoodboardView } from '../../store/boardCanvasStore';
import { BoardCanvas, type BoardMove } from './BoardCanvas';
import { BoardSidePanel } from './BoardSidePanel';
import { BoardUndoToast, type BoardToast } from './BoardUndoToast';
import { MoodboardListView } from './MoodboardListView';
import { selectedImageIds } from './boardNodes';
import { isStudioShortcutTarget, studioKey } from './studioKeys';
import { boardCover } from '../../lib/moodboardCover';
import { FieldStepTracker, fieldGroups, fieldStepKeys, type FieldStep } from './fieldSteps';
import '../../styles/moodboard-studio.css';
import '../../styles/moodboard-board.css';
import { NoticeLeave } from '../../lib/noticeLeave';

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
  const since = asSent && draft.base ? { ...draft, base: { ...draft.base, ...asSent } } : draft;
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

/** A draft's board fields with the name as it is sent (trimmed). */
function trimmedName<D extends Partial<Record<BoardFieldKey, unknown>>>(fields: D): D {
  return typeof fields.name === 'string' ? { ...fields, name: fields.name.trim() } : fields;
}

/** A new board's first save: everything but the checked-edit bookkeeping. */
function createBody(draft: MoodboardDraft) {
  const body: MoodboardDraft = { ...withBriefFields(draft), name: draft.name.trim(), images: provisionalForCreate(draft.images) };
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
  const { draft: storedDraft, savedId, saveState, saveError, retry, retryStep, loadError, loaded,
    dirty, pendingSaveId, pendingAnalysisId, key, revision, epoch, projectId, projectReady, verifyProject, setDraft, initialize, patch } = studio;
  // The steps undo and redo would take next: a failed undo's Retry runs only
  // while its step is still that one (round 3; else it is hidden).
  const nextUndoId = useBoardUndoStore((state) => state.history(key, epoch).done.at(-1)?.id ?? null);
  const nextRedoId = useBoardUndoStore((state) => state.history(key, epoch).undone.at(-1)?.id ?? null);
  const draft = withBriefFields(storedDraft);
  const loading = !loaded;
  const [uploading, setUploading] = useState(false);
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
  const selection = useBoardSelection(key);
  const selectedIds = view === 'board' ? selectedImageIds(draft.images, selection) : [];
  const [toast, setToast] = useState<(BoardToast & { key: string }) | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((next: Omit<BoardToast, 'id'>) => {
    toastSeq.current += 1;
    setToast({ ...next, id: toastSeq.current, key });
  }, [key]);
  const dismissToast = useCallback(() => setToast(null), []);
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

  useEffect(() => {
    setUploading(false);
  }, [key, epoch]);

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
    patch({ loadError: null, saveError: null });
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
            initialize(fresh, null, '', stored?.status === 'trashed'
              ? 'This board is in Recently deleted. Restore it from the list on the left.'
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
        initialize(moodboardToDraft(found), found.id, found.thumbnail);
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
      if (!savedId) {
        const sent = new Set(currentDraft.pendingOps ?? []);
        result = await createMoodboard(createBody(currentDraft));
        const drafted = currentDraft as Partial<Record<BoardFieldKey, unknown>>;
        moveDraft(result, sent, Object.fromEntries(BOARD_FIELD_KEYS.filter((field) => field !== 'analysis' && field in drafted)
          .map((field) => [field, drafted[field]])));
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
          }
        }
      }
      const thumbnail = result?.thumbnail ?? attempt.entry.thumbnail;
      const id = result?.id ?? savedId!;
      forgetUnsentSteps();
      if (!store.finishSave(key, attempt.id, attempt.revision, id, thumbnail)) return null;
      if (!savedId && result) {
        const createdScope: AssetScope = result.projectId ? 'project' : 'global';
        const selectedAtCompletion = isCurrent();
        store.copyTo(key, assetStudioDraftKey('moodboard', createdScope, result.id, result.projectId));
        if (selectedAtCompletion) {
          setRailScope(createdScope);
          enterMoodboardEditor(result.id, createdScope);
        }
      }
      if (announced.current > (draftNow()?.version ?? 0)) void follow();
      return id;
    } catch (err) {
      store.failSave(key, attempt.id, failureCopy(err, { heading: SAVE_BOARD }));
      return null;
    }
  }, [key, epoch, isCurrent, verifyProject, enterMoodboardEditor, moveDraft, draftNow, follow, forgetUnsentSteps, fieldSteps]);

  /** Text sends 600 ms after the last key, or when it loses focus. */
  const sendNow = () => {
    const entry = useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key)];
    if (entry?.dirty && !entry.pendingSaveId && canSave) void persist();
  };

  useEffect(() => {
    if (!loaded || !dirty || !canSave || pendingSaveId || saveState === 'error') return;
    const timer = window.setTimeout(() => { void persist(); }, urgent.current ? 0 : 600);
    return () => window.clearTimeout(timer);
  }, [loaded, dirty, canSave, pendingSaveId, saveState, draft, savedId, persist]);

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

  const addImageUrls = (urls: string[]) => {
    if (urls.length === 0 || !isCurrent()) return;
    const add: MoodboardOp = { op: 'add', images: urls.map(createDraftImage).map(({ id, url }) => ({ id, url })) };
    const count = (draftNow()?.images ?? draft.images).length;
    commitOps([add], urls.length === 1 ? `Added #${count + 1}` : `Added ${urls.length} references`);
  };

  const uploadFiles = (files: File[]) => Promise.all(files.map((file) => {
    const fd = new FormData();
    fd.append('file', file);
    return apiRequest(`Couldn't upload ${file.name || 'the image'}.`, '/api/uploads', { method: 'POST', body: fd })
      .then((r) => r.json())
      .then((data: { url: string }) => data.url);
  }));

  const handleFiles = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    uploadFiles(Array.from(files))
      .then((urls) => addImageUrls(urls.filter(Boolean)))
      .catch((err: unknown) => { if (isCurrent()) patch({ saveError: failureCopy(err, { heading: "Couldn't upload the image." }) }); })
      .finally(() => { if (isCurrent()) setUploading(false); });
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'));
    handleFiles(files);
  };

  /** Files dropped on the Board view: each lands where it was dropped (the
   *  first centred at the pointer, the rest in a row beside it), sized from
   *  its aspect, as one step sent at once. */
  const dropFiles = (files: File[], at: { x: number; y: number }) => {
    if (files.length === 0 || !isCurrent()) return;
    setUploading(true);
    Promise.all([uploadFiles(files), Promise.all(files.map((file) => readImageAspect(file)))])
      .then(([urls, aspects]) => {
        if (!isCurrent()) return;
        const placed = urls.map((url, index) => ({ url, aspect: aspects[index] })).filter((item) => item.url);
        if (placed.length === 0) return;
        const spots = dropLayout(at, placed.map((item) => sizeFor(1, item.aspect)));
        const ops: MoodboardOp[] = placed.map((item, index) => ({
          op: 'add', images: [{ id: createDraftImage(item.url).id, url: item.url }], at: spots[index] }));
        const count = (draftNow()?.images ?? []).length;
        commitOps(ops, placed.length === 1 ? `Added #${count + 1}` : `Added ${placed.length} references`, {
          now: true, aspects: Object.fromEntries(placed.map((item) => [item.url, item.aspect])) });
      })
      .catch((err: unknown) => { if (isCurrent()) patch({ saveError: failureCopy(err, { heading: "Couldn't upload the image." }) }); })
      .finally(() => { if (isCurrent()) setUploading(false); });
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
    if (stepId) showToast({ text: label, action: { label: 'Undo', run: () => { void runUndo('undo', stepId); } } });
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
        showToast({ text: `Undid: ${top.label}` });
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
      showToast({ text: `${direction === 'undo' ? 'Undid' : 'Redid'}: ${step.label}`, skipped: skippedLines(edited),
        action: direction === 'undo' && next.length ? { label: 'Redo', run: () => { void runUndo('redo'); } } : undefined });
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

  const deleting = useAssetDelete('moodboard');
  const deleteBoard = async () => {
    if (!savedId || !isCurrent()) return;
    const scope = moodboardEditorScope;
    const deletedKey = key;
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
    store.reset(assetStudioDraftKey('moodboard', scope, NEW_MOODBOARD_SENTINEL, openProjectId),
      scope === 'project' && openProjectId ? { ...emptyDraft(), projectId: openProjectId } : emptyDraft());
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
  const retryFailed = () => {
    if (retry === 'analyze') void runAnalyze();
    else if (retry === 'undo' && retryStep) void runUndo('undo', retryStep);
    else if (retry === 'redo') void runUndo('redo');
    else void persist();
  };

  const header = (
    <WorkspaceHeader title="Moodboard" onBack={exitMoodboardEditor} className="moodboard-studio-toolbar">
      <ViewSwitch view={view} onChange={setView} />
      <div className={`moodboard-studio-toolbar__state moodboard-studio-toolbar__state--${saveState}`}>
        {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Error' : 'Draft'}
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
        onSelect={(id, scope) => {
          setRailScope(scope);
          enterMoodboardEditor(id, scope);
        }}
        onNew={(scope) => {
          if (!isCurrent()) return;
          const project = scope === 'project' ? currentProject() : null;
          if (scope === 'project' && !project) {
            patch({ saveError: NO_PROJECT_OPEN });
            return;
          }
          useAssetStudioDraftStore.getState().reset(
            assetStudioDraftKey('moodboard', scope, NEW_MOODBOARD_SENTINEL, project?.id), emptyDraft());
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
      {saveError && <div className="moodboard-studio__notice moodboard-studio__notice--error">
        <FailureLines failure={saveError} retry={canRetry} /></div>}
      {moving.error && (
        <div className="moodboard-studio__notice moodboard-studio__notice--error" role="alert"><FailureLines failure={moving.error} /></div>
      )}
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
                uploading={uploading} />
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
          </BoardSidePanel>
        )}
        {trashToast}
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

            <MoodboardListView images={draft.images} analysis={analysis} cover={cover} uploading={uploading}
              onFiles={handleFiles} onDrop={handleDrop} onRemove={removeImage} onUpdate={updateImage}
              onSetCover={setCover} onTextDone={imageTextDone} />

            {briefFields}
            {analysisSection}
          </>
        )}
      </main>
      <NoticeLeave value={shownToast}>{(last, leave) => <BoardUndoToast key={last.id} toast={last} onDismiss={dismissToast} leave={leave} />}</NoticeLeave>
      {trashToast}
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
  onSelect: (id: string, scope: AssetScope) => void;
  onNew: (scope: AssetScope) => void;
}) {
  const [scope, setScope] = useState<AssetScope>(initialScope);
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
        onRestored={(item) => onSelect(item.id, scope)} onTrashChanged={relist} />
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
