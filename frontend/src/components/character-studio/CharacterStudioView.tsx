import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import {
  createCharacter,
  fetchCharacters,
  updateCharacter,
} from '../../lib/api';
import type { Character } from '../../types';
import { NEW_CHARACTER_SENTINEL } from '../../lib/studioSentinels';
import { CharacterStudioToolbar } from './CharacterStudioToolbar';
import { CharacterLibraryRail } from './CharacterLibraryRail';
import { CharacterDefinitionPanel } from './CharacterDefinitionPanel';
import { CharacterTestPanel } from './CharacterTestPanel';
import '../../styles/character-studio.css';

/** Local editable shape — a Character minus the server-owned fields. The draft
 *  lives in local state until it first becomes valid (≥3 views + name), at which
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
  const enterCharacterEditor = useUIStore((s) => s.enterCharacterEditor);

  const [draft, setDraft] = useState<CharacterDraft>(emptyDraft);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [thumbnail, setThumbnail] = useState<string>('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  // Guards against persisting the just-loaded snapshot (load sets state, which
  // would otherwise immediately re-trigger the autosave effect) and against
  // double-creating a draft while a POST is in flight.
  const skipNextAutosave = useRef(false);
  const createInFlight = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Records the id of a character we JUST created via persist(), so the load
  // effect can skip the redundant re-fetch when characterEditorId switches to
  // it. Without this, the load effect would (a) overwrite any edits typed
  // between the POST resolving and the re-fetch returning (lost update) and
  // (b) flip setLoading(true), remounting the editor right after first save
  // (jarring flash). Our local state is already authoritative and newer than
  // any server snapshot, so we keep it and skip the fetch entirely.
  const justCreatedId = useRef<string | null>(null);

  const isDraftId =
    !characterEditorId || characterEditorId === NEW_CHARACTER_SENTINEL;

  // ── Load lifecycle ────────────────────────────────────────────────────────
  // A real id loads the stored Character; the sentinel/unresolved id starts a
  // fresh local draft. We resolve via fetchCharacters(global) + find then fall
  // back to the project scope (no single-id GET helper exists yet).
  useEffect(() => {
    // Skip the fetch+setDraft+setLoading round-trip when we're switching to an
    // id we just created locally. Current state is authoritative and newer than
    // the server snapshot — re-fetching would clobber edits typed since the POST
    // and remount the panel (loading flash). Consume the flag and bail.
    if (characterEditorId && characterEditorId === justCreatedId.current) {
      justCreatedId.current = null;
      return;
    }

    let cancelled = false;
    setLoadError(null);
    setSaveError(null);
    setSaveState('idle');

    if (isDraftId) {
      skipNextAutosave.current = true;
      setDraft(emptyDraft());
      setSavedId(null);
      setThumbnail('');
      setSaveState('draft');
      return;
    }

    const targetId = characterEditorId as string;
    setLoading(true);
    (async () => {
      try {
        const [globalChars, projectChars] = await Promise.all([
          fetchCharacters('global').catch(() => [] as Character[]),
          fetchCharacters('project').catch(() => [] as Character[]),
        ]);
        if (cancelled) return;
        const found =
          globalChars.find((c) => c.id === targetId) ??
          projectChars.find((c) => c.id === targetId) ??
          null;
        if (!found) {
          // Referenced-but-missing Character (spec §6): show a clear state
          // rather than crashing. Treat as an empty draft the user can rebuild.
          skipNextAutosave.current = true;
          setDraft(emptyDraft());
          setSavedId(null);
          setThumbnail('');
          setLoadError(
            'Character not found — it may have been deleted. Add ≥3 reference views to save a new one.',
          );
          setSaveState('draft');
          return;
        }
        skipNextAutosave.current = true;
        setDraft(characterToDraft(found));
        setSavedId(found.id);
        setThumbnail(found.thumbnail);
        setSaveState('saved');
      } catch (err) {
        if (cancelled) return;
        setLoadError(
          err instanceof Error ? err.message : 'Failed to load Character.',
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // isDraftId is derived purely from characterEditorId, so keying on the
    // latter alone covers it; listing both would just be noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterEditorId]);

  const isValid =
    draft.name.trim().length > 0 &&
    draft.referenceViews.length >= MIN_REFERENCE_VIEWS;

  // ── Persist lifecycle (debounced autosave) ─────────────────────────────────
  // Runs on every draft change. The ≥3-view + name guard blocks all network
  // writes — below the threshold we sit in 'draft' state with no create/update.
  useEffect(() => {
    if (skipNextAutosave.current) {
      skipNextAutosave.current = false;
      return;
    }

    if (!isValid) {
      setSaveState('draft');
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void persist();
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // persist closes over the latest draft/savedId; we intentionally key on the
    // serialized draft so any field edit reschedules the save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, savedId, isValid]);

  const persist = useCallback(async () => {
    if (!isValid) {
      setSaveState('draft');
      return;
    }
    setSaveState('saving');
    setSaveError(null);

    // Verbatim contract: send referenceViews + frozenTraitString exactly as
    // entered/uploaded — no reorder, no trim of the trait string.
    const body = {
      name: draft.name.trim(),
      subjectType: draft.subjectType,
      referenceViews: draft.referenceViews,
      frozenTraitString: draft.frozenTraitString,
      seed: draft.seed,
      consistencyStrength: draft.consistencyStrength,
      ...(draft.projectId ? { projectId: draft.projectId } : {}),
    };

    try {
      if (savedId) {
        const updated = await updateCharacter(savedId, body);
        setThumbnail(updated.thumbnail);
        setSaveState('saved');
      } else {
        if (createInFlight.current) return;
        createInFlight.current = true;
        const created = await createCharacter(body);
        // Adopt the server-owned fields we hold from `created` (id, thumbnail)
        // so local state stays authoritative across the id switch below.
        setSavedId(created.id);
        setThumbnail(created.thumbnail);
        setSaveState('saved');
        // Switch the editor to the real id so future edits PUT, not POST.
        // Record justCreatedId so the load effect skips the redundant re-fetch
        // (which would clobber edits typed since this POST and remount the
        // panel). Local state is already current — no server snapshot needed.
        if (characterEditorId !== created.id) {
          justCreatedId.current = created.id;
          enterCharacterEditor(created.id);
        }
      }
    } catch (err) {
      setSaveState('error');
      setSaveError(
        err instanceof Error ? err.message : 'Save failed. Retry?',
      );
    } finally {
      createInFlight.current = false;
    }
  }, [draft, savedId, isValid, characterEditorId, enterCharacterEditor]);

  // auto-thumbnail = referenceViews[0] (mirrors the backend's auto-pick) so the
  // toolbar/rail preview stays live before the server round-trip lands.
  const previewThumbnail = thumbnail || draft.referenceViews[0] || '';

  const handleSelectCharacter = (id: string) => {
    if (id === characterEditorId) return;
    enterCharacterEditor(id);
  };

  const handleNewCharacter = () => {
    enterCharacterEditor(NEW_CHARACTER_SENTINEL);
  };

  const belowMinViews = draft.referenceViews.length < MIN_REFERENCE_VIEWS;

  return (
    <div className="character-studio-view">
      <header className="character-studio-view__header">
        <CharacterStudioToolbar
          saveState={saveState}
          saveError={saveError}
          onRetry={() => void persist()}
        />
      </header>

      <aside className="character-studio-view__rail">
        <CharacterLibraryRail
          activeId={savedId ?? (isDraftId ? NEW_CHARACTER_SENTINEL : characterEditorId)}
          onSelect={handleSelectCharacter}
          onNew={handleNewCharacter}
        />
      </aside>

      <main className="character-studio-view__main">
        {loading ? (
          <div className="character-studio-view__loading">Loading Character…</div>
        ) : (
          <>
            {loadError && (
              <div className="character-studio-view__notice character-studio-view__notice--warn">
                {loadError}
              </div>
            )}

            <CharacterDefinitionPanel
              draft={draft}
              thumbnail={previewThumbnail}
              onChange={setDraft}
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
