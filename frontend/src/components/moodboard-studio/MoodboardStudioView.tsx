import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
  updateMoodboard,
} from '../../lib/api';
import { RecentlyDeletedAssets, UndoDeleteToast } from '../asset-trash/AssetTrash';
import { useAssetDelete } from '../../hooks/useAssetDelete';
import { apiFetch, backendAssetUrlSync } from '../../lib/backend';
import { WorkspaceHeader } from '../WorkspaceHeader';
import { useAssetStudioDraft } from '../../hooks/useAssetStudioDraft';
import { assetStudioDraftKey, resolveAssetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { NEW_MOODBOARD_SENTINEL } from '../../lib/studioSentinels';
import { NO_PROJECT_OPEN, currentProject, useCurrentProject } from '../../lib/currentProject';
import { useProjectName } from '../../hooks/useProjectName';
import type { AssetScope } from '../../store/uiStore';
import type { Moodboard, MoodboardAnalysis, MoodboardBrief, MoodboardClashMode, MoodboardImage, MoodboardPinnedColors } from '../../types';
import { BriefFields, BriefPanel, type ColorChoice } from './MoodboardBrief';
import { BoardSwatches, ImageColors, SourcesOutdated } from './MoodboardColors';
import { overrideAuthor } from './briefAuthor';
import { AutoGrowTextarea } from '../AutoGrowTextarea';
import { assetHome, emptyRailMessage, railNotice, type AssetHome } from '../../lib/assetHome';
import { wsClient } from '../../lib/wsClient';
import { moveChoices, type MoveChoice } from '../../lib/assetMove';
import { useStudioAssetMove } from '../../hooks/useStudioAssetMove';
import { AssetMoveMenu } from '../asset-move/AssetMoveMenu';
import { isSetAside, patchSteers, setAsidePatch } from './steering';
import { moodboardImagesLabel, setAsideCount } from '../../lib/moodboardCount';
import { BOARD_FIELD_KEYS, MoodboardVersionConflict, applyOps, imagePatchOps, queueOps, rebaseDraft,
  fieldChanges, type BoardFieldKey, type MoodboardOp } from '../../lib/moodboardEdits';
import { TAB_ID } from '../../lib/tabId';
import '../../styles/moodboard-studio.css';

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
  return rebaseDraft(draft, board, { ...boardFieldsOf(board), ...asSent }, sent);
}

/** A draft's board fields with the name as it is sent (trimmed). */
function trimmedName<D extends Partial<Record<BoardFieldKey, unknown>>>(fields: D): D {
  return typeof fields.name === 'string' ? { ...fields, name: fields.name.trim() } : fields;
}

