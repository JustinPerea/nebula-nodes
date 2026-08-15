import { useCallback, useMemo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { PORT_COLORS } from '../../lib/portCompatibility';
import {
  REFERENCE_ROLES,
  REFERENCE_ROLE_IDS,
  REFERENCE_WEIGHT_DEFAULT,
  REFERENCE_WEIGHT_MIN,
  REFERENCE_WEIGHT_MAX,
  REFERENCE_WEIGHT_STEP,
  clampReferenceWeight,
  type ReferenceRoleId,
} from '../../lib/referenceRoles';
import { useGraphStore } from '../../store/graphStore';
import '../../styles/reference-set-node.css';

// The ReferenceSetNode is the canvas card for the reference-set utility node.
// It renders one role-labeled input slot per semantic reference role (7 total,
// handles colored from referenceRoles.ts), a weight slider per slot, and a
// live ordered preview of the bundle the backend handler will pack: connected
// roles sorted by weight descending. Slider edits write straight back into
// node params via updateNodeData — the same path the Inspector uses — so the
// card and the Inspector never disagree. At execution time
// handlers/reference_set.py packs connected images into the ReferenceSetBundle
// emitted on the `reference_set` ReferenceSet-typed source handle.

interface ReferenceSetNodeData {
  params?: Record<string, unknown>;
}

function readWeight(params: Record<string, unknown>, role: ReferenceRoleId): number {
  const raw = params[`${role}_weight`];
  if (raw === null || raw === undefined || raw === '') return REFERENCE_WEIGHT_DEFAULT;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return REFERENCE_WEIGHT_DEFAULT;
  return clampReferenceWeight(value);
}

function formatWeight(weight: number): string {
  return weight.toFixed(2);
}

export function ReferenceSetNode({ id, data, selected }: NodeProps) {
  const updateNodeData = useGraphStore((s) => s.updateNodeData);
  const edges = useGraphStore((s) => s.edges);
  const params = (data as ReferenceSetNodeData).params ?? {};

  const weights = useMemo(() => {
    const map = {} as Record<ReferenceRoleId, number>;
    for (const role of REFERENCE_ROLE_IDS) map[role] = readWeight(params, role);
    return map;
  }, [params]);

  // Which role ports currently have an incoming connection — the preview
  // mirrors what the backend handler packs (connected ports only).
  const connectedRoles = useMemo(() => {
    const set = new Set<ReferenceRoleId>();
    for (const edge of edges) {
      if (edge.target !== id) continue;
      const handle = edge.targetHandle as ReferenceRoleId | null | undefined;
      if (handle && (REFERENCE_ROLE_IDS as string[]).includes(handle)) set.add(handle);
    }
    return set;
  }, [edges, id]);

  // Live ordered preview: connected roles sorted by weight descending, stable
  // for ties (port declaration order) — the same ordering the handler emits.
  const preview = useMemo(
    () =>
      REFERENCE_ROLE_IDS
        .filter((role) => connectedRoles.has(role))
        .map((role, index) => ({ role, weight: weights[role], index }))
        .sort((a, b) => b.weight - a.weight || a.index - b.index),
    [connectedRoles, weights]
  );

  const handleWeightChange = useCallback(
    (role: ReferenceRoleId) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = Number(e.target.value);
      if (!Number.isFinite(value)) return;
      const current = (data as ReferenceSetNodeData).params ?? {};
      updateNodeData(id, {
        params: { ...current, [`${role}_weight`]: clampReferenceWeight(value) },
      });
    },
    [id, data, updateNodeData]
  );

  return (
    <div className={`reference-set-node ${selected ? 'reference-set-node--selected' : ''}`}>
      <div className="reference-set-node__title">▤ Reference Set</div>

      <div className="reference-set-node__slots">
        {REFERENCE_ROLE_IDS.map((role) => {
          const roleDef = REFERENCE_ROLES[role];
          return (
            <div key={role} className="reference-set-node__slot">
              <Handle
                type="target"
                position={Position.Left}
                id={role}
                className="reference-set-node__handle"
                style={{ backgroundColor: roleDef.color }}
              />
              <span
                className="reference-set-node__role-badge"
                style={{ backgroundColor: roleDef.color }}
                aria-label={`${roleDef.label} role`}
                title={roleDef.description}
              >
                {roleDef.label}
              </span>
              <input
                type="range"
                className="nodrag reference-set-node__weight"
                min={REFERENCE_WEIGHT_MIN}
                max={REFERENCE_WEIGHT_MAX}
                step={REFERENCE_WEIGHT_STEP}
                value={weights[role]}
                onChange={handleWeightChange(role)}
                aria-label={`${roleDef.label} weight`}
              />
              <span className="reference-set-node__weight-value">
                {formatWeight(weights[role])}
              </span>
            </div>
          );
        })}
      </div>

      <div className="reference-set-node__preview">
        {preview.length === 0 ? (
          <div className="reference-set-node__preview-empty">Connect references to pack a set</div>
        ) : (
          preview.map(({ role, weight }) => (
            <div key={role} className="reference-set-node__preview-item">
              <span
                className="reference-set-node__role-badge"
                style={{ backgroundColor: REFERENCE_ROLES[role].color }}
              >
                {REFERENCE_ROLES[role].label}
              </span>
              <span className="reference-set-node__preview-weight">{formatWeight(weight)}</span>
            </div>
          ))
        )}
      </div>

      {/* Single ReferenceSet-typed source handle on the right. */}
      <Handle
        type="source"
        position={Position.Right}
        id="reference_set"
        className="reference-set-node__handle"
        style={{ backgroundColor: PORT_COLORS.ReferenceSet }}
      />
    </div>
  );
}
