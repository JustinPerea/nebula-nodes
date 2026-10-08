import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import {
  createCharacter,
  fetchCharacters,
  updateCharacter,
} from '../../lib/api';
import type { Character } from '../../types';
import { NEW_CHARACTER_SENTINEL } from '../../lib/studioSentinels';
import { getCurrentProject } from '../../lib/currentProject';
import type { AssetScope } from '../../store/uiStore';
import { useAssetStudioDraft } from '../../hooks/useAssetStudioDraft';
import { assetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { CharacterStudioToolbar } from './CharacterStudioToolbar';
import { CharacterLibraryRail } from './CharacterLibraryRail';
import { CharacterDefinitionPanel } from './CharacterDefinitionPanel';
import { CharacterTestPanel } from './CharacterTestPanel';
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
  return {
    name: c.name,
    subjectType: c.subjectType,
    referenceViews: [...c.referenceViews],
    frozenTraitString: c.frozenTraitString,
    seed: c.seed,
    consistencyStrength: c.consistencyStrength,
    projectId: c.projectId,
  };
}

const MIN_REFERENCE_VIEWS = 3;
const AUTOSAVE_DEBOUNCE_MS = 600;

/** Full-screen Character Studio host. Mounted by App.tsx when
 *  uiStore.characterEditorId is set (viewMode === 'character-editor') — mirrors
 *  CinemaStudioView's mount pattern. Owns the load + draft/persist lifecycle:
 *
 *  - Existing id  → load via fetchCharacters + find → edit locally →
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
  const { draft, savedId, thumbnail, saveState, loadError, saveError, loaded,
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
      && projectReady && (characterEditorScope !== 'project' || useAssetStudioDraftStore.getState().projectId === projectId)
      && useAssetStudioDraftStore.getState().entries[key]?.epoch === epoch;
  }, [characterEditorId, characterEditorScope, key, epoch, projectReady, projectId]);

  useEffect(() => {
    if (!projectReady || loaded) return;
    let cancelled = false;
    const current = () => !cancelled && isCurrent()
      && useAssetStudioDraftStore.getState().entries[key]?.revision === revision;
    patch({ loadError: null, saveError: null });
    if (isDraftId) {
      initialize(characterEditorScope === 'project' ? { ...emptyDraft(), projectId: projectId! } : emptyDraft());
    } else {
      void Promise.all([fetchCharacters('global'), fetchCharacters('project')]).then(([globalChars, projectChars]) => {
        if (!current()) return;
        const found = (characterEditorScope === 'project' ? projectChars : globalChars)
          .find((candidate) => candidate.id === characterEditorId && (characterEditorScope !== 'project' || candidate.projectId === projectId));
        if (found) {
          setRailScope(found.projectId ? 'project' : 'global');
          initialize(characterToDraft(found), found.id, found.thumbnail);
        } else {
          initialize(characterEditorScope === 'project' ? { ...emptyDraft(), projectId: projectId! } : emptyDraft(),
            null, '', 'Character not found — it may have been deleted. Add ≥3 reference views to save a new one.');
        }
      }).catch((err) => {
        if (current()) patch({ loadError: err instanceof Error ? err.message : 'Failed to load Character.' });
      });
    }
    return () => { cancelled = true; };
  }, [key, revision, loaded, projectReady, projectId, characterEditorId, characterEditorScope, initialize, patch, isDraftId, isCurrent]);

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
    const body = { ...currentDraft, name: currentDraft.name.trim() };
    try {
      const result = attempt.entry.savedId
        ? await updateCharacter(attempt.entry.savedId, body) : await createCharacter(body);
      if (!store.finishSave(key, attempt.id, attempt.revision, result.id, result.thumbnail)) return;
      if (!attempt.entry.savedId) {
        const createdScope: AssetScope = result.projectId ? 'project' : 'global';
        const selectedAtCompletion = isCurrent();
        store.copyTo(key, assetStudioDraftKey('character', createdScope, result.id, result.projectId));
        if (selectedAtCompletion) {
          setRailScope(createdScope);
          enterCharacterEditor(result.id, createdScope);
        }
      }
    } catch (err) {
      store.failSave(key, attempt.id, err instanceof Error ? err.message : 'Save failed. Retry?');
    }
  }, [key, isCurrent, verifyProject, enterCharacterEditor]);

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

  const handleNewCharacter = async (scope: AssetScope) => {
    if (!isCurrent()) return;
    try {
      const currentProject = scope === 'project' ? await getCurrentProject() : null;
      if (!isCurrent()) return;
      const store = useAssetStudioDraftStore.getState();
      if (currentProject) store.setProjectId(currentProject.id);
      store.reset(assetStudioDraftKey('character', scope, NEW_CHARACTER_SENTINEL, currentProject?.id), emptyDraft());
      setRailScope(scope);
      enterCharacterEditor(NEW_CHARACTER_SENTINEL, scope);
    } catch (err) {
      if (isCurrent()) patch({ saveError: err instanceof Error ? err.message : 'Failed to resolve project.' });
    }
  };

  const belowMinViews = draft.referenceViews.length < MIN_REFERENCE_VIEWS;

  return (
    <div className="character-studio-view">
      <CharacterStudioToolbar
          saveState={saveState}
          saveError={saveError}
          onRetry={() => void persist()}
      />

      <aside className="character-studio-view__rail">
        <CharacterLibraryRail
          key={railScope}
          activeId={savedId ?? (isDraftId ? NEW_CHARACTER_SENTINEL : characterEditorId)}
          initialScope={railScope}
          onSelect={handleSelectCharacter}
          onNew={(scope) => { void handleNewCharacter(scope); }}
        />
      </aside>

      <main className="character-studio-view__main">
        {loading ? (
          <div className="character-studio-view__loading">
            {loadError ? <div role="alert">{loadError}</div> : 'Loading Character…'}
            {loadError && <button type="button" className="character-studio-view__retry"
              onClick={() => { if (!projectReady) void verifyProject(); else patch({ loadError: null, revision: revision + 1 }); }}>Retry loading</button>}
          </div>
        ) : (
          <>
            {loadError && (
              <div className="character-studio-view__notice character-studio-view__notice--warn">
                {loadError}
              </div>
            )}

            <CharacterDefinitionPanel
              key={`${key}:${epoch}`}
              draft={draft}
              thumbnail={previewThumbnail}
              onChange={(next) => { if (isCurrent()) setDraft(next); }}
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
                {saveError}{' '}
                <button
                  type="button"
                  className="character-studio-view__retry"
                  onClick={() => void persist()}
                >
                  Retry
                </button>
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
    </div>
  );
}

export { MIN_REFERENCE_VIEWS };
