import { useState } from 'react';
import { backendAssetUrlSync } from '../../lib/backend';
import type { CinemaSceneSpec, CinemaShot } from '../../types';

interface CinemaShotsRailProps {
  scene: CinemaSceneSpec;
  selectedShotId: string | null;
  onSelect: (shotId: string) => void;
  onAddShot: () => void;
  onRemoveShot: (shotId: string) => void;
  /** Persist a reordered shots array (drag-reorder). */
  onReorder: (shots: CinemaShot[]) => void;
}

function statusBadge(shot: CinemaShot): { label: string; cls: string } | null {
  const status = shot.output?.status;
  if (!status || status === 'idle') return null;
  if (status === 'running') return { label: '●', cls: 'cinema-shots-rail__badge--running' };
  if (status === 'done') return { label: '✓', cls: 'cinema-shots-rail__badge--done' };
  return { label: '⚠', cls: 'cinema-shots-rail__badge--error' };
}

export function CinemaShotsRail({
  scene,
  selectedShotId,
  onSelect,
  onAddShot,
  onRemoveShot,
  onReorder,
}: CinemaShotsRailProps) {
  const [dragId, setDragId] = useState<string | null>(null);

  const handleDrop = (targetId: string) => {
    if (!dragId || dragId === targetId) {
      setDragId(null);
      return;
    }
    const shots = [...scene.shots];
    const from = shots.findIndex((s) => s.id === dragId);
    const to = shots.findIndex((s) => s.id === targetId);
    if (from < 0 || to < 0) {
      setDragId(null);
      return;
    }
    const [moved] = shots.splice(from, 1);
    shots.splice(to, 0, moved);
    onReorder(shots);
    setDragId(null);
  };

  return (
    <div className="cinema-shots-rail">
      {scene.shots.map((shot, idx) => {
        const badge = statusBadge(shot);
        const thumb = shot.output?.imageUrl ?? null;
        return (
          <div
            key={shot.id}
            className={`cinema-shots-rail__shot ${shot.id === selectedShotId ? 'cinema-shots-rail__shot--selected' : ''} ${dragId === shot.id ? 'cinema-shots-rail__shot--dragging' : ''}`}
            draggable
            onDragStart={() => setDragId(shot.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => handleDrop(shot.id)}
            onClick={() => onSelect(shot.id)}
            role="button"
            tabIndex={0}
          >
            <div className="cinema-shots-rail__thumb">
              {thumb ? (
                <img src={backendAssetUrlSync(thumb)} alt="" draggable={false} />
              ) : (
                <div className="cinema-shots-rail__thumb-empty">{idx + 1}</div>
              )}
              {badge && <span className={`cinema-shots-rail__badge ${badge.cls}`}>{badge.label}</span>}
            </div>
            <div className="cinema-shots-rail__caption">
              <span className="cinema-shots-rail__num">Shot {idx + 1}</span>
              <button
                type="button"
                className="cinema-shots-rail__remove"
                title="Remove shot"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveShot(shot.id);
                }}
              >
                ×
              </button>
            </div>
          </div>
        );
      })}
      <button type="button" className="cinema-shots-rail__add" onClick={onAddShot}>
        + Add shot
      </button>
    </div>
  );
}
