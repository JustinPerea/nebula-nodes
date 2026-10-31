import { useEffect, useMemo, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import { X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { fetchCharacters, fetchMoodboards, moveStoredAsset } from '../../lib/api';
import { fetchPresets, type Preset } from '../../lib/createPresets';
import { backendAssetUrlSync } from '../../lib/backend';
import { storedImageView } from '../../lib/storedImage';
import { OutsideImageNote } from '../OutsideImageNote';
import { CHARACTER_DRAG_MIME, MOODBOARD_DRAG_MIME } from '../../lib/dragMime';
import { NEW_CHARACTER_SENTINEL, NEW_MOODBOARD_SENTINEL } from '../../lib/studioSentinels';
import { findAvailableNodePosition } from '../../lib/nodePlacement';
import type { Character, Moodboard } from '../../types';
import { ScrollFade } from '../ScrollFade';
import { NO_PROJECT_OPEN, useCurrentProject } from '../../lib/currentProject';
import { wsClient } from '../../lib/wsClient';
import { moveChoices } from '../../lib/assetMove';
import { moodboardImagesLabel, setAsideCount } from '../../lib/moodboardCount';
import { AssetMoveMenu } from '../asset-move/AssetMoveMenu';
import { useAssetStudioDraftStore } from '../../store/assetStudioDraftStore';
import { RecentlyDeletedAssets, UndoDeleteToast } from '../asset-trash/AssetTrash';
import { useAssetDelete } from '../../hooks/useAssetDelete';
import '../../styles/panels.css';
import { FailureLines } from '../failure/FailureLines';
import { failureMessage } from '../../lib/errorCopy';
import { useCanvasLock } from '../../lib/canvasLock';
import '../../styles/character-studio.css';
import '../../styles/moodboard-studio.css';
import { NoticeLeave } from '../../lib/noticeLeave';
import { LineText } from '../LineText';

type Scope = 'global' | 'project';
type Tab = 'characters' | 'moodboards' | 'styles';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'characters', label: 'Characters' },
  { id: 'moodboards', label: 'Moodboards' },
  { id: 'styles', label: 'Styles' },
];

/**
 * Unified Assets panel — collapses the former Character, Moodboard, and Style
 * (preset) palettes into one canvas-chrome panel with type tabs, a shared scope
 * toggle, and search.
 *
 * One interaction model for every tab: a click only selects an item (Enter or
 * Space too), and never changes the canvas. Double-click opens it (a Studio,
 * or Create with a Style); the selected item's buttons do the same, and
 * "Add to canvas" (or dragging the item) puts a Character or Moodboard node
 * on the canvas through the existing add*Node paths + drag MIMEs. "Move"
 * files a Character or Moodboard under Global or the open project
 * (contract 07, 1.10). Styles have no Studio, so their Delete is here: it
 * moves the Style to Recently deleted with an Undo toast, and Recently
 * deleted lists under the Styles, as in the Studios (Q53 a, 2026-10-20).
 */
