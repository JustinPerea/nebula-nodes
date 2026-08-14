import { useCallback } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NODE_DEFINITIONS } from '../../constants/nodeDefinitions';
import { PORT_COLORS } from '../../lib/portCompatibility';
import { useGraphStore } from '../../store/graphStore';
import type { CameraRigBundle } from '../../types';
import '../../styles/camera-rig-node.css';

// The CameraRigNode is the canvas card for the camera-rig utility node. It
// renders entirely from the React Flow node `data.params` it already receives
// (no network): nine numeric sliders plus a live SVG diagram (side view +
// frame inset) so camera geometry is inspectable at a glance. Slider edits
// write straight back into node params via updateNodeData — the same path the
// Inspector uses — so the card and the Inspector never disagree. At execution
// time handlers/camera_rig.py packs these params into the CameraRigBundle
// emitted on the `camera_rig` CameraRig-typed source handle.

type RigField = keyof CameraRigBundle;

// Fallbacks mirror backend/data/node_definitions.json so the card still renders
// sensibly if the definition is somehow unavailable.
const DEFAULTS: CameraRigBundle = {
  height: 1.7,
  pitch: 0,
  yaw: 0,
  roll: 0,
  focalLength: 35,
  subjectDistance: 3,
  focusDistance: 3,
  subjectScreenX: 0.5,
  subjectScreenY: 0.5,
};

const FIELD_ORDER: RigField[] = [
  'height',
  'pitch',
  'yaw',
  'roll',
  'focalLength',
  'subjectDistance',
  'focusDistance',
  'subjectScreenX',
  'subjectScreenY',
];

// Compact labels for the card's slider grid; the Inspector shows the full
// labels from the node definition.
const SHORT_LABELS: Record<RigField, string> = {
  height: 'Height m',
  pitch: 'Pitch °',
  yaw: 'Yaw °',
  roll: 'Roll °',
  focalLength: 'Focal mm',
  subjectDistance: 'Subj m',
  focusDistance: 'Focus m',
  subjectScreenX: 'Scr X',
  subjectScreenY: 'Scr Y',
};

const FIELD_RANGES: Record<RigField, { min: number; max: number; step: number }> = {
  height: { min: 0.1, max: 10, step: 0.1 },
  pitch: { min: -90, max: 90, step: 1 },
  yaw: { min: 0, max: 360, step: 1 },
  roll: { min: -45, max: 45, step: 1 },
  focalLength: { min: 10, max: 200, step: 1 },
  subjectDistance: { min: 0.5, max: 50, step: 0.1 },
  focusDistance: { min: 0.5, max: 100, step: 0.1 },
  subjectScreenX: { min: 0, max: 1, step: 0.01 },
  subjectScreenY: { min: 0, max: 1, step: 0.01 },
};

interface CameraRigNodeData {
  params?: Record<string, unknown>;
}

function readRig(params: Record<string, unknown>): CameraRigBundle {
  const rig = { ...DEFAULTS };
  for (const key of FIELD_ORDER) {
    const raw = params[key];
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(value)) rig[key] = value;
  }
  return rig;
}

function formatValue(field: RigField, value: number): string {
  const { step } = FIELD_RANGES[field];
  if (step >= 1) return String(Math.round(value));
  return value.toFixed(step < 0.05 ? 2 : 1);
}

/** Side-view diagram: camera at `height` on the left, subject on the ground at
 *  `subjectDistance`, view direction tilted by `pitch`, frustum wedge sized by
 *  `focalLength`. Scale adapts so the subject always fits the view. */
function SideView({ rig }: { rig: CameraRigBundle }) {
  const W = 220;
  const H = 104;
  const groundY = 90;
  const camX = 22;
  const maxDist = Math.max(rig.subjectDistance, 4);
  const scale = (W - 40) / maxDist; // px per meter, fit subject with margin
  const subjectX = camX + rig.subjectDistance * scale;
  const camY = groundY - Math.min(rig.height * scale, groundY - 12);

  const pitchRad = (rig.pitch * Math.PI) / 180;
  // SVG y grows downward: positive pitch (looking up) must decrease y.
  const dirX = Math.cos(pitchRad);
  const dirY = -Math.sin(pitchRad);
  const viewLen = 66;
  const viewX = camX + dirX * viewLen;
  const viewY = camY + dirY * viewLen;

  // Frustum half-angle from a 24mm-tall sensor: atan(12 / focalLength).
  const halfAngle = Math.atan(12 / Math.max(rig.focalLength, 1));
  const frustumLen = Math.min((subjectX - camX) * 1.15 + 18, W - camX - 4);
  const fringe = (sign: 1 | -1) => {
    const a = -pitchRad + sign * halfAngle;
    return {
      x: camX + Math.cos(a) * frustumLen,
      y: camY + Math.sin(a) * frustumLen,
    };
  };
  const top = fringe(-1);
  const bottom = fringe(1);

  // Subject: head + body, ~1.7m tall, capped to the view.
  const subjectH = Math.min(1.7 * scale, 34);
  const headR = Math.min(0.22 * scale, 5);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="camera-rig-node__svg" aria-hidden="true">
      {/* ground */}
      <line x1={4} y1={groundY} x2={W - 4} y2={groundY} className="camera-rig-node__ground" />
      {/* frustum wedge */}
      <polygon
        points={`${camX},${camY} ${top.x},${top.y} ${bottom.x},${bottom.y}`}
        className="camera-rig-node__frustum"
      />
      {/* subject axis (camera → subject, dashed) */}
      <line x1={camX} y1={camY} x2={subjectX} y2={groundY - subjectH} className="camera-rig-node__axis" />
      {/* view direction (pitch) */}
      <line x1={camX} y1={camY} x2={viewX} y2={viewY} className="camera-rig-node__view" />
      {/* subject figure */}
      <line
        x1={subjectX}
        y1={groundY}
        x2={subjectX}
        y2={groundY - subjectH}
        className="camera-rig-node__subject"
      />
      <circle cx={subjectX} cy={groundY - subjectH - headR} r={headR} className="camera-rig-node__subject" />
      {/* camera body */}
      <rect x={camX - 7} y={camY - 5} width={14} height={10} rx={2} className="camera-rig-node__camera" />
      <line x1={camX} y1={camY + 5} x2={camX} y2={groundY} className="camera-rig-node__tripod" />
    </svg>
  );
}