/** A new board's first save: everything but the checked-edit bookkeeping. */
function createBody(draft: MoodboardDraft) {
  const body: MoodboardDraft = { ...withBriefFields(draft), name: draft.name.trim() };
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

// The backend's cap on a private note (services/moodboard_store.py).
const PRIVATE_NOTE_LIMIT = 2000;

export function MoodboardStudioView() {
  const moodboardEditorId = useUIStore((s) => s.moodboardEditorId);
  const moodboardEditorScope = useUIStore((s) => s.moodboardEditorScope);
  const enterMoodboardEditor = useUIStore((s) => s.enterMoodboardEditor);
  const exitMoodboardEditor = useUIStore((s) => s.exitMoodboardEditor);

  const studio = useAssetStudioDraft('moodboard', moodboardEditorScope, moodboardEditorId, emptyDraft);
  const { draft: storedDraft, savedId, thumbnail, saveState, saveError, loadError, loaded,
    dirty, pendingSaveId, pendingAnalysisId, key, revision, epoch, projectId, projectReady, verifyProject, setDraft, initialize, patch } = studio;
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

  useEffect(() => {
    setUploading(false);
  }, [key, epoch]);

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
        if (current()) patch({ loadError: err instanceof Error ? err.message : 'Failed to load Moodboard.' });
      });
    }
    return () => { cancelled = true; };
  }, [key, revision, loaded, projectReady, projectId, moodboardEditorId, moodboardEditorScope, initialize, patch, isDraftId, isCurrent,
    enterMoodboardEditor, rememberBrief]);

  // A draft kept from an earlier visit loads without a fetch; read its brief.
  const needsBrief = loaded && Boolean(savedId) && !brief;
  useEffect(() => {
    if (!needsBrief || !savedId) return;
    let cancelled = false;
    void fetchMoodboard(savedId).then((board) => { if (!cancelled && board) rememberBrief(board); }).catch(() => {});
    return () => { cancelled = true; };
  }, [needsBrief, savedId, rememberBrief]);

  useEffect(() => {
    if (isDraftId && loaded && savedId && isCurrent()) enterMoodboardEditor(savedId, moodboardEditorScope);
  }, [isDraftId, loaded, savedId, isCurrent, moodboardEditorScope, enterMoodboardEditor]);

  // The newest version someone else announced for the open board, so a save
  // in flight when it came reads the board again once it lands.
  const announced = useRef(0);
  const draftNow = useCallback(() => useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(
    useAssetStudioDraftStore.getState(), key)]?.draft as MoodboardDraft | undefined, [key]);
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
    if (board.version <= ((latest.draft as MoodboardDraft).version ?? 0)) return;
    moveDraft(board);
  }, [key, moveDraft]);

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

  const persist = useCallback(async () => {
    if (!isCurrent() || !await verifyProject() || !isCurrent()) return null;
    const store = useAssetStudioDraftStore.getState();
    const current = store.entries[key];
    const currentDraft = current?.draft as MoodboardDraft | undefined;
    if (!currentDraft || !currentDraft.name.trim() || !currentDraft.images.length) return null;
    const attempt = store.beginSave(key);
    if (!attempt) return null;
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
            if (ops.length) {
              const edited = await editMoodboard(savedId, ops, version);
              moveDraft(edited.board, new Set(ops));
              result = edited.board;
              version = edited.board.version;
            }
            const after = draftNow() ?? snapshot;
            const drafted = snapshot as Partial<Record<BoardFieldKey, unknown>>;
            const fields = after.base ? fieldChanges(trimmedName(after.base), trimmedName(drafted)) : createBody(snapshot);
            delete (fields as { images?: unknown }).images;
            if (Object.keys(fields).length) {
              result = await updateMoodboard(savedId, { ...(fields as Parameters<typeof updateMoodboard>[1]),
                ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
                ...(version === undefined ? {} : { baseVersion: version }) });
              const asSent = Object.fromEntries(Object.keys(fields).filter((field) => field !== 'analysis')
                .map((field) => [field, drafted[field as BoardFieldKey]]));
              moveDraft(result, undefined, asSent);
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
      store.failSave(key, attempt.id, err instanceof Error ? err.message : 'Save failed. Retry?');
      return null;
    }
  }, [key, isCurrent, verifyProject, enterMoodboardEditor, moveDraft, draftNow, follow]);

  /** Text sends 600 ms after the last key, or when it loses focus. */
  const sendNow = () => {
    const entry = useAssetStudioDraftStore.getState().entries[resolveAssetStudioDraftKey(useAssetStudioDraftStore.getState(), key)];
    if (entry?.dirty && !entry.pendingSaveId && canSave) void persist();
  };

  useEffect(() => {
    if (!loaded || !dirty || !canSave || pendingSaveId || saveState === 'error') return;
    const timer = window.setTimeout(() => { void persist(); }, 600);
    return () => window.clearTimeout(timer);
  }, [loaded, dirty, canSave, pendingSaveId, saveState, draft, savedId, persist]);

  const addImageUrls = (urls: string[]) => {
    if (urls.length === 0 || !isCurrent()) return;
    const add: MoodboardOp = { op: 'add', images: urls.map(createDraftImage).map(({ id, url }) => ({ id, url })) };
    setDraft((current) => ({
      ...current,
      analysis: null,
      images: applyOps(current.images, [add]),
      pendingOps: queueOps(current.pendingOps, [add]),
    }));
  };

  const handleFiles = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    const uploads = Array.from(files).map((file) => {
      const fd = new FormData();
      fd.append('file', file);
      return apiFetch('/api/uploads', { method: 'POST', body: fd })
        .then((r) => {
          if (!r.ok) throw new Error(`Upload failed: ${r.status}`);
          return r.json();
        })
        .then((data: { url: string }) => data.url);
    });
    Promise.all(uploads)
      .then((urls) => addImageUrls(urls.filter(Boolean)))
      .catch(() => { if (isCurrent()) patch({ saveError: 'Upload failed. Retry.' }); })
      .finally(() => { if (isCurrent()) setUploading(false); });
  };

  const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith('image/'));
    handleFiles(files);
  };

  const updateImage = (id: string, patch: Partial<MoodboardImage>) => {
    // Only what the analysis reads clears it: a private note or a card's
    // place keeps it.
    const steers = patchSteers(patch);
    setDraft((current) => ({
      ...current,
      analysis: steers ? null : current.analysis,
      images: current.images.map((img) => (img.id === id ? { ...img, ...patch } : img)),
      pendingOps: queueOps(current.pendingOps, imagePatchOps(id, patch)),
    }));
  };

  const removeImage = (id: string) => {
    const remove: MoodboardOp = { op: 'remove', images: [id] };
    setDraft((current) => ({
      ...current,
      analysis: null,
      images: applyOps(current.images, [remove]),
      pendingOps: queueOps(current.pendingOps, [remove]),
    }));
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
      if (ownsAnalysis()) store.patch(targetKey, { saveError: err instanceof Error ? err.message : 'Analyze failed.', saveState: 'error' });
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
  const chooseColors = (choice: ColorChoice, hexes: string[]) => {
    setDraft((current) => {
      const board = withBriefFields(current);
      return { ...board, colorChoices: nextColorChoices(board.colorChoices, choice, hexes) };
    });
  };

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
      if (isCurrent()) patch({ saveError: err instanceof Error ? err.message : 'Keep failed.' });
    }
  };

  const regenerateBrief = () => {
    setBriefFields({ briefOverride: null });
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

  const previewThumbnail = thumbnail || draft.images.find((img) => !img.excluded)?.url || '';
  const analysis = draft.analysis;

  return (
    <div className="moodboard-studio-view">
      <WorkspaceHeader title="Moodboard" onBack={exitMoodboardEditor} className="moodboard-studio-toolbar">
        <div className={`moodboard-studio-toolbar__state moodboard-studio-toolbar__state--${saveState}`}>
          {saveState === 'saving' ? 'Saving' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Error' : 'Draft'}
        </div>
        {saveState === 'error' && (
          <button type="button" className="moodboard-studio-toolbar__button" onClick={() => void persist()}>
            Retry
          </button>
        )}
        {savedId && !isDraftId && loaded && (
          <AssetMoveMenu noun="board" buttonClassName="moodboard-studio-toolbar__button"
            choices={moveChoices(draft.projectId, openProject)} onChoose={moveBoard} busy={moving.busy}
            disabled={deleting.busy || Boolean(pendingSaveId) || analyzing} />
        )}
        {savedId && !isDraftId && (
          <button type="button" className="moodboard-studio-toolbar__button" title="Move to Recently deleted"
            disabled={deleting.busy || Boolean(pendingSaveId) || analyzing} onClick={() => void deleteBoard()}>
            Delete
          </button>
        )}
      </WorkspaceHeader>

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

      <main className="moodboard-studio-view__main">
        {loading ? (
          <div className="moodboard-studio-view__loading">
            {loadError ? <div role="alert">{loadError}</div> : 'Loading Moodboard...'}
            {loadError && <button type="button" className="moodboard-studio-toolbar__button"
              onClick={() => { if (!projectReady) void verifyProject(); else patch({ loadError: null, revision: revision + 1 }); }}>Retry loading</button>}
          </div>
        ) : (
          <>
            {loadError && <div className="moodboard-studio__notice moodboard-studio__notice--warn">{loadError}</div>}
            {deleting.error && !deleting.lastDeleted && (
              <div className="moodboard-studio__notice moodboard-studio__notice--error" role="alert">{deleting.error}</div>
            )}
            {saveError && <div className="moodboard-studio__notice moodboard-studio__notice--error">{saveError}</div>}
            {moving.error && (
              <div className="moodboard-studio__notice moodboard-studio__notice--error" role="alert">{moving.error}</div>
            )}

            <section className="moodboard-def">
              <div className="moodboard-def__cover">
                {previewThumbnail ? (
                  <img src={backendAssetUrlSync(previewThumbnail)} alt="" draggable={false} />
                ) : (
                  <span>No images</span>
                )}
              </div>
              <div className="moodboard-def__fields">
                <label className="moodboard-field">
                  <span>Name</span>
                  <input
                    value={draft.name}
                    onChange={(event) => { const name = event.target.value; setDraft((current) => ({ ...current, name })); }}
                    onBlur={sendNow}
                  />
                </label>
                <div className="moodboard-def__row">
                  <label className="moodboard-field">
                    <span>Mode</span>
                    <select
                      value={draft.mode}
                      onChange={(event) => { const mode = event.target.value as Moodboard['mode']; setDraft((current) => ({ ...current, analysis: null, mode })); }}
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
                      ? 'board off: wired nodes get none of it'
                      : <>the total the board&apos;s images share on Krea 2</>}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={draft.strength}
                      onChange={(event) => { const strength = Number(event.target.value); setDraft((current) => ({ ...current, analysis: null, strength })); }}
                    />
                  </label>
                </div>
                <label className="moodboard-field">
                  <span>Notes</span>
                  <AutoGrowTextarea
                    rows={3}
                    value={draft.notes}
                    onChange={(event) => { const notes = event.target.value; setDraft((current) => ({ ...current, analysis: null, notes })); }}
                    onBlur={sendNow}
                    placeholder="Anything about the board, in your words."
                  />
                </label>
                <NotesSwitch on={draft.sendNotes === true}
                  onChange={(sendNotes) => setBriefFields({ sendNotes })} />
              </div>
            </section>

            <section
              className={`moodboard-dropzone ${uploading ? 'moodboard-dropzone--busy' : ''}`}
              onDragOver={(event) => event.preventDefault()}
              onDrop={handleDrop}
            >
              <div className="moodboard-dropzone__head">
                <div>
                  <span className="moodboard-dropzone__label">Images ({draft.images.length})</span>
                  <span className="moodboard-dropzone__hint">Drag images here or add files.</span>
                </div>
                <label className={`moodboard-dropzone__file-wrap ${uploading ? 'moodboard-dropzone__file-wrap--disabled' : ''}`}>
                  <span className="moodboard-dropzone__file-button">
                    {uploading ? 'Uploading' : 'Add Images'}
                  </span>
                  <input
                    className="moodboard-dropzone__file-input"
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={uploading}
                    aria-label="Add Images"
                    onChange={(event) => {
                      handleFiles(event.target.files);
                      event.target.value = '';
                    }}
                  />
                </label>
              </div>
              <div className="moodboard-grid">
                {draft.images.map((img, index) => (
                  <div key={img.id} className={`moodboard-tile ${isSetAside(img) ? 'moodboard-tile--set-aside' : ''}`}>
                    <div className="moodboard-tile__image">
                      <img src={backendAssetUrlSync(img.url)} alt="" draggable={false} />
                      <span className="moodboard-tile__number" aria-label={`Image ${index + 1}`}>#{index + 1}</span>
                      <button type="button" className="moodboard-tile__remove" onClick={() => removeImage(img.id)}>
                        x
                      </button>
                    </div>
                    <ImageColors analysis={analysis} imageId={img.id} />
                    <div className="moodboard-tile__controls">
                      <label>
                        <span>Weight {img.weight.toFixed(2)}</span>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={img.weight}
                          onChange={(event) => updateImage(img.id, { weight: Number(event.target.value) })}
                        />
                      </label>
                      <label className="moodboard-tile__toggle" title="Still read for its colors; never steers">
                        <input
                          type="checkbox"
                          checked={isSetAside(img)}
                          onChange={(event) => updateImage(img.id, setAsidePatch(img, event.target.checked))}
                        />
                        <span>Set aside</span>
                      </label>
                      <label className="moodboard-tile__note">
                        <span>Image note</span>
                        <AutoGrowTextarea
                          rows={2}
                          value={img.notes}
                          placeholder="What to take from this image"
                          onChange={(event) => updateImage(img.id, { notes: event.target.value })}
                          onBlur={sendNow}
                        />
                      </label>
                      <div className="moodboard-tile__note moodboard-tile__note--private">
                        <label className="moodboard-tile__note">
                          <span>Private note</span>
                          <AutoGrowTextarea
                            rows={1}
                            value={img.privateNote ?? ''}
                            maxLength={PRIVATE_NOTE_LIMIT}
                            placeholder="A label for you, like Liked"
                            aria-describedby={`private-note-hint-${img.id}`}
                            onChange={(event) => updateImage(img.id, { privateNote: event.target.value })}
                            onBlur={sendNow}
                          />
                        </label>
                        <span id={`private-note-hint-${img.id}`} className="moodboard-tile__note-hint">
                          Only for you. Not sent anywhere.
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <BriefFields
              direction={draft.direction}
              avoid={draft.avoid}
              pinnedColors={draft.pinnedColors}
              clashMode={draft.clashMode ?? 'leave-out'}
              onChange={setBriefFields}
            />

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
                onEdit={(text) => setBriefFields({ briefOverride: { text } })}
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
                  {analysis.version < 2 && (
                    <div className="moodboard-analysis__outdated">
                      Made by the older analyzer, which ignored image weights and dropped small accent colors. Analyze again to update it.
                    </div>
                  )}
                </div>
              ) : (
                <div className="moodboard-analysis__empty">
                  Analyze after adding images to extract palette, representative references, a style brief, and provider hints.
                </div>
              )}
            </section>
          </>
        )}
      </main>
      {deleting.lastDeleted && (
        <UndoDeleteToast key={deleting.lastDeleted.id} name={deleting.lastDeleted.name} busy={deleting.busy}
          error={deleting.error} onDismiss={deleting.dismiss}
          onUndo={() => { void deleting.undo().then((asset) => { if (asset) openRestored(asset.id, asset.scope); }); }} />
      )}
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
          setError(err instanceof Error ? err.message : 'Failed to load.');
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
        {shown.map((m) => (
          <button
            key={m.id}
            type="button"
            className={m.id === activeId ? 'moodboard-rail__item moodboard-rail__item--active' : 'moodboard-rail__item'}
            onClick={() => onSelect(m.id, scope)}
          >
            <span className="moodboard-rail__thumb">
              {m.thumbnail ? <img src={backendAssetUrlSync(m.thumbnail)} alt="" draggable={false} /> : <span>MB</span>}
            </span>
            <span className="moodboard-rail__meta">
              <span className="moodboard-rail__name">{m.name || 'Untitled'}</span>
              <span className="moodboard-rail__sub">
                {moodboardImagesLabel(m.images.length, setAsideCount(m.images))} · {m.mode}
              </span>
            </span>
          </button>
        ))}
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
