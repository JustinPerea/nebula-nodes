import { useEffect, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { X } from 'lucide-react';
import { useGraphStore } from '../../store/graphStore';
import { useUIStore } from '../../store/uiStore';
import { fetchMoodboards } from '../../lib/api';
import { backendAssetUrlSync } from '../../lib/backend';
import { NEW_MOODBOARD_SENTINEL } from '../moodboard-studio/MoodboardStudioView';
import type { Moodboard } from '../../types';
import '../../styles/panels.css';
import '../../styles/moodboard-studio.css';

type Scope = 'global' | 'project';

export const MOODBOARD_DRAG_MIME = 'application/nebula-moodboard';

export function MoodboardLibrary() {
  const enterMoodboardEditor = useUIStore((s) => s.enterMoodboardEditor);
  const togglePanel = useUIStore((s) => s.togglePanel);
  const addMoodboardNode = useGraphStore((s) => s.addMoodboardNode);

  const [scope, setScope] = useState<Scope>('global');
  const [moodboards, setMoodboards] = useState<Moodboard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchMoodboards(scope)
      .then((list) => {
        if (!cancelled) setMoodboards(list);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load Moodboards.');
          setMoodboards([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  const handleAdd = (m: Moodboard) => {
    void addMoodboardNode(
      m.id,
      { x: 460, y: 360 },
      { name: m.name, thumbnail: m.thumbnail, imageCount: m.images.length, mode: m.mode },
    );
  };

  const onDragStart = (event: ReactDragEvent<HTMLButtonElement>, moodboard: Moodboard) => {
    event.dataTransfer.setData(
      MOODBOARD_DRAG_MIME,
      JSON.stringify({
        id: moodboard.id,
        name: moodboard.name,
        thumbnail: moodboard.thumbnail,
        imageCount: moodboard.images.length,
        mode: moodboard.mode,
      }),
    );
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="panel panel--moodboard-library">
      <div className="panel__header">
        <span className="panel__title">Moodboards</span>
        <button
          type="button"
          className="panel__header-action panel__close"
          onClick={() => togglePanel('moodboard')}
          aria-label="Close moodboard library"
          title="Close"
        >
          <X
            className="panel__close-icon"
            size={16}
            strokeWidth={1.75}
            aria-hidden="true"
            focusable="false"
          />
        </button>
      </div>
      <div className="panel__body panel__body--moodboard-library">
        <div className="moodboard-palette__scope" role="tablist" aria-label="Moodboard scope">
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'project'}
            className={scope === 'project' ? 'moodboard-palette__scope-tab moodboard-palette__scope-tab--active' : 'moodboard-palette__scope-tab'}
            onClick={() => setScope('project')}
          >
            Project
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={scope === 'global'}
            className={scope === 'global' ? 'moodboard-palette__scope-tab moodboard-palette__scope-tab--active' : 'moodboard-palette__scope-tab'}
            onClick={() => setScope('global')}
          >
            Global
          </button>
        </div>

        <button
          type="button"
          className="moodboard-palette__new"
          onClick={() => enterMoodboardEditor(NEW_MOODBOARD_SENTINEL)}
        >
          + New Moodboard
        </button>

        <div className="moodboard-palette__list">
          {loading && <div className="moodboard-palette__empty">Loading...</div>}
          {error && !loading && <div className="moodboard-palette__empty moodboard-palette__empty--error">{error}</div>}
          {!loading && !error && moodboards.length === 0 && <div className="moodboard-palette__empty">No Moodboards yet.</div>}
          {moodboards.map((m) => (
            <button
              key={m.id}
              type="button"
              className="moodboard-palette__item"
              draggable
              onDragStart={(event) => onDragStart(event, m)}
              onClick={() => handleAdd(m)}
              onDoubleClick={() => enterMoodboardEditor(m.id)}
              title="Click to add to canvas · double-click to edit"
            >
              <span className="moodboard-palette__thumb">
                {m.thumbnail ? <img src={backendAssetUrlSync(m.thumbnail)} alt="" draggable={false} /> : <span>MB</span>}
              </span>
              <span className="moodboard-palette__meta">
                <span className="moodboard-palette__name">{m.name || 'Untitled'}</span>
                <span className="moodboard-palette__sub">{m.images.length} images · {m.mode}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
