import { useEffect, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { fetchCharacters } from '../../lib/api';
import { backendAssetUrlSync } from '../../lib/backend';
import { NEW_CHARACTER_SENTINEL } from '../character-studio/CharacterStudioView';
import type { Character } from '../../types';
import '../../styles/panels.css';
import '../../styles/character-studio.css';

type Scope = 'global' | 'project';

/** Drag MIME the Canvas reads to drop a Character node at the pointer. Distinct
 *  from NodeLibrary's 'application/nebula-node' so the canvas can route it
 *  through addCharacterNode (with the character id) rather than addNode. */
export const CHARACTER_DRAG_MIME = 'application/nebula-character';

/** Character palette — a sibling of NodeLibrary mounted as canvas chrome.
 *  Lists saved Characters (project ⇄ global toggle), "New Character" opens a
 *  fresh draft in the Studio, and clicking/dragging an item drops a `character`
 *  node referencing that asset onto the canvas via graphStore.addCharacterNode.
 *
 *  projectId note: the frontend has no current-project concept yet, so the
 *  toggle defaults to 'global'; 'project' is best-effort (usually empty in v1).
 *
 *  Drag emits CHARACTER_DRAG_MIME (id) for a future canvas drop handler; the
 *  always-reachable path today is click → add at a default position. */
export function CharacterLibrary() {
  const enterCharacterEditor = useUIStore((s) => s.enterCharacterEditor);
  const addCharacterNode = useGraphStore((s) => s.addCharacterNode);

  const [scope, setScope] = useState<Scope>('global');
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchCharacters(scope)
      .then((list) => {
        if (!cancelled) setCharacters(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load Characters.');
          setCharacters([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const handleNew = () => {
    enterCharacterEditor(NEW_CHARACTER_SENTINEL);
  };

  const handleAdd = (c: Character) => {
    void addCharacterNode(
      c.id,
      { x: 400, y: 300 },
      { name: c.name, thumbnail: c.thumbnail },
    );
  };

  const onDragStart = (e: ReactDragEvent<HTMLButtonElement>, c: Character) => {
    // Carry the denormalized name/thumbnail (not just the id) so Canvas.onDrop
    // can hand them to addCharacterNode for immediate canvas rendering —
    // consistent with the meta passed by click-to-add (handleAdd).
    e.dataTransfer.setData(
      CHARACTER_DRAG_MIME,
      JSON.stringify({ id: c.id, name: c.name, thumbnail: c.thumbnail }),
    );
    e.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="panel panel--character-library">
      <div className="panel__header">
        <span className="panel__title">Characters</span>
      </div>

      <div className="panel__body panel__body--character-library">
        <div
          className="character-palette__scope"
          role="tablist"
          aria-label="Character scope"
        >
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'project'}
            className={`character-palette__scope-tab ${scope === 'project' ? 'character-palette__scope-tab--active' : ''}`}
            onClick={() => setScope('project')}
          >
            Project
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'global'}
            className={`character-palette__scope-tab ${scope === 'global' ? 'character-palette__scope-tab--active' : ''}`}
            onClick={() => setScope('global')}
          >
            Global
          </button>
        </div>

        <button type="button" className="character-palette__new" onClick={handleNew}>
          + New Character
        </button>

        <div className="character-palette__list">
          {loading && <div className="character-palette__empty">Loading…</div>}
          {error && !loading && (
            <div className="character-palette__empty character-palette__empty--error">
              {error}
            </div>
          )}
          {!loading && !error && characters.length === 0 && (
            <div className="character-palette__empty">
              {scope === 'project'
                ? 'No project Characters yet.'
                : 'No Characters yet — create one.'}
            </div>
          )}
          {characters.map((c) => (
            <button
              key={c.id}
              type="button"
              className="character-palette__item"
              draggable
              onDragStart={(e) => onDragStart(e, c)}
              onClick={() => handleAdd(c)}
              onDoubleClick={() => enterCharacterEditor(c.id)}
              title="Click to add to canvas · double-click to edit"
            >
              <span className="character-palette__thumb">
                {c.thumbnail ? (
                  <img src={backendAssetUrlSync(c.thumbnail)} alt="" draggable={false} />
                ) : (
                  <span className="character-palette__thumb-empty">◐</span>
                )}
              </span>
              <span className="character-palette__meta">
                <span className="character-palette__name">{c.name || 'Untitled'}</span>
                <span className="character-palette__sub">{c.referenceViews.length} views</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
