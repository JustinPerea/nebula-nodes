import { useEffect, useMemo, useState } from 'react';
import type { DragEvent as ReactDragEvent, ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import { X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { fetchCharacters, fetchMoodboards } from '../../lib/api';
import { fetchPresets, type Preset } from '../../lib/createPresets';
import { backendAssetUrlSync } from '../../lib/backend';
import { CHARACTER_DRAG_MIME, MOODBOARD_DRAG_MIME } from '../../lib/dragMime';
import { NEW_CHARACTER_SENTINEL, NEW_MOODBOARD_SENTINEL } from '../../lib/studioSentinels';
import { findAvailableNodePosition } from '../../lib/nodePlacement';
import type { Character, Moodboard } from '../../types';
import { ScrollFade } from '../ScrollFade';
import '../../styles/panels.css';
import '../../styles/character-studio.css';
import '../../styles/moodboard-studio.css';

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
 * on the canvas through the existing add*Node paths + drag MIMEs.
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

  const [characters, setCharacters] = useState<Character[]>([]);
  const [moodboards, setMoodboards] = useState<Moodboard[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading gate before async fetch; not derived state, does not cascade
    setLoading(true);
    setError(null);
    // A list that arrives after the tab or scope changed is dropped: shown
    // under the new tab, its items would open with the wrong scope.
    const load = async () => {
      if (tab === 'characters') {
        const list = await fetchCharacters(scope);
        if (!cancelled) setCharacters(list);
      } else if (tab === 'moodboards') {
        const list = await fetchMoodboards(scope);
        if (!cancelled) setMoodboards(list);
      } else {
        const list = await fetchPresets(scope);
        if (!cancelled) setPresets(list);
      }
    };
    load()
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load assets.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, scope]);

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
      JSON.stringify({ id: m.id, name: m.name, thumbnail: m.thumbnail, imageCount: m.images.length, mode: m.mode })
    );
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleNew = () => {
    if (tab === 'characters') enterCharacterEditor(NEW_CHARACTER_SENTINEL, scope);
    else if (tab === 'moodboards') enterMoodboardEditor(NEW_MOODBOARD_SENTINEL, scope);
  };

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
          <button type="button" className="character-palette__new" onClick={handleNew}>
            + New {tab === 'characters' ? 'Character' : 'Moodboard'}
          </button>
        )}

        <ScrollFade className="character-palette__list">
          {loading && <div className="character-palette__empty">Loading…</div>}
          {error && !loading && (
            <div className="character-palette__empty character-palette__empty--error">{error}</div>
          )}

          {!loading && !error && tab === 'characters' && (
            filteredCharacters.length === 0 ? (
              <div className="character-palette__empty">No Characters{q ? ' match' : ' yet'}.</div>
            ) : (
              filteredCharacters.map((c) => (
                <AssetItem
                  key={c.id}
                  name={c.name}
                  sub={`${c.referenceViews.length} views`}
                  thumbnail={c.thumbnail}
                  emptyThumb="◐"
                  selected={selected === `characters:${c.id}`}
                  onSelect={() => setSelected(`characters:${c.id}`)}
                  onDragStart={(e) => onDragCharacter(e, c)}
                  onOpen={() => enterCharacterEditor(c.id, scope)}
                  openLabel="Open"
                  onAdd={() => addCharacterNode(c.id, canvasCenter(), { name: c.name, thumbnail: c.thumbnail })}
                />
              ))
            )
          )}

          {!loading && !error && tab === 'moodboards' && (
            filteredMoodboards.length === 0 ? (
              <div className="character-palette__empty">No Moodboards{q ? ' match' : ' yet'}.</div>
            ) : (
              filteredMoodboards.map((m) => (
                <AssetItem
                  key={m.id}
                  name={m.name}
                  sub={`${m.images.length} images · ${m.mode}`}
                  thumbnail={m.thumbnail}
                  emptyThumb="▦"
                  selected={selected === `moodboards:${m.id}`}
                  onSelect={() => setSelected(`moodboards:${m.id}`)}
                  onDragStart={(e) => onDragMoodboard(e, m)}
                  onOpen={() => enterMoodboardEditor(m.id, scope)}
                  openLabel="Open"
                  onAdd={() => addMoodboardNode(m.id, canvasCenter(),
                    { name: m.name, thumbnail: m.thumbnail, imageCount: m.images.length, mode: m.mode })}
                />
              ))
            )
          )}

          {!loading && !error && tab === 'styles' && (
            filteredPresets.length === 0 ? (
              <div className="character-palette__empty">No Styles{q ? ' match' : ' yet'}.</div>
            ) : (
              filteredPresets.map((p) => (
                <AssetItem
                  key={p.id}
                  name={p.name}
                  sub={p.category}
                  thumbnail={p.thumbnail}
                  emptyThumb="✦"
                  selected={selected === `styles:${p.id}`}
                  onSelect={() => setSelected(`styles:${p.id}`)}
                  onOpen={() => applyStyle(p)}
                  openLabel="Use in Create"
                />
              ))
            )
          )}
        </ScrollFade>
      </ScrollFade>
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
  emptyThumb,
  selected,
  onSelect,
  onOpen,
  openLabel,
  onAdd,
  onDragStart,
}: {
  name: string;
  sub: ReactNode;
  thumbnail?: string;
  emptyThumb: string;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
  openLabel: string;
  onAdd?: () => void;
  onDragStart?: (e: ReactDragEvent<HTMLButtonElement>) => void;
}) {
  const label = name || 'Untitled';
  return (
    <div className={`assets-item${selected ? ' assets-item--selected' : ''}`}>
      <button
        type="button"
        className="character-palette__item assets-item__select"
        aria-pressed={selected}
        draggable={Boolean(onDragStart)}
        onDragStart={onDragStart}
        onClick={onSelect}
        onDoubleClick={onOpen}
        title={onAdd ? 'Double-click to open · drag onto the canvas to add' : 'Double-click to use in Create'}
      >
        <span className="character-palette__thumb">
          {thumbnail ? (
            <img src={backendAssetUrlSync(thumbnail)} alt="" draggable={false} />
          ) : (
            <span className="character-palette__thumb-empty" aria-hidden="true">{emptyThumb}</span>
          )}
        </span>
        <span className="character-palette__meta">
          <span className="character-palette__name">{label}</span>
          <span className="character-palette__sub">{sub}</span>
        </span>
      </button>
      {selected && (
        <div className="assets-item__actions">
          <button type="button" className="assets-item__action" onClick={onOpen} aria-label={`${openLabel} ${label}`}>
            {openLabel}
          </button>
          {onAdd && (
            <button type="button" className="assets-item__action" onClick={onAdd} aria-label={`Add ${label} to canvas`}>
              Add to canvas
            </button>
          )}
        </div>
      )}
    </div>
  );
}
