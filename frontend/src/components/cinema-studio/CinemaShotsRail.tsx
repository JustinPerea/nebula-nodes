import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { backendAssetUrlSync } from '../../lib/backend';
import { useGraphStore } from '../../store/graphStore';
import type { CinemaSceneSpec, CinemaShot } from '../../types';

interface CinemaShotsRailProps {
  cinemaNodeId: string;
  scene: CinemaSceneSpec;
  selectedShotId: string | null;
  onSelect: (shotId: string) => void;
  onAddShot: () => void;
  onRemoveShot: (shotId: string) => void;
  /** Persist the order only; the host applies IDs to current shot objects. */
  onReorder: (shots: CinemaShot[]) => void;
}

function statusBadge(shot: CinemaShot): { label: string; cls: string; description: string } | null {
  const status = shot.output?.status;
  if (!status || status === 'idle') return null;
  if (status === 'running') return { label: '●', cls: 'cinema-shots-rail__badge--running', description: 'Generating' };
  if (status === 'done') return { label: '✓', cls: 'cinema-shots-rail__badge--done', description: 'Complete' };
  return { label: '⚠', cls: 'cinema-shots-rail__badge--error', description: 'Failed' };
}

export function CinemaShotsRail({
  cinemaNodeId,
  scene,
  selectedShotId,
  onSelect,
  onAddShot,
  onRemoveShot,
  onReorder,
}: CinemaShotsRailProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const selectorRefs = useRef(new Map<string, HTMLButtonElement>());
  const addRef = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{ shotId: string | null; removedId?: string } | null>(null);
  const activeRuns = useGraphStore((state) => state.activeRuns);
  const tabStopId = scene.shots.some((shot) => shot.id === selectedShotId)
    ? selectedShotId : scene.shots[0]?.id;
  const orderedShotIds = JSON.stringify(scene.shots.map((shot) => shot.id));

  useEffect(() => {
    if (!selectedShotId) return;
    selectorRefs.current.get(selectedShotId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedShotId, orderedShotIds]);

  useLayoutEffect(() => {
    const request = pendingFocus.current;
    if (!request) return;
    // Do not move focus away from the remove button until its shot is gone.
    if (request.removedId && scene.shots.some((shot) => shot.id === request.removedId)) return;
    pendingFocus.current = null;
    if (request.shotId && selectorRefs.current.has(request.shotId)) {
      selectorRefs.current.get(request.shotId)?.focus();
    } else {
      addRef.current?.focus();
    }
  }, [scene.shots]);

  const reorder = (shotId: string, targetIndex: number, focusSelector: boolean) => {
    const shots = [...scene.shots];
    const from = shots.findIndex((shot) => shot.id === shotId);
    if (from < 0 || targetIndex < 0 || targetIndex >= shots.length || from === targetIndex) return;
    const [moved] = shots.splice(from, 1);
    shots.splice(targetIndex, 0, moved);
    if (focusSelector) pendingFocus.current = { shotId };
    onReorder(shots);
  };

  const handleDrop = (targetId: string) => {
    if (dragId && dragId !== targetId) {
      reorder(dragId, scene.shots.findIndex((shot) => shot.id === targetId), false);
    }
    setDragId(null);
  };

  const selectAndFocus = (index: number) => {
    const shot = scene.shots[index];
    if (!shot) return;
    onSelect(shot.id);
    selectorRefs.current.get(shot.id)?.focus();
  };

  const handleSelectorKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const earlier = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    const later = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (earlier || later)) {
      event.preventDefault();
      reorder(scene.shots[index].id, index + (earlier ? -1 : 1), true);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (earlier || later || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? scene.shots.length - 1
        : Math.min(Math.max(index + (earlier ? -1 : 1), 0), scene.shots.length - 1);
      selectAndFocus(target);
    }
    // Enter and Space retain the native button's activation behavior.
  };

  const handleRemove = (shotId: string, index: number) => {
    const neighbor = scene.shots[index + 1] ?? scene.shots[index - 1];
    pendingFocus.current = { shotId: neighbor?.id ?? null, removedId: shotId };
    onRemoveShot(shotId);
  };

  return (
    <div className="cinema-shots-rail" role="group" aria-label="Shots">
      {scene.shots.map((shot, idx) => {
        const selected = shot.id === selectedShotId;
        const owner = activeRuns.find((run) => run.nodeIds.includes(cinemaNodeId)
          && (run.kind === 'graph' || run.shotId === shot.id));
        const badge = owner ? {
          label: '●', cls: 'cinema-shots-rail__badge--running',
          description: owner.status === 'cancelling' ? 'Stopping' : 'Generating',
        } : statusBadge(shot);
        const thumb = shot.output?.imageUrl ?? null;
        return (
          <div
            key={shot.id}
            className={`cinema-shots-rail__shot ${selected ? 'cinema-shots-rail__shot--selected' : ''} ${dragId === shot.id ? 'cinema-shots-rail__shot--dragging' : ''}`}
            draggable
            onDragStart={() => setDragId(shot.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => handleDrop(shot.id)}
          >
            <button
              ref={(element) => {
                if (element) selectorRefs.current.set(shot.id, element);
                else selectorRefs.current.delete(shot.id);
              }}
              type="button"
              className="cinema-shots-rail__select"
              aria-label={`Select Shot ${idx + 1}`}
              aria-pressed={selected}
              tabIndex={shot.id === tabStopId ? 0 : -1}
              title="Select shot. Arrow keys change shots; Alt + arrow keys reorder."
              onClick={() => onSelect(shot.id)}
              onKeyDown={(event) => handleSelectorKeyDown(event, idx)}
            >
              <span className="cinema-shots-rail__thumb">
                {thumb ? (
                  <img src={backendAssetUrlSync(thumb)} alt="" draggable={false} />
                ) : (
                  <span className="cinema-shots-rail__thumb-empty">{idx + 1}</span>
                )}
                {badge && <span role="status" aria-label={`${badge.description} Shot ${idx + 1}`}
                  className={`cinema-shots-rail__badge ${badge.cls}`}>{badge.label}</span>}
              </span>
              <span className="cinema-shots-rail__caption">
                <span className="cinema-shots-rail__num">Shot {idx + 1}</span>
              </span>
            </button>
            <div className="cinema-shots-rail__actions">
              {selected && <>
                <button type="button" className="cinema-shots-rail__move"
                  aria-label={`Move Shot ${idx + 1} earlier`} title="Move shot earlier"
                  disabled={idx === 0} onClick={() => reorder(shot.id, idx - 1, true)}>←</button>
                <button type="button" className="cinema-shots-rail__move"
                  aria-label={`Move Shot ${idx + 1} later`} title="Move shot later"
                  disabled={idx === scene.shots.length - 1} onClick={() => reorder(shot.id, idx + 1, true)}>→</button>
              </>}
              <button type="button" className="cinema-shots-rail__remove"
                aria-label={`Remove Shot ${idx + 1}`} title="Remove shot"
                onClick={() => handleRemove(shot.id, idx)}>×</button>
            </div>
          </div>
        );
      })}
      <button ref={addRef} type="button" className="cinema-shots-rail__add" onClick={onAddShot}>
        + Add shot
      </button>
    </div>
  );
}
