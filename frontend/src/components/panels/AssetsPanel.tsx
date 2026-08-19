import { useEffect, useMemo, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { X } from 'lucide-react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { fetchCharacters, fetchMoodboards } from '../../lib/api';
import { fetchPresets, type Preset } from '../../lib/createPresets';
import { backendAssetUrlSync } from '../../lib/backend';
import { CHARACTER_DRAG_MIME, MOODBOARD_DRAG_MIME } from '../../lib/dragMime';
import { NEW_CHARACTER_SENTINEL, NEW_MOODBOARD_SENTINEL } from '../../lib/studioSentinels';
import type { Character, Moodboard } from '../../types';
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
 * toggle, and search. Characters/Moodboards drag or click onto the canvas
 * (reusing the existing add*Node paths + drag MIMEs); Styles open Create with the
 * preset applied. Double-click opens the relevant Studio editor.
 */
export function AssetsPanel() {
  const togglePanel = useUIStore((s) => s.togglePanel);
  const enterCharacterEditor = useUIStore((s) => s.enterCharacterEditor);
  const enterMoodboardEditor = useUIStore((s) => s.enterMoodboardEditor);
  const enterCreateView = useUIStore((s) => s.enterCreateView);
  const setPendingPreset = useUIStore((s) => s.setPendingPreset);
  const addCharacterNode = useGraphStore((s) => s.addCharacterNode);
  const addMoodboardNode = useGraphStore((s) => s.addMoodboardNode);

  const [tab, setTab] = useState<Tab>('characters');
  const [scope, setScope] = useState<Scope>('global');
  const [query, setQuery] = useState('');

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
    const load = async () => {
      if (tab === 'characters') setCharacters(await fetchCharacters(scope));
      else if (tab === 'moodboards') setMoodboards(await fetchMoodboards(scope));
      else setPresets(await fetchPresets(scope));
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
    <div className="panel panel--assets">
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

      <div className="panel__body panel__body--assets">
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

        <div className="character-palette__list">
          {loading && <div className="character-palette__empty">Loading…</div>}
          {error && !loading && (
            <div className="character-palette__empty character-palette__empty--error">{error}</div>
          )}

          {!loading && !error && tab === 'characters' && (
            filteredCharacters.length === 0 ? (
              <div className="character-palette__empty">No Characters{q ? ' match' : ' yet'}.</div>
            ) : (
              filteredCharacters.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className="character-palette__item"
                  draggable
                  onDragStart={(e) => onDragCharacter(e, c)}
                  onClick={() => addCharacterNode(c.id, { x: 400, y: 300 }, { name: c.name, thumbnail: c.thumbnail })}
                  onDoubleClick={() => enterCharacterEditor(c.id, scope)}
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
              ))
            )
          )}

          {!loading && !error && tab === 'moodboards' && (
            filteredMoodboards.length === 0 ? (
              <div className="character-palette__empty">No Moodboards{q ? ' match' : ' yet'}.</div>
            ) : (
              filteredMoodboards.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="character-palette__item"
                  draggable
                  onDragStart={(e) => onDragMoodboard(e, m)}
                  onClick={() => addMoodboardNode(m.id, { x: 460, y: 360 }, { name: m.name, thumbnail: m.thumbnail, imageCount: m.images.length, mode: m.mode })}
                  onDoubleClick={() => enterMoodboardEditor(m.id, scope)}
                  title="Click to add to canvas · double-click to edit"
                >
                  <span className="character-palette__thumb">
                    {m.thumbnail ? <img src={backendAssetUrlSync(m.thumbnail)} alt="" draggable={false} /> : <span className="character-palette__thumb-empty">▦</span>}
                  </span>
                  <span className="character-palette__meta">
                    <span className="character-palette__name">{m.name || 'Untitled'}</span>
                    <span className="character-palette__sub">{m.images.length} images · {m.mode}</span>
                  </span>
                </button>
              ))
            )
          )}

          {!loading && !error && tab === 'styles' && (
            filteredPresets.length === 0 ? (
              <div className="character-palette__empty">No Styles{q ? ' match' : ' yet'}.</div>
            ) : (
              filteredPresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className="character-palette__item"
                  onClick={() => applyStyle(p)}
                  title="Click to use this style in Create"
                >
                  <span className="character-palette__thumb">
                    {p.thumbnail ? <img src={backendAssetUrlSync(p.thumbnail)} alt="" draggable={false} /> : <span className="character-palette__thumb-empty">✦</span>}
                  </span>
                  <span className="character-palette__meta">
                    <span className="character-palette__name">{p.name || 'Untitled'}</span>
                    <span className="character-palette__sub">{p.category}</span>
                  </span>
                </button>
              ))
            )
          )}
        </div>
      </div>
    </div>
  );
}