export function AssetsPanel() {
  const togglePanel = useUIStore((s) => s.togglePanel);
  const enterCharacterEditor = useUIStore((s) => s.enterCharacterEditor);
  const enterMoodboardEditor = useUIStore((s) => s.enterMoodboardEditor);
  const enterCreateView = useUIStore((s) => s.enterCreateView);
  const setPendingPreset = useUIStore((s) => s.setPendingPreset);
  const addCharacterNode = useGraphStore((s) => s.addCharacterNode);
  const addMoodboardNode = useGraphStore((s) => s.addMoodboardNode);
  const { screenToFlowPosition } = useReactFlow();

  const [tab, setTab] = useState<Tab>('characters');
  const [scope, setScope] = useState<Scope>('global');
  const [query, setQuery] = useState('');
  // The selected item, as "<tab>:<id>", so it belongs to one tab.
  const [selected, setSelected] = useState<string | null>(null);

  // The Project tab is the canvas project open now (lib/currentProject):
  // switching projects lists the new one's assets.
  const project = useCurrentProject();
  const projectId = scope === 'project' ? project?.id ?? null : null;
  const noProject = scope === 'project' && !projectId;
  // Each list remembers the tab, scope and project it was fetched for, so a
  // list from before a switch is never shown under the new one.
  const listKey = `${scope}:${projectId ?? ''}`;
  const [characterList, setCharacters] = useState<{ for: string; items: Character[] }>({ for: '', items: [] });
  const [moodboardList, setMoodboards] = useState<{ for: string; items: Moodboard[] }>({ for: '', items: [] });
  const [presetList, setPresets] = useState<{ for: string; items: Preset[] }>({ for: '', items: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relistKey, setRelistKey] = useState(0);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);

  // A board or Character saved or deleted elsewhere (the Studio, an agent,
  // the CLI) shows up without reopening the panel.
  useEffect(() => wsClient.subscribe((event) => {
    // socketReconnected: changes made while the socket was down aren't replayed.
    if (event.type === 'storedAssetChanged' || event.type === 'socketReconnected') setRelistKey((value) => value + 1);
  }), []);

  useEffect(() => {
    // No project open: nothing to fetch; the list says to open one.
    if (noProject) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading gate before async fetch; not derived state, does not cascade
    setLoading(true);
    setError(null);
    // A list that arrives after the tab, scope or project changed is dropped:
    // shown under the new one, its items would open with the wrong scope.
    const id = projectId ?? undefined;
    const load = async () => {
      if (tab === 'characters') {
        const list = await fetchCharacters(scope, id);
        if (!cancelled) setCharacters({ for: listKey, items: list });
      } else if (tab === 'moodboards') {
        const list = await fetchMoodboards(scope, id);
        if (!cancelled) setMoodboards({ for: listKey, items: list });
      } else {
        const list = await fetchPresets(scope, id);
        if (!cancelled) setPresets({ for: listKey, items: list });
      }
    };
    load()
      .catch((err) => {
        // Each list's request names itself ("Couldn't load the boards. <reason>").
        if (!cancelled) setError(failureMessage(err, "Couldn't load your assets."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, scope, projectId, noProject, listKey, relistKey]);

  const characters = useMemo(() => (characterList.for === listKey && !noProject ? characterList.items : []),
    [characterList, listKey, noProject]);
  const moodboards = useMemo(() => (moodboardList.for === listKey && !noProject ? moodboardList.items : []),
    [moodboardList, listKey, noProject]);
  const presets = useMemo(() => (presetList.for === listKey && !noProject ? presetList.items : []),
    [presetList, listKey, noProject]);
  // "Loading" only until this tab's list arrives; a refresh keeps it showing.
  const shownFor = { characters: characterList.for, moodboards: moodboardList.for, styles: presetList.for }[tab];
  const busy = !noProject && loading && shownFor !== listKey;
  const failed = noProject ? null : error;
  const q = query.trim().toLowerCase();
  const filteredCharacters = useMemo(
    () => characters.filter((c) => !q || (c.name || '').toLowerCase().includes(q)),
    [characters, q]
  );
  const filteredMoodboards = useMemo(
    () => moodboards.filter((m) => !q || (m.name || '').toLowerCase().includes(q)),
    [moodboards, q]
  );
  const filteredPresets = useMemo(
    () => presets.filter((p) => !q || `${p.name} ${p.category}`.toLowerCase().includes(q)),
    [presets, q]
  );

  // Where "Add to canvas" puts a node: the middle of the view, clear of other nodes.
  const canvasCenter = () => findAvailableNodePosition(
    screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
    useGraphStore.getState().nodes.map((node) => node.position),
  );

  const onDragCharacter = (e: ReactDragEvent<HTMLButtonElement>, c: Character) => {
    e.dataTransfer.setData(CHARACTER_DRAG_MIME, JSON.stringify({ id: c.id, name: c.name, thumbnail: c.thumbnail }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDragMoodboard = (e: ReactDragEvent<HTMLButtonElement>, m: Moodboard) => {
    e.dataTransfer.setData(
      MOODBOARD_DRAG_MIME,
      JSON.stringify({ id: m.id, name: m.name, thumbnail: m.thumbnail, imageCount: m.images.length,
        setAsideCount: setAsideCount(m.images), mode: m.mode })
    );
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleNew = () => {
    if (noProject) return;
    if (tab === 'characters') enterCharacterEditor(NEW_CHARACTER_SENTINEL, scope);
    else if (tab === 'moodboards') enterMoodboardEditor(NEW_MOODBOARD_SENTINEL, scope);
  };

  // Move to Global / Move to <open project>. A Studio draft kept for it this
  // session follows (rehome), so its next save goes to the new home.
  const moveAsset = async (kind: 'moodboard' | 'character', id: string, target: string | null) => {
    setMovingId(id);
    setMoveError(null);
    try {
      const result = await moveStoredAsset(kind, id, target);
      useAssetStudioDraftStore.getState().rehome(kind, id, result.to);
      setRelistKey((value) => value + 1);
    } catch (err) {
      setMoveError(failureMessage(err, kind === 'moodboard' ? "Couldn't move the board." : "Couldn't move the character."));
    }
    setMovingId(null);
  };

  // Delete a Style: it goes to Recently deleted, and Undo brings it back.
  const deleting = useAssetDelete('style');
  const deleteStyle = async (p: Preset) => {
    const removed = await deleting.remove({ id: p.id, name: p.name, scope });
    if (removed) setSelected(null);
    setRelistKey((value) => value + 1);
  };
  const relist = () => setRelistKey((value) => value + 1);

  const applyStyle = (p: Preset) => {
    // Hand the preset to Create (consumed on mount) and switch surfaces.
    setPendingPreset(p);
    enterCreateView();
  };

  return (
    <div className="panel panel--assets workspace-dock-panel">
      <div className="panel__header">
        <span className="panel__title">Assets</span>
        <button
          type="button"
          className="panel__header-action panel__close"
          onClick={() => togglePanel('assets')}
          aria-label="Close assets panel"
          title="Close"
        >
          <X className="panel__close-icon" size={16} strokeWidth={1.75} aria-hidden="true" focusable="false" />
        </button>
      </div>

      <ScrollFade className="panel__body panel__body--assets">
        <div className="assets-panel__tabs" role="tablist" aria-label="Asset type">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`assets-panel__tab${tab === t.id ? ' assets-panel__tab--active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="character-palette__scope" role="tablist" aria-label="Asset scope">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'project'}
            className={`character-palette__scope-tab ${scope === 'project' ? 'character-palette__scope-tab--active' : ''}`}
            title={project ? `Assets in ${project.name}` : NO_PROJECT_OPEN}
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

        <input
          className="assets-panel__search"
          value={query}
          placeholder={`Search ${tab}…`}
          onChange={(e) => setQuery(e.target.value)}
        />

        {tab !== 'styles' && (
          <button type="button" className="character-palette__new" onClick={handleNew} disabled={noProject}
            title={noProject ? NO_PROJECT_OPEN : undefined}>
            + New {tab === 'characters' ? 'Character' : 'Moodboard'}
          </button>
        )}

        <ScrollFade className="character-palette__list">
          {noProject && (
            <div className="character-palette__empty">
              Open a project to see its {TABS.find((t) => t.id === tab)?.label ?? 'assets'}.
            </div>
          )}
          {busy && <div className="character-palette__empty">Loading…</div>}
          {failed && !busy && (
            <div className="character-palette__empty character-palette__empty--error"><LineText text={failed} /></div>
          )}
          {moveError && (
            <div className="character-palette__empty character-palette__empty--error" role="alert"><LineText text={moveError} /></div>
          )}
          {tab === 'styles' && deleting.deleteError && (
            <div className="character-palette__empty character-palette__empty--error" role="alert"><FailureLines failure={deleting.deleteError} /></div>
          )}

          {!noProject && !busy && !failed && tab === 'characters' && (
            filteredCharacters.length === 0 ? (
              <div className="character-palette__empty">No Characters{q ? ' match' : ' yet'}.</div>
            ) : (
              filteredCharacters.map((c) => (
                <AssetItem
                  key={c.id}
                  name={c.name}
                  sub={`${c.referenceViews.length} views`}
                  thumbnail={c.thumbnail}
                  localOnly
                  emptyThumb="◐"
                  selected={selected === `characters:${c.id}`}
                  onSelect={() => setSelected(`characters:${c.id}`)}
                  onDragStart={(e) => onDragCharacter(e, c)}
                  onOpen={() => enterCharacterEditor(c.id, scope)}
                  openLabel="Open"
                  onAdd={() => addCharacterNode(c.id, canvasCenter(), { name: c.name, thumbnail: c.thumbnail })}
                  move={<AssetMoveMenu noun="Character" buttonClassName="assets-item__action"
                    choices={moveChoices(c.projectId, project)} busy={movingId === c.id}
                    onChoose={(choice) => { void moveAsset('character', c.id, choice.target); }} />}
                />
              ))
            )
          )}

          {!noProject && !busy && !failed && tab === 'moodboards' && (
            filteredMoodboards.length === 0 ? (
              <div className="character-palette__empty">No Moodboards{q ? ' match' : ' yet'}.</div>
            ) : (
              filteredMoodboards.map((m) => (
                <AssetItem
                  key={m.id}
                  name={m.name}
                  sub={`${moodboardImagesLabel(m.images.length, setAsideCount(m.images))} · ${m.mode}`}
                  thumbnail={m.thumbnail}
                  localOnly
                  emptyThumb="▦"
                  selected={selected === `moodboards:${m.id}`}
                  onSelect={() => setSelected(`moodboards:${m.id}`)}
                  onDragStart={(e) => onDragMoodboard(e, m)}
                  onOpen={() => enterMoodboardEditor(m.id, scope)}
                  openLabel="Open"
                  onAdd={() => addMoodboardNode(m.id, canvasCenter(),
                    { name: m.name, thumbnail: m.thumbnail, imageCount: m.images.length,
                      setAsideCount: setAsideCount(m.images), mode: m.mode })}
                  move={<AssetMoveMenu noun="board" buttonClassName="assets-item__action"
                    choices={moveChoices(m.projectId, project)} busy={movingId === m.id}
                    onChoose={(choice) => { void moveAsset('moodboard', m.id, choice.target); }} />}
                />
              ))
            )
          )}

          {!noProject && !busy && !failed && tab === 'styles' && (
            filteredPresets.length === 0 ? (
              <div className="character-palette__empty">No Styles{q ? ' match' : ' yet'}.</div>
            ) : (
              filteredPresets.map((p) => (
                <AssetItem
                  key={p.id}
                  name={p.name}
                  sub={p.category}
                  thumbnail={p.thumbnail}
                  localOnly
                  emptyThumb="✦"
                  selected={selected === `styles:${p.id}`}
                  onSelect={() => setSelected(`styles:${p.id}`)}
                  onOpen={() => applyStyle(p)}
                  openLabel="Use in Create"
                  onDelete={() => { void deleteStyle(p); }}
                  deleteBusy={deleting.busy}
                />
              ))
            )
          )}
          {!noProject && tab === 'styles' && (
            <RecentlyDeletedAssets kind="style" scope={scope} refreshKey={deleting.refreshKey}
              onRestored={relist} onTrashChanged={relist} />
          )}
        </ScrollFade>
      </ScrollFade>
      {/* The toast draws in the app's notice region (UndoDeleteToast), never in the panel. */}
      <NoticeLeave value={deleting.lastDeleted}>{(last, leave) => (
        <UndoDeleteToast key={last.id} name={last.name} busy={deleting.busy}
          error={deleting.undoError} onDismiss={deleting.dismiss}
          onUndo={() => { void deleting.undo().then((asset) => { if (asset) relist(); }); }} leave={leave} />
      )}</NoticeLeave>
    </div>
  );
}

/**
 * One asset in the list. A click (or Enter / Space) selects it and shows its
 * buttons; double-click opens it. Only "Add to canvas" and dragging add a node.
 */
function AssetItem({
  name,
  sub,
  thumbnail,
  localOnly = false,
  emptyThumb,
  selected,
  onSelect,
  onOpen,
  openLabel,
  onAdd,
  onDragStart,
  move,
  onDelete,
  deleteBusy = false,
}: {
  name: string;
  sub: ReactNode;
  thumbnail?: string;
  /** A Style's or Character's thumbnail: loaded only when it is one of
   *  Nebula's own files (lib/storedImage.ts). */
  localOnly?: boolean;
  emptyThumb: string;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  openLabel: string;
  onAdd?: () => void;
  onDragStart?: (e: ReactDragEvent<HTMLButtonElement>) => void;
  /** The Move menu (Characters and Moodboards). */
  move?: ReactNode;
  /** Styles: move it to Recently deleted (an Undo toast follows). */
  onDelete?: () => void;
  deleteBusy?: boolean;
}) {
  const label = name || 'Untitled';
  // Round 23 (review 22, L-3): Add to canvas and dragging onto it add a node,
  // so they take the canvas lock. Open, Move and Delete act on the asset
  // library, not the canvas.
  const lock = useCanvasLock();
  const stored = localOnly ? storedImageView(thumbnail) : null;
  const src = stored ? stored.src : thumbnail ? backendAssetUrlSync(thumbnail) : null;
  return (
    <div className={`assets-item${selected ? ' assets-item--selected' : ''}`}>
      <button
        type="button"
        className="character-palette__item assets-item__select"
        aria-pressed={selected}
        draggable={Boolean(onDragStart) && !lock.locked}
        onDragStart={onDragStart}
        onClick={onSelect}
        onDoubleClick={onOpen}
        title={onAdd ? 'Double-click to open · drag onto the canvas to add' : 'Double-click to use in Create'}
      >
        <span className="character-palette__thumb">
          {src ? (
            <img src={src} alt="" draggable={false} />
          ) : (
            <span className="character-palette__thumb-empty" aria-hidden="true">{emptyThumb}</span>
          )}
        </span>
        <span className="character-palette__meta">
          <span className="character-palette__name">{label}</span>
          <span className="character-palette__sub">{sub}</span>
          {stored?.outside && <OutsideImageNote />}
        </span>
      </button>
      {selected && (
        <div className="assets-item__actions">
          <button type="button" className="assets-item__action" onClick={onOpen} aria-label={`${openLabel} ${label}`}>
            {openLabel}
          </button>
          {onAdd && (
            <button type="button" className="assets-item__action" onClick={onAdd} {...lock.act()} aria-label={`Add ${label} to canvas`}>
              Add to canvas
            </button>
          )}
          {move}
          {onDelete && (
            <button type="button" className="assets-item__action assets-item__action--delete" onClick={onDelete} disabled={deleteBusy}
              title="Move to Recently deleted" aria-label={`Delete ${label}`}>
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
