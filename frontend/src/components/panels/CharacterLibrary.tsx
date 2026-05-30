import { useEffect, useState } from 'react';
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
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
 *  fresh draft in the Studio.
 *
 *  Interaction model (see the dual-handler race fixed here): clicking a row is
 *  the PRIMARY action and opens the Character Studio — one synchronous
 *  enterCharacterEditor() flip, no async backend round-trip, no single/double
 *  click ambiguity. Adding the asset to the canvas is EXPLICIT: either the
 *  in-row "+ Add" button (stops propagation so it never also opens the Studio)
 *  or the existing drag (CHARACTER_DRAG_MIME). The row is a real role="button"
 *  div so the nested add <button> is valid HTML and keyboard a11y is preserved
 *  (Enter/Space open the Studio).
 *
 *  projectId note: the frontend has no current-project concept yet, so the
 *  toggle defaults to 'global'; 'project' is best-effort (usually empty in v1). */
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

  /** Explicit add-to-canvas. Stop propagation so the click does NOT also bubble
   *  to the row's open-in-Studio handler. */
  const handleAddClick = (e: ReactMouseEvent, c: Character) => {
    e.stopPropagation();
    handleAdd(c);
  };

  /** Keyboard a11y for the role="button" row: Enter/Space open the Studio. */
  const handleRowKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, c: Character) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      enterCharacterEditor(c.id);
    }
  };

  const onDragStart = (e: ReactDragEvent<HTMLDivElement>, c: Character) => {
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
            // Row is a role="button" div (not a real <button>) so the nested
            // "+ Add" <button> is valid HTML. Single-click / Enter / Space opens
            // the Studio — one synchronous enterCharacterEditor() flip, no
            // async add-node race, no single/double-click ambiguity.
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              className="character-palette__item"
              draggable
              onDragStart={(e) => onDragStart(e, c)}
              onClick={() => enterCharacterEditor(c.id)}
              onKeyDown={(e) => handleRowKeyDown(e, c)}
              title="Click to open in Studio · use Add or drag to place on canvas"
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

              {/* Explicit add-to-canvas. stopPropagation (in handleAddClick) so
                  it never also triggers the row's open-in-Studio handler. */}
              <button
                type="button"
                className="character-palette__add"
                onClick={(e) => handleAddClick(e, c)}
                title={`Add ${c.name || 'Untitled'} to canvas`}
                aria-label={`Add ${c.name || 'Untitled'} to canvas`}
              >
                + Add
              </button>

              {/* Branch-out fan. Hidden until row :hover / :focus-within.
                  Each thumb gets a --fan-i index for the staggered cascade.
                  aria-hidden because it is a redundant visual preview of the
                  same referenceViews; the "N views" label conveys the count. */}
              {c.referenceViews.length > 0 && (
                <span className="character-palette__fan" aria-hidden="true">
                  {c.referenceViews.map((url, i) => (
                    <span
                      key={`${url}-${i}`}
                      className="character-palette__fan-thumb"
                      // --fan-i is a geometry/data value (the stagger index), not
                      // a static visual prop, so it is allowed by the inline-style
                      // guard which only forbids VISUAL_PROPS. Cast keeps TS happy.
                      style={{ ['--fan-i' as string]: i } as CSSProperties}
                    >
                      <img src={backendAssetUrlSync(url)} alt="" draggable={false} />
                    </span>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
