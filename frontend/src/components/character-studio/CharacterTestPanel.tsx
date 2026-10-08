import { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import type { CharacterDraft } from './CharacterStudioView';
import { assetStudioDraftKey, resolveAssetStudioDraftKey, useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';

interface CharacterTestPanelProps {
  /** The saved Character id, or null while the draft is still unsaved. */
  characterId: string | null;
  draft: CharacterDraft;
  thumbnail: string;
  /** True only when the Character is saved AND has ≥3 views — a stored asset is
   *  required to drop a real `character` node onto the canvas. */
  canTest: boolean;
}

/** Thin "test generate" panel (spec §4.5, kept deliberately minimal for v1).
 *
 *  HONEST SCOPE: there is no clean one-shot generation primitive reachable from
 *  the frontend without new backend endpoints, so "Test Generate" runs as a
 *  TEST-ON-CANVAS flow (per Task 6's scoping rule): it drops a `character` node
 *  for this saved Character onto the canvas via graphStore.addCharacterNode and
 *  exits to the canvas, where the user wires it into a base-edit / Cinema Scene
 *  node and runs it through the existing execution pipeline. The prompt the user
 *  types here is shown as guidance for that canvas run; it is NOT sent anywhere
 *  by this panel (no backend call is made). This avoids fragile auto-wiring and
 *  any new endpoints while staying fully reachable. */
export function CharacterTestPanel({
  characterId,
  draft,
  thumbnail,
  canTest,
}: CharacterTestPanelProps) {
  const addCharacterNode = useGraphStore((s) => s.addCharacterNode);
  const exitCharacterEditor = useUIStore((s) => s.exitCharacterEditor);
  const [prompt, setPrompt] = useState('');
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const handleTestOnCanvas = async () => {
    if (!characterId || !canTest || pending) return;
    const selected = useUIStore.getState();
    const drafts = useAssetStudioDraftStore.getState();
    const key = resolveAssetStudioDraftKey(drafts, assetStudioDraftKey('character', selected.characterEditorScope,
      selected.characterEditorId, drafts.projectId));
    const epoch = drafts.entries[key]?.epoch;
    setPending(true);
    try {
      const nodeId = await addCharacterNode(
        characterId,
        { x: 400, y: 300 },
        { name: draft.name, thumbnail },
      );
      // Hand off to the canvas so the user can wire + run the identity test
      // through the existing pipeline.
      const current = useUIStore.getState();
      const currentDrafts = useAssetStudioDraftStore.getState();
      if (nodeId && mounted.current && current.viewMode === 'character-editor'
        && current.characterEditorId === selected.characterEditorId
        && current.characterEditorScope === selected.characterEditorScope
        && (current.characterEditorScope !== 'project' || currentDrafts.projectId === drafts.projectId)
        && currentDrafts.entries[key]?.epoch === epoch) exitCharacterEditor();
    } catch (err) {
      console.error('[character] test-on-canvas drop failed:', err);
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  return (
    <section className="character-test">
      <div className="character-test__head">
        <span className="character-def__label">Test identity</span>
        <span className="character-def__hint">
          Drop this Character on the canvas, wire it into a base-edit or Cinema
          Scene node, and run to confirm the look holds.
        </span>
      </div>

      <label className="character-def__field">
        <span className="character-def__label">Test prompt (guidance)</span>
        <input
          type="text"
          className="character-def__input"
          placeholder="e.g. the character drinking coffee at a window, morning light"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
      </label>

      <button
        type="button"
        className="character-test__run"
        onClick={() => void handleTestOnCanvas()}
        disabled={!canTest || pending}
        title={
          canTest
            ? 'Drop this Character on the canvas to test on a base-edit node'
            : 'Save the Character first (needs a name + ≥3 reference views)'
        }
      >
        {pending ? 'Adding to canvas…' : 'Test on canvas →'}
      </button>

      {!canTest && (
        <span className="character-def__hint">
          Add a name and at least 3 reference views, then this enables.
        </span>
      )}
    </section>
  );
}
