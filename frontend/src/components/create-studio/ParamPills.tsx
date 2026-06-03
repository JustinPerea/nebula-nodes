import type { ModelNodeDefinition } from '../../types';
import { deriveVisibleParams } from '../../lib/createParams';

interface ParamPillsProps {
  def: ModelNodeDefinition;
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function ParamPills({ def, params, onChange }: ParamPillsProps) {
  const visible = deriveVisibleParams(def, params).filter(
    (p) => p.type === 'enum' || p.type === 'integer' || p.type === 'float' || p.type === 'boolean',
  );

  const set = (key: string, value: unknown) => onChange({ ...params, [key]: value });

  return (
    <div className="param-pills">
      {visible.map((p) => {
        if (p.type === 'enum') {
          return (
            <label key={p.key} className="param-pill" title={p.label}>
              <span className="param-pill__label">{p.label}</span>
              <select
                className="param-pill__select"
                value={String(params[p.key] ?? p.default ?? '')}
                onChange={(e) => set(p.key, e.target.value)}
              >
                {(p.options ?? []).map((o) => (
                  <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
                ))}
              </select>
            </label>
          );
        }
        if (p.type === 'boolean') {
          const checked = Boolean(params[p.key] ?? p.default);
          return (
            <button
              key={p.key}
              type="button"
              className={`param-pill param-pill--toggle${checked ? ' param-pill--on' : ''}`}
              onClick={() => set(p.key, !checked)}
            >
              {p.label}: {checked ? 'On' : 'Off'}
            </button>
          );
        }
        // integer / float
        return (
          <label key={p.key} className="param-pill" title={p.label}>
            <span className="param-pill__label">{p.label}</span>
            <input
              className="param-pill__number"
              type="number"
              value={Number(params[p.key] ?? p.default ?? 0)}
              min={p.min}
              max={p.max}
              step={p.step ?? (p.type === 'integer' ? 1 : 0.1)}
              onChange={(e) => {
                const n = p.type === 'integer' ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
                set(p.key, Number.isNaN(n) ? (p.default ?? p.min ?? 0) : n);
              }}
            />
          </label>
        );
      })}
    </div>
  );
}