/** Frame inset: what the camera sees. Crosshair marks the subject's normalized
 *  screen position; the whole frame rotates with `roll`. */
function FrameView({ rig }: { rig: CameraRigBundle }) {
  const W = 96;
  const H = 54;
  const cx = rig.subjectScreenX * W;
  const cy = rig.subjectScreenY * H;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="camera-rig-node__svg" aria-hidden="true">
      <g transform={`rotate(${rig.roll} ${W / 2} ${H / 2})`}>
        <rect x={1} y={1} width={W - 2} height={H - 2} rx={2} className="camera-rig-node__frame" />
        {/* thirds guides */}
        <line x1={W / 3} y1={1} x2={W / 3} y2={H - 1} className="camera-rig-node__guide" />
        <line x1={(2 * W) / 3} y1={1} x2={(2 * W) / 3} y2={H - 1} className="camera-rig-node__guide" />
        <line x1={1} y1={H / 3} x2={W - 1} y2={H / 3} className="camera-rig-node__guide" />
        <line x1={1} y1={(2 * H) / 3} x2={W - 1} y2={(2 * H) / 3} className="camera-rig-node__guide" />
        {/* subject marker */}
        <circle cx={cx} cy={cy} r={5} className="camera-rig-node__reticle" />
        <line x1={cx - 9} y1={cy} x2={cx + 9} y2={cy} className="camera-rig-node__reticle" />
        <line x1={cx} y1={cy - 9} x2={cx} y2={cy + 9} className="camera-rig-node__reticle" />
      </g>
    </svg>
  );
}

export function CameraRigNode({ id, data, selected }: NodeProps) {
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const params = (data as CameraRigNodeData).params ?? {};
  const rig = readRig(params);

  // Prefer the definition's declared min/max/step (source of truth); fall back
  // to the local copy so the card never renders a broken slider.
  const definition = NODE_DEFINITIONS['camera-rig'];
  const rangeFor = (field: RigField) => {
    const def = definition?.params.find((p) => p.key === field);
    const fallback = FIELD_RANGES[field];
    return {
      min: typeof def?.min === 'number' ? def.min : fallback.min,
      max: typeof def?.max === 'number' ? def.max : fallback.max,
      step: typeof def?.step === 'number' ? def.step : fallback.step,
    };
  };

  const handleChange = useCallback(
    (field: RigField) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value);
      if (!Number.isFinite(value)) return;
      const current = (data as CameraRigNodeData).params ?? {};
      updateNodeData(id, { params: { ...current, [field]: value } });
    },
    [id, data, updateNodeData]
  );

  return (
    <div className={`camera-rig-node ${selected ? 'camera-rig-node--selected' : ''}`}>
      <div className="camera-rig-node__title">◈ Camera Rig</div>

      <div className="camera-rig-node__diagram">
        <SideView rig={rig} />
        <FrameView rig={rig} />
      </div>

      <div className="camera-rig-node__sliders">
        {FIELD_ORDER.map((field) => {
          const { min, max, step } = rangeFor(field);
          return (
            <label key={field} className="camera-rig-node__slider">
              <span className="camera-rig-node__slider-label">
                {SHORT_LABELS[field]}
                <span className="camera-rig-node__slider-value">{formatValue(field, rig[field])}</span>
              </span>
              <input
                type="range"
                className="nodrag"
                min={min}
                max={max}
                step={step}
                value={rig[field]}
                onChange={handleChange(field)}
              />
            </label>
          );
        })}
      </div>

      {/* Single CameraRig-typed source handle on the right. */}
      <Handle
        type="source"
        position={Position.Right}
        id="camera_rig"
        className="camera-rig-node__handle"
        style={{ backgroundColor: PORT_COLORS.CameraRig }}
      />
    </div>
  );
}
