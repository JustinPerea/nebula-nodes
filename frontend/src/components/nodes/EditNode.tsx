import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useUIStore } from '../../store/uiStore';
import { useGraphStore } from '../../store/graphStore';
import { clipSpeed } from '../../lib/editor/virtualPlayback';

interface EditClipShape {
  duration?: number;
  sourceIn?: number;
  sourceOut?: number;
  volume?: number;
  mute?: boolean;
}

export function EditNode({ id, data, selected }: NodeProps) {
  const enterEditor = useUIStore((s) => s.enterEditor);
  const params = ((data as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>;
  const clips = ((params.clips as EditClipShape[]) ?? []);

  // Output duration is the sum of clip.duration (after the refactor, duration
  // IS the output extent for each clip — speed is derived).
  const totalDur = clips.reduce((sum, c) => sum + (c.duration ?? 0), 0);
  const cuts = Math.max(0, clips.length - 1);

  // Derive each clip's speed and badge only when uniformly non-1×.
  const speedValues = Array.from(
    new Set(
      clips.map((c) =>
        clipSpeed({
          id: '',
          start: 0,
          duration: c.duration ?? 0,
          sourceIn: c.sourceIn ?? 0,
          sourceOut: c.sourceOut ?? 0,
          volume: c.volume ?? 1,
          mute: c.mute ?? false,
        }),
      ),
    ),
  );
  const speedBadge =
    speedValues.length === 1 && Math.abs(speedValues[0] - 1) > 0.0001
      ? `${speedValues[0].toFixed(2)}×`
      : null;

  const hasVolumeChange = clips.some((c) => (c.volume ?? 1) !== 1.0 || c.mute);
  const summary = [
    'trim',
    cuts > 0 ? `${cuts} cut${cuts === 1 ? '' : 's'}` : null,
    speedBadge,
    hasVolumeChange ? `${Math.round((clips[0]?.volume ?? 1) * 100)}%` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  function handleOpenEditor() {
    const state = useGraphStore.getState();
    const edge = state.edges.find((e) => e.target === id && e.targetHandle === 'video_in');
    if (edge) enterEditor(edge.source);
  }

  return (
    <div className={`edit-node ${selected ? 'edit-node--selected' : ''}`}>
      <Handle type="target" position={Position.Left} id="video_in" />
      <div className="edit-node__title">✂ Video Edit</div>
      <div className="edit-node__preview">
        <span>{totalDur.toFixed(1)}s · {cuts} cut{cuts === 1 ? '' : 's'}</span>
        {speedBadge && <div className="edit-node__speed-badge">{speedBadge}</div>}
      </div>
      <div className="edit-node__summary">{summary || 'no edits yet'}</div>
      {selected && (
        <button type="button" className="edit-node__open" onClick={handleOpenEditor}>
          Open Editor
        </button>
      )}
      <Handle type="source" position={Position.Right} id="video" />
    </div>
  );
}
