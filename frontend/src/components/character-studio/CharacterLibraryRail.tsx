import { useEffect, useState } from 'react';
import { fetchCharacters } from '../../lib/api';
import { backendAssetUrlSync } from '../../lib/backend';
import type { Character } from '../../types';
import type { AssetScope } from '../../store/uiStore';

interface CharacterLibraryRailProps {
  /** Currently-open Character id (or the 'new' sentinel for a fresh draft). */
  activeId: string | null;
  initialScope: AssetScope;
  onSelect: (id: string, scope: AssetScope) => void;
  onNew: (scope: AssetScope) => void;
}

/** Left rail inside the Studio: a list of saved Characters with a project ⇄
 *  global toggle and a "+ New" button. Mirrors CinemaShotsRail's role (a
 *  vertical pick-list) but loads from /api/characters rather than node state.
 *
 *  Project scope resolves through the backend-owned current-project identity;
 *  initialScope keeps the rail truthful when a project asset or draft opens. */
export function CharacterLibraryRail({
  activeId,
  initialScope,
  onSelect,
  onNew,
}: CharacterLibraryRailProps) {
  const [scope, setScope] = useState<AssetScope>(initialScope);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reload on scope change AND whenever the active id changes — selecting/
  // creating/leaving a Character should refresh the list so a just-saved draft
  // appears here without a manual refresh.
  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading gate before async fetch; not derived state, does not cascade
    setLoading(true);
    setError(null);
    fetchCharacters(scope)
      .then((list) => {
        if (!cancelled) setCharacters(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load.');
          setCharacters([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, activeId]);

  return (
    <div className="character-rail">
      <div className="character-rail__scope" role="tablist" aria-label="Character scope">
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'project'}
          className={`character-rail__scope-tab ${scope === 'project' ? 'character-rail__scope-tab--active' : ''}`}
          onClick={() => setScope('project')}
        >
          Project
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={scope === 'global'}
          className={`character-rail__scope-tab ${scope === 'global' ? 'character-rail__scope-tab--active' : ''}`}
          onClick={() => setScope('global')}
        >
          Global
        </button>
      </div>

      <button type="button" className="character-rail__new" onClick={() => onNew(scope)}>
        + New Character
      </button>

      <div className="character-rail__list">
        {loading && <div className="character-rail__empty">Loading…</div>}
        {error && !loading && (
          <div className="character-rail__empty character-rail__empty--error">{error}</div>
        )}
        {!loading && !error && characters.length === 0 && (
          <div className="character-rail__empty">
            {scope === 'project'
              ? 'No project Characters yet.'
              : 'No Characters yet. Create one →'}
          </div>
        )}
        {characters.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`character-rail__item ${c.id === activeId ? 'character-rail__item--active' : ''}`}
            onClick={() => onSelect(c.id, scope)}
          >
            <span className="character-rail__thumb">
              {c.thumbnail ? (
                <img src={backendAssetUrlSync(c.thumbnail)} alt="" draggable={false} />
              ) : (
                <span className="character-rail__thumb-empty">◐</span>
              )}
            </span>
            <span className="character-rail__meta">
              <span className="character-rail__name">{c.name || 'Untitled'}</span>
              <span className="character-rail__sub">{c.referenceViews.length} views</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
