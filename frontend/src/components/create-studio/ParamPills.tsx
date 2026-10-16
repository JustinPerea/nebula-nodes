import { useState } from 'react';
import type { ModelNodeDefinition } from '../../types';
import { deriveVisibleParams, resolveCreateParamDefinitions } from '../../lib/createParams';
import { snapParamDefaults, type DefaultSnapNote } from '../../lib/paramDefaults';
import { useUIStore } from '../../store/uiStore';

interface ParamPillsProps {
  def: ModelNodeDefinition;
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

interface SnapNotes {
  def: ModelNodeDefinition;
  params: Record<string, unknown>;
  notes: DefaultSnapNote[];
}

function sameValues(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.is(a[k], b[k]));
}

export function ParamPills({ def, params, onChange }: ParamPillsProps) {
  const apiKeys = useUIStore((s) => s.settingsCache.apiKeys);
  const visible = deriveVisibleParams(def, params, apiKeys).filter(
    (p) => p.type === 'enum' || p.type === 'integer' || p.type === 'float' || p.type === 'boolean',
  );

  // What the last model change did to a per-model default (Max Tokens),
  // shown under the pills until the next edit (lib/paramDefaults.ts). A note
  // belongs to the definition and values it was made for: switching to another
  // node or applying a preset swaps them from outside, and the note goes.
  const [snapNotes, setSnapNotes] = useState<SnapNotes>({ def, params, notes: [] });
  const notes = snapNotes.def === def && sameValues(snapNotes.params, params) ? snapNotes.notes : [];
  const set = (key: string, value: unknown) => {
    const snap = snapParamDefaults(def, params, { ...params, [key]: value });
    setSnapNotes({ def, params: snap.params, notes: snap.notes });
    onChange(snap.params);
  };
  const unset = (key: string) => {
    const next = { ...params };
    delete next[key];
    setSnapNotes({ def, params: next, notes: [] });
    onChange(next);
  };

  return (
    <div className="param-pills">
      {visible.map((p) => {
        const optionalWithoutDefault = !p.required && p.default == null;
        if (p.disabledReason) {
          return (
            <label key={p.key} className="param-pill" title={p.disabledReason}>
              <span className="param-pill__label">{p.label} · unavailable</span>
              <input className="param-pill__number" type="number" aria-label={p.label}
                aria-description={p.disabledReason} value={Number(params[p.key] ?? p.default ?? 0)} disabled />
            </label>
          );
        }
        if (p.type === 'enum') {
          const hasEmptyOption = p.options?.some((o) => o.value === '');
          const value = String(params[p.key] ?? p.default ?? '');
          const unavailableChoice = value !== '' && !p.options?.some((o) => String(o.value) === value);
          const storedLabel = resolveCreateParamDefinitions(def, apiKeys, params).find((param) => param.key === p.key)
            ?.options?.find((o) => String(o.value) === value)?.label ?? 'Saved choice';
          return (
            <label key={p.key} className="param-pill" title={p.label}>
              <span className="param-pill__label">{p.label}</span>
              <select
                className="param-pill__select"
                value={value}
                onChange={(e) => {
                  const option = p.options?.find((o) => String(o.value) === e.target.value);
                  if (optionalWithoutDefault && e.target.value === '' && !option) {
                    unset(p.key);
                    return;
                  }
                  set(p.key, option?.value ?? e.target.value);
                }}
              >
                {unavailableChoice && <option value={value} disabled>{storedLabel} (unavailable for selected model)</option>}
                {p.default == null && !hasEmptyOption && <option value="">{p.required ? 'Choose…' : 'Default'}</option>}
                {(p.options ?? []).map((o) => (
                  <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
                ))}
              </select>
            </label>
          );
        }
        if (p.type === 'boolean') {
          if (optionalWithoutDefault) {
            const raw = params[p.key];
            const current = typeof raw === 'boolean' ? raw : undefined;
            return (
              <button
                key={p.key}
                type="button"
                className={`param-pill param-pill--toggle${current === true ? ' param-pill--on' : ''}`}
                aria-pressed={current === undefined ? 'mixed' : current}
                onClick={() => {
                  if (current === false) unset(p.key);
                  else set(p.key, current === undefined);
                }}
              >
                {p.label}: {current === undefined ? 'Default' : current ? 'On' : 'Off'}
              </button>
            );
          }
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
              value={p.default == null && (params[p.key] == null || params[p.key] === '')
                ? ''
                : Number(params[p.key] ?? p.default ?? 0)}
              min={p.min}
              max={p.max}
              step={p.step ?? (p.type === 'integer' ? 1 : 0.1)}
              onChange={(e) => {
                if (p.default == null && e.target.value === '') {
                  if (p.required) set(p.key, '');
                  else unset(p.key);
                  return;
                }
                const n = p.type === 'integer' ? parseInt(e.target.value, 10) : parseFloat(e.target.value);
                set(p.key, Number.isNaN(n) ? (p.default ?? p.min ?? 0) : n);
              }}
            />
          </label>
        );
      })}
      {notes.map((note) => (
        <p key={note.text} className="param-pills__note" role="note" data-param-default-note={note.param}>{note.text}</p>
      ))}
    </div>
  );
}
