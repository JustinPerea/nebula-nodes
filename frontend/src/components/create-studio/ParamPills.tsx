import { useState } from 'react';
import type { ModelNodeDefinition } from '../../types';
import { deriveVisibleParams } from '../../lib/createParams';
import { allParamDefinitions, providerLabel, routeById, routeSwitch, shownRouteId } from '../../lib/directRoute';
import { snapHidden } from '../../lib/providerSwitch';
import { useUIStore } from '../../store/uiStore';
import { ProviderSwitcher } from '../nodes/ProviderSwitcher';

interface ParamPillsProps {
  def: ModelNodeDefinition;
  params: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}

export function ParamPills({ def, params, onChange }: ParamPillsProps) {
  const apiKeys = useUIStore((s) => s.settingsCache.apiKeys);
  const visible = deriveVisibleParams(def, params, apiKeys).filter(
    (p) => p.type === 'enum' || p.type === 'integer' || p.type === 'float' || p.type === 'boolean',
  );

  // A route-table model: the provider pill comes first, and the pills show
  // that provider's options (lib/directRoute.ts routeParamDefinitions).
  const switchable = routeSwitch(def);
  const shown = switchable ? routeById(def, shownRouteId(def, params, apiKeys)) : undefined;
  const [switchNote, setSwitchNote] = useState<{ model: string; text: string } | null>(null);
  const note = switchNote?.model === def.id ? switchNote.text : null;

  // A person's edit: on a route-table model, a setting it now hides on the
  // shown provider at a value another provider would honor goes back to its
  // default, with the note (lib/providerSwitch.ts snapHidden), as in the
  // Inspector.
  const edit = (next: Record<string, unknown>, key: string) => {
    if (!switchable) {
      onChange(next);
      return;
    }
    const snapped = snapHidden(def, next, shownRouteId(def, next, apiKeys), key);
    onChange(snapped.params);
    if (snapped.notes.length) setSwitchNote({ model: def.id, text: snapped.notes.join('. ') });
  };
  const set = (key: string, value: unknown) => edit({ ...params, [key]: value }, key);
  const unset = (key: string) => {
    const next = { ...params };
    delete next[key];
    edit(next, key);
  };

  return (
    <div className="param-pills">
      {switchable && (
        <ProviderSwitcher definition={def} params={params} variant="pill" onPick={(next, notes) => {
          onChange(next);
          setSwitchNote(notes.length ? { model: def.id, text: notes.join('. ') } : null);
        }} />
      )}
      {note && (
        <span className="param-pills__note" role="status">
          {note}
          <button type="button" className="param-pills__note-dismiss" aria-label="Dismiss provider note"
            onClick={() => setSwitchNote(null)}>&times;</button>
        </span>
      )}
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
          const storedLabel = allParamDefinitions(def).find((param) => param.key === p.key)
            ?.options?.find((o) => String(o.value) === value)?.label ?? 'Saved choice';
          const unavailableNote = shown ? `not on ${providerLabel(shown.provider)}` : 'unavailable for selected model';
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
                {unavailableChoice && <option value={value} disabled>{storedLabel} ({unavailableNote})</option>}
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
    </div>
  );
}
