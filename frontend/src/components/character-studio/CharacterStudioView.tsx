import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import {
  createCharacter,
  fetchCharacter,
  lookupStoredAsset,
  updateCharacter,
} from '../../lib/api';
import { UndoDeleteToast } from '../asset-trash/AssetTrash';
import { useAssetDelete } from '../../hooks/useAssetDelete';
import type { Character } from '../../types';
import { NEW_CHARACTER_SENTINEL } from '../../lib/studioSentinels';
import { NO_PROJECT_OPEN, currentProject, useCurrentProject } from '../../lib/currentProject';
import { moveChoices, type MoveChoice } from '../../lib/assetMove';
import { useStudioAssetMove } from '../../hooks/useStudioAssetMove';
import { AssetMoveMenu } from '../asset-move/AssetMoveMenu';
import { useProjectName } from '../../hooks/useProjectName';
import { assetHome, type AssetHome } from '../../lib/assetHome';
import type { AssetScope } from '../../store/uiStore';
import { useAssetStudioDraft } from '../../hooks/useAssetStudioDraft';
import { assetStudioDraftKey, resolveAssetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { wsClient } from '../../lib/wsClient';
import { TAB_ID } from '../../lib/tabId';
import { CharacterVersionConflict, changedFields, characterFields, conflictNote, editedFields, editorLabel,
  rebaseCharacterDraft, type CharacterConflict, type CharacterFields } from '../../lib/characterEdits';
import { CharacterStudioToolbar } from './CharacterStudioToolbar';
import { CharacterLibraryRail } from './CharacterLibraryRail';
import { CharacterDefinitionPanel } from './CharacterDefinitionPanel';
import { CharacterTestPanel } from './CharacterTestPanel';
import { failureCopy, oneLine } from '../../lib/errorCopy';
import { FailureLines } from '../failure/FailureLines';
import '../../styles/character-studio.css';

/** Local editable shape — a Character minus the server-owned fields. The draft
 *  survives workspace navigation in the session draft store until valid (≥3 views + name), at which
 *  point we POST and switch to the real id (so subsequent edits PUT). */
export interface CharacterDraft {
  name: string;
  subjectType: Character['subjectType'];
  referenceViews: string[];
  frozenTraitString: string;
  seed: number;
  consistencyStrength: number;
  projectId?: string;
  // A saved Character's checked writes (lib/characterEdits): its fields as
  // last read and that version. Never sent as they are.
  base?: CharacterFields;
  version?: number;
}

export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'draft';

function emptyDraft(): CharacterDraft {
  return {
    name: '',
    subjectType: 'human',
    referenceViews: [],
    frozenTraitString: '',
    seed: 0,
    consistencyStrength: 0.8,
  };
}

function characterToDraft(c: Character): CharacterDraft {
  // Verbatim contract (spec §6): copy referenceViews + frozenTraitString
  // exactly — never reorder or paraphrase.
  const fields = {
    name: c.name,
    subjectType: c.subjectType,
    referenceViews: [...c.referenceViews],
    frozenTraitString: c.frozenTraitString,
    seed: c.seed,
    consistencyStrength: c.consistencyStrength,
  };
  return { ...fields, projectId: c.projectId, base: { ...fields, referenceViews: [...c.referenceViews] }, version: c.version };
}

/** A new Character's first save: its fields and project, no bookkeeping. */
function createBody(draft: CharacterDraft) {
  const body = { ...draft, name: draft.name.trim() };
  delete body.base;
  delete body.version;
  return body;
}

/** Fields both sides changed, and who the other side was. */
interface ConflictNote {
  conflicts: CharacterConflict[];
  who: string;
}

const MIN_REFERENCE_VIEWS = 3;
const AUTOSAVE_DEBOUNCE_MS = 600;

/** Full-screen Character Studio host. Mounted by App.tsx when
 *  uiStore.characterEditorId is set (viewMode === 'character-editor') — mirrors
 *  CinemaStudioView's mount pattern. Owns the load + draft/persist lifecycle:
 *
 *  - Existing id  → load via fetchCharacter(id), in the scope its projectId
 *    gives → edit locally →
 *    debounced updateCharacter(id, …) once valid.
 *  - 'new' / unresolved id → fresh local DRAFT. The first time it becomes valid
 *    (≥3 views + name) we createCharacter(…), get the real id, and switch
 *    characterEditorId to it so later edits PUT.
 *
 *  ≥3-view guard (spec §6): when referenceViews.length < 3 we never call
 *  create/update — we surface an inline message and stay in 'draft' state. */
export function CharacterStudioView() {
  const characterEditorId = useUIStore((s) => s.characterEditorId);
  const characterEditorScope = useUIStore((s) => s.characterEditorScope);
  const enterCharacterEditor = useUIStore((s) => s.enterCharacterEditor);

  const studio = useAssetStudioDraft('character', characterEditorScope, characterEditorId, emptyDraft);
  const { draft, savedId, thumbnail, saveState, loadError, saveError, retry, loaded,
    dirty, pendingSaveId, key, revision, epoch, projectId, projectReady, verifyProject, setDraft, initialize, patch } = studio;
  const loading = !loaded;
  const [railScope, setRailScope] = useState<AssetScope>(characterEditorScope);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const isDraftId = !characterEditorId || characterEditorId === NEW_CHARACTER_SENTINEL;
  const isCurrent = useCallback(() => {
    const ui = useUIStore.getState();
    return mounted.current && ui.viewMode === 'character-editor' && ui.characterEditorId === characterEditorId
      && ui.characterEditorScope === characterEditorScope
      && projectReady && (characterEditorScope !== 'project' || (currentProject()?.id ?? null) === projectId)
      && useAssetStudioDraftStore.getState().entries[key]?.epoch === epoch;
  }, [characterEditorId, characterEditorScope, key, epoch, projectReady, projectId]);

  // Outside edits (lib/characterEdits): a field both the person and someone
  // else changed keeps the person's value, and this says so.
  const [conflict, setConflict] = useState<ConflictNote | null>(null);
  useEffect(() => { setConflict(null); }, [key, epoch]);
  const entryNow = useCallback(() => {
    const state = useAssetStudioDraftStore.getState();
    return state.entries[resolveAssetStudioDraftKey(state, key)];
  }, [key]);
  const draftNow = useCallback(() => entryNow()?.draft as CharacterDraft | undefined, [entryNow]);
  // The newest version an outside edit announced, and who made it, so a save
  // in flight when it came reads the Character again once it lands.
  const announced = useRef(0);
  const lastEditor = useRef('Someone else');
  // The draft key last read on open, so a kept draft reads its Character once.
  const readOnOpen = useRef<string | null>(null);
  /** `draft` moved onto `character` (see rebaseCharacterDraft). */
  const moveDraft = useCallback((character: Character, asSent?: CharacterFields) => {
    const entry = entryNow();
    const current = entry?.draft as CharacterDraft | undefined;
    if (!entry || !current) return;
    const { draft: next, conflicts } = rebaseCharacterDraft(current, character, { asSent, dirty: entry.dirty });
    useAssetStudioDraftStore.getState().patch(key, { draft: next, thumbnail: character.thumbnail });
    if (!conflicts.length || !mounted.current) return;
    const who = lastEditor.current;
    setConflict((previous) => ({
      who: previous && previous.who !== who ? 'Someone else' : who,
      conflicts: [...(previous?.conflicts.filter((old) => !conflicts.some((c) => c.field === old.field)) ?? []), ...conflicts],
    }));
  }, [key, entryNow]);

  /** Read the open Character again after someone else saved it; the person's
   *  unsaved edits stay. Not mid-save: the save does it when it lands. */
  const follow = useCallback(async () => {
    const entry = entryNow();
    if (!entry?.loaded || !entry.savedId || entry.pendingSaveId) return;
    const found = await fetchCharacter(entry.savedId).catch(() => null);
    const latest = entryNow();
    if (!found || !mounted.current || !latest || latest.pendingSaveId || latest.savedId !== found.id) return;
    if (found.version <= ((latest.draft as CharacterDraft).version ?? 0)) return;
    moveDraft(found);
  }, [entryNow, moveDraft]);

  useEffect(() => wsClient.subscribe((event) => {
    // Back after the socket was down: what was said meanwhile isn't replayed,
    // so read the Character again (follow keeps it only if it's newer).
    if (event.type === 'socketReconnected') {
      lastEditor.current = 'Someone else';
      void follow();
      return;
    }
    if (event.type !== 'storedAssetChanged' || event.kind !== 'character' || event.deleted) return;
    // A move says no version (keptDraftMoves follows it); this tab's own echo is skipped.
    if (typeof event.version !== 'number' || (event.edit?.tab && event.edit.tab === TAB_ID)) return;
    const entry = entryNow();
    if (!entry?.loaded || entry.savedId !== event.id) return;
    if (event.version <= ((entry.draft as CharacterDraft).version ?? 0)) return;
    announced.current = Math.max(announced.current, event.version);
    lastEditor.current = editorLabel(event.edit?.actor);
    void follow();
  }), [entryNow, follow]);

  // A draft kept from an earlier visit loads without a fetch, so it may miss
  // what changed while the Studio was closed: read the Character once.
  useEffect(() => {
    if (!loaded || !savedId) return;
    const marker = `${key}:${epoch}:${savedId}`;
    if (readOnOpen.current === marker) return;
    readOnOpen.current = marker;
    lastEditor.current = 'Someone else';
    void follow();
  }, [loaded, savedId, key, epoch, follow]);

  useEffect(() => {
    if (!projectReady || loaded) return;
    let cancelled = false;
    const current = () => !cancelled && isCurrent()
      && useAssetStudioDraftStore.getState().entries[key]?.revision === revision;
    patch({ loadError: null, saveError: null });
    if (isDraftId || !characterEditorId) {
      initialize(characterEditorScope === 'project' ? { ...emptyDraft(), projectId: projectId! } : emptyDraft());
    } else {
      // Load the character by id. The scope it was opened with is only a hint
      // (a node's Open button doesn't know it, and a list can be stale); the
      // character's own projectId says where it lives.
      void fetchCharacter(characterEditorId).then((found) => {
        if (!current()) return;
        if (!found) {
          const fresh = characterEditorScope === 'project' ? { ...emptyDraft(), projectId: projectId! } : emptyDraft();
          // In Recently deleted? Say so; the list in the rail restores it.
          void lookupStoredAsset('character', characterEditorId!).catch(() => null).then((stored) => {
            if (!current()) return;
            initialize(fresh, null, '', stored?.status === 'trashed'
              ? 'This Character is in Recently deleted. Restore it from the list on the left.'
              : 'Character not found — it may have been deleted for good. Add ≥3 reference views to save a new one.');
          });
          return;
        }
        const scope: AssetScope = found.projectId ? 'project' : 'global';
        if (scope !== characterEditorScope) {
          enterCharacterEditor(found.id, scope);
          return;
        }
        setRailScope(scope);
        // Just read: the open's read (above) has nothing to add.
        readOnOpen.current = `${key}:${epoch}:${found.id}`;
        initialize(characterToDraft(found), found.id, found.thumbnail);
      }).catch((err) => {
        if (current()) patch({ loadError: failureCopy(err, { heading: "Couldn't load the character." }) });
      });
    }
    return () => { cancelled = true; };
  }, [key, epoch, revision, loaded, projectReady, projectId, characterEditorId, characterEditorScope, initialize, patch, isDraftId, isCurrent,
    enterCharacterEditor]);

  useEffect(() => {
    if (isDraftId && loaded && savedId && isCurrent()) enterCharacterEditor(savedId, characterEditorScope);
  }, [isDraftId, loaded, savedId, isCurrent, characterEditorScope, enterCharacterEditor]);

  const isValid = draft.name.trim().length > 0 && draft.referenceViews.length >= MIN_REFERENCE_VIEWS;
  const persist = useCallback(async () => {
    if (!isCurrent() || !await verifyProject() || !isCurrent()) return;
    const store = useAssetStudioDraftStore.getState();
    const current = store.entries[key];
    const currentDraft = current?.draft as CharacterDraft | undefined;
    if (!currentDraft || !currentDraft.name.trim() || currentDraft.referenceViews.length < MIN_REFERENCE_VIEWS) return;
    const attempt = store.beginSave(key);
    if (!attempt) return;
    try {
      const savedId = attempt.entry.savedId;
      let result: Character | null = null;
      if (!savedId) {
        result = await createCharacter(createBody(currentDraft));
        moveDraft(result, characterFields(currentDraft));
      } else {
        // Only the fields the person changed since the last read, with that
        // version. Someone else saved since (409): take the Character as it
        // is, keep the person's edits on it, send again.
        for (let tries = 0; ; tries += 1) {
          const snapshot = draftNow();
          if (!snapshot) return;
          const fields = changedFields(snapshot);
          if (!Object.keys(fields).length) break;
          try {
            result = await updateCharacter(savedId, { ...(fields as Partial<CharacterDraft>),
              ...(snapshot.projectId ? { projectId: snapshot.projectId } : {}),
              ...(snapshot.version === undefined ? {} : { baseVersion: snapshot.version }) });
            moveDraft(result, Object.fromEntries(Object.keys(fields)
              .map((field) => [field, (snapshot as CharacterFields)[field as keyof CharacterFields]])));
            break;
          } catch (err) {
            if (!(err instanceof CharacterVersionConflict) || tries >= 2) throw err;
            moveDraft(err.character);
          }
        }
      }
      const id = result?.id ?? savedId!;
      if (!store.finishSave(key, attempt.id, attempt.revision, id, result?.thumbnail ?? attempt.entry.thumbnail)) return;
      if (announced.current > (draftNow()?.version ?? 0)) void follow();
      if (!savedId && result) {
        const createdScope: AssetScope = result.projectId ? 'project' : 'global';
        const selectedAtCompletion = isCurrent();
        store.copyTo(key, assetStudioDraftKey('character', createdScope, result.id, result.projectId));
        if (selectedAtCompletion) {
          setRailScope(createdScope);
          enterCharacterEditor(result.id, createdScope);
        }
      }
    } catch (err) {
      store.failSave(key, attempt.id, failureCopy(err, { heading: "Couldn't save the character." }));
    }
  }, [key, isCurrent, verifyProject, enterCharacterEditor, moveDraft, draftNow, follow]);

  useEffect(() => {
    if (!loaded || !dirty || !isValid || pendingSaveId || saveState === 'error') return;
    const timer = window.setTimeout(() => { void persist(); }, AUTOSAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [loaded, dirty, isValid, pendingSaveId, saveState, draft, savedId, persist]);

  // auto-thumbnail = referenceViews[0] (mirrors the backend's auto-pick) so the
  // toolbar/rail preview stays live before the server round-trip lands.
  const previewThumbnail = thumbnail || draft.referenceViews[0] || '';

  const handleSelectCharacter = (id: string, scope: AssetScope) => {
    if (id === characterEditorId && scope === characterEditorScope) return;
    setRailScope(scope);
    enterCharacterEditor(id, scope);
  };

  const handleNewCharacter = (scope: AssetScope) => {
    if (!isCurrent()) return;
    const project = scope === 'project' ? currentProject() : null;
    if (scope === 'project' && !project) {
      patch({ saveError: NO_PROJECT_OPEN });
      return;
    }
    useAssetStudioDraftStore.getState().reset(
      assetStudioDraftKey('character', scope, NEW_CHARACTER_SENTINEL, project?.id), emptyDraft());
    setRailScope(scope);
    enterCharacterEditor(NEW_CHARACTER_SENTINEL, scope);
  };

  const belowMinViews = draft.referenceViews.length < MIN_REFERENCE_VIEWS;

  const deleting = useAssetDelete('character');
  const deleteCharacterNow = async () => {
    if (!savedId || !isCurrent()) return;
    const scope = characterEditorScope;
    const deletedKey = key;
    // Save edits made since the last autosave first, so Undo and Restore
    // bring back what the person last saw. If that save fails, don't delete.
    if (dirty && isValid) {
      await persist();
      if (!mounted.current || useAssetStudioDraftStore.getState().entries[deletedKey]?.dirty) return;
    }
    const removed = await deleting.remove({ id: savedId, name: draft.name.trim(), scope });
    if (!removed || !mounted.current) return;
    const store = useAssetStudioDraftStore.getState();
    // Forget the session draft, so reopening it after a restore loads what was saved.
    store.reset(deletedKey, emptyDraft());
    if (useUIStore.getState().viewMode !== 'character-editor') return;
    const openProjectId = currentProject()?.id ?? null;
    store.reset(assetStudioDraftKey('character', scope, NEW_CHARACTER_SENTINEL, openProjectId),
      scope === 'project' && openProjectId ? { ...emptyDraft(), projectId: openProjectId } : emptyDraft());
    setRailScope(scope);
    enterCharacterEditor(NEW_CHARACTER_SENTINEL, scope);
  };
  // Move to Global / Move to <open project> (contract 07, 1.10).
  const openProject = useCurrentProject();
  const moving = useStudioAssetMove('character');
  const moveCharacter = (choice: MoveChoice) => {
    if (!savedId) return;
    const id = savedId;
    void moving.move({ id, key, target: choice.target, persist, canSave: isValid, isCurrent,
      isOpen: () => mounted.current && useUIStore.getState().viewMode === 'character-editor'
        && useUIStore.getState().characterEditorId === id,
      open: (movedId, scope) => { setRailScope(scope); enterCharacterEditor(movedId, scope); } });
  };
  /** Put back the other side's value of each field both changed: an edit
   *  of the person's, saved like any other. */
  const useTheirs = () => {
    if (!conflict || !isCurrent()) return;
    const theirs = Object.fromEntries(conflict.conflicts.map(({ field, theirs: value }) => [field, value]));
    setDraft((current) => ({ ...current, ...theirs }));
    setConflict(null);
  };
  const undoDelete = async () => {
    const asset = await deleting.undo();
    if (!asset || !mounted.current || useUIStore.getState().viewMode !== 'character-editor') return;
    setRailScope(asset.scope);
    enterCharacterEditor(asset.id, asset.scope);
  };

  // Where the open Character lives, once it's saved: its own projectId says,
  // whatever scope it was opened with (a node's Open button guesses, and a
  // draft kept from an earlier visit loads without a fetch). The rail opens
  // on that scope, and says so when it's another project's Character.
  /** Retry is a save, so it shows only beside a save's own failure (GM,
   * error-copy round 3: "A Retry that does something else is a defect."). */
  const canRetry = Boolean(saveError) && retry === 'save';
  /** A failed save that another line (no project open) replaced is still
   * owed: Error, dirty, and autosave waits while it says Error. The toolbar
   * keeps its Retry (a save) for it; the notice's line, which no save
   * redoes, keeps its own words and no Retry (round 3 review). */
  const toolbarCanRetry = saveState === 'error' && (retry === 'save' || (retry == null && dirty));

  const characterProjectName = useProjectName(draft.projectId);
  const characterHome: AssetHome | null = loaded && savedId
    ? assetHome(draft.projectId, projectId, characterProjectName) : null;
  const shownRailScope = characterHome?.scope ?? railScope;

  return (
    <div className="character-studio-view">
      <CharacterStudioToolbar
          saveState={saveState}
          canRetry={toolbarCanRetry}
          saveError={saveError === null ? null : typeof saveError === 'string' ? saveError : oneLine(saveError)}
          onRetry={() => void persist()}
          onDelete={savedId && !isDraftId ? () => { void deleteCharacterNow(); } : undefined}
          deleteDisabled={deleting.busy || Boolean(pendingSaveId)}
          move={savedId && !isDraftId && loaded ? (
            <AssetMoveMenu noun="Character" buttonClassName="character-studio-toolbar__retry"
              choices={moveChoices(draft.projectId, openProject)} onChoose={moveCharacter} busy={moving.busy}
              disabled={deleting.busy || Boolean(pendingSaveId)} />
          ) : undefined}
      />

      <aside className="character-studio-view__rail">
        <CharacterLibraryRail
          key={shownRailScope}
          activeId={savedId ?? (isDraftId ? NEW_CHARACTER_SENTINEL : characterEditorId)}
          initialScope={shownRailScope}
          characterHome={characterHome}
          projectId={projectId}
          refreshKey={`${deleting.refreshKey}:${moving.moves}`}
          onSelect={handleSelectCharacter}
          onNew={handleNewCharacter}
        />
      </aside>

      <main className="character-studio-view__main">
        {loading ? (
          <div className="character-studio-view__loading">
            {/* As in the board's Studio (round 3b): no Retry loading with no project open. */}
            {loadError ? <div role="alert"><FailureLines failure={loadError} retry={projectReady} /></div> : 'Loading Character…'}
            {loadError && projectReady && <button type="button" className="character-studio-view__retry"
              onClick={() => patch({ loadError: null, revision: revision + 1 })}>Retry loading</button>}
          </div>
        ) : (
          <>
            {loadError && (
              <div className="character-studio-view__notice character-studio-view__notice--warn">
                <FailureLines failure={loadError} />
              </div>
            )}
            {deleting.deleteError && (
              <div className="character-studio-view__notice character-studio-view__notice--error" role="alert">
                <FailureLines failure={deleting.deleteError} />
              </div>
            )}
            {moving.error && (
              <div className="character-studio-view__notice character-studio-view__notice--error" role="alert">
                <FailureLines failure={moving.error} />
              </div>
            )}

            {conflict && (
              <div className="character-studio-view__notice character-studio-view__notice--warn character-studio-view__notice--conflict"
                role="status" aria-labelledby="character-studio-conflict">
                <span id="character-studio-conflict">{conflictNote(conflict.conflicts, conflict.who)}</span>{' '}
                <button type="button" className="character-studio-view__retry" onClick={useTheirs}>Use theirs</button>
                <button type="button" className="character-studio-view__retry" onClick={() => setConflict(null)}>Dismiss</button>
              </div>
            )}

            <CharacterDefinitionPanel
              key={`${key}:${epoch}`}
              draft={draft}
              thumbnail={previewThumbnail}
              // Only what this edit changed goes onto the draft as it is now,
              // so an outside edit that landed since this render isn't undone.
              onChange={(next) => { if (isCurrent()) setDraft((current) => ({ ...current, ...editedFields(draft, next) })); }}
              onAppendReferences={(urls) => { if (isCurrent()) setDraft((current) => ({
                ...current, referenceViews: [...current.referenceViews, ...urls],
              })); }}
            />

            {belowMinViews && (
              <div className="character-studio-view__notice character-studio-view__notice--guard">
                A Character needs at least {MIN_REFERENCE_VIEWS} reference views
                before it can be saved.
              </div>
            )}

            {saveError && (
              <div className="character-studio-view__notice character-studio-view__notice--error">
                {/* Its own Retry (a save) is the retry: GM's short line (WRAP rule). */}
                <FailureLines failure={saveError} retry={canRetry} />{canRetry && <>{' '}
                <button
                  type="button"
                  className="character-studio-view__retry"
                  onClick={() => void persist()}
                >
                  Retry
                </button></>}
              </div>
            )}

            <CharacterTestPanel
              key={`test:${key}:${epoch}`}
              characterId={savedId}
              draft={draft}
              thumbnail={previewThumbnail}
              canTest={Boolean(savedId) && !belowMinViews}
            />
          </>
        )}
      </main>
      {deleting.lastDeleted && (
        <UndoDeleteToast key={deleting.lastDeleted.id} name={deleting.lastDeleted.name} busy={deleting.busy}
          error={deleting.undoError} onDismiss={deleting.dismiss} onUndo={() => { void undoDelete(); }} />
      )}
    </div>
  );
}

export { MIN_REFERENCE_VIEWS };
