import { useCallback, useEffect, useState } from 'react';
import { fetchCharacters } from '../../lib/api';
import { storedImageView } from '../../lib/storedImage';
import { OutsideImageNote } from '../OutsideImageNote';
import type { Character } from '../../types';
import type { AssetScope } from '../../store/uiStore';
import { RecentlyDeletedAssets } from '../asset-trash/AssetTrash';
import { emptyRailMessage, railNotice, type AssetHome } from '../../lib/assetHome';
import { NO_PROJECT_OPEN } from '../../lib/currentProject';
import { wsClient } from '../../lib/wsClient';

interface CharacterLibraryRailProps {
  /** Currently-open Character id (or the 'new' sentinel for a fresh draft). */
  activeId: string | null;
  initialScope: AssetScope;
  /** Where the open saved Character lives; null for a new draft. */
  characterHome?: AssetHome | null;
  /** The canvas project open now (null: none), whose Characters the Project tab lists. */
  projectId: string | null;
  /** Changes after a delete or undo, so the list loads again. */
  refreshKey?: unknown;
  onSelect: (id: string, scope: AssetScope) => void;
  onNew: (scope: AssetScope) => void;
}

/** Left rail inside the Studio: a list of saved Characters with a project ⇄
 *  global toggle and a "+ New" button. Mirrors CinemaShotsRail's role (a
 *  vertical pick-list) but loads from /api/characters rather than node state.
 *
 *  The Project tab lists the open canvas project's Characters (lib/currentProject);
 *  initialScope is where the open Character lives, so the rail opens on its tab. */
export function CharacterLibraryRail({
  activeId,
  initialScope,
  characterHome = null,
  projectId,
  refreshKey,
  onSelect,
  onNew,
}: CharacterLibraryRailProps) {
  const [scope, setScope] = useState<AssetScope>(initialScope);
  // Bumped when Recently deleted changes (a delete or restore elsewhere), to list again.
  const [relistKey, setRelistKey] = useState(0);
  const relist = useCallback(() => setRelistKey((value) => value + 1), []);
  // The list with the tab and project it was fetched for, so a list from
  // before a project switch is never shown as this project's.
  const [listing, setListing] = useState<{ for: string; items: Character[] }>({ for: '', items: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reload on scope change AND whenever the active id changes — selecting/
  // creating/leaving a Character should refresh the list so a just-saved draft
  // appears here without a manual refresh.
  // A Character saved or deleted elsewhere (an agent, the CLI) shows up here too.
  useEffect(() => wsClient.subscribe((event) => {
    if ((event.type === 'storedAssetChanged' && event.kind === 'character') || event.type === 'socketReconnected') relist();
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
    fetchCharacters(scope, scope === 'project' ? projectId ?? undefined : undefined)
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
  const notice = railNotice('character', characterHome);
  const characters = noProject || listing.for !== listKey ? [] : listing.items;
  const busy = !noProject && loading;
  const failed = noProject ? null : error;

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

      <button type="button" className="character-rail__new" disabled={noProject}
        title={noProject ? NO_PROJECT_OPEN : undefined} onClick={() => onNew(scope)}>
        + New Character
      </button>

      <div className="character-rail__list">
        {notice && <div className="character-rail__empty character-rail__empty--notice" role="status">{notice}</div>}
        {busy && <div className="character-rail__empty">Loading…</div>}
        {failed && !busy && (
          <div className="character-rail__empty character-rail__empty--error">{failed}</div>
        )}
        {!busy && !failed && characters.length === 0 && (
          <div className="character-rail__empty">
            {emptyRailMessage('character', scope, characterHome, !noProject)}
          </div>
        )}
        {characters.map((c) => {
          // Only Nebula's own files are loaded (lib/storedImage.ts).
          const thumb = storedImageView(c.thumbnail);
          return (
            <button
              key={c.id}
              type="button"
              className={`character-rail__item ${c.id === activeId ? 'character-rail__item--active' : ''}`}
              onClick={() => onSelect(c.id, scope)}
            >
              <span className="character-rail__thumb">
                {thumb.src ? (
                  <img src={thumb.src} alt="" draggable={false} />
                ) : (
                  <span className="character-rail__thumb-empty">◐</span>
                )}
              </span>
              <span className="character-rail__meta">
                <span className="character-rail__name">{c.name || 'Untitled'}</span>
                <span className="character-rail__sub">{c.referenceViews.length} views</span>
                {thumb.outside && <OutsideImageNote />}
              </span>
            </button>
          );
        })}
      </div>
      <RecentlyDeletedAssets kind="character" scope={scope} refreshKey={`${String(refreshKey)}:${activeId}`}
        onRestored={(item) => onSelect(item.id, scope)} onTrashChanged={relist} />
    </div>
  );
}
