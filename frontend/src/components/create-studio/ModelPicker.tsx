import { useMemo, useState, useEffect } from 'react';
import { Search, Check } from 'lucide-react';
import type { ModelNodeDefinition } from '../../types';
import { getCreateModels, getFeaturedModels, searchModels } from '../../lib/createModels';

interface ModelPickerProps {
  value: string | null;
  onSelect: (definitionId: string) => void;
  onClose: () => void;
}

export function ModelPicker({ value, onSelect, onClose }: ModelPickerProps) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const providers = useMemo(() => [...new Set(getCreateModels().map((model) => String(model.apiProvider)))].sort(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const groups = useMemo(() => {
    const matchesProvider = (model: ModelNodeDefinition) => !provider || model.apiProvider === provider;
    if (query.trim()) {
      return [{ label: 'Results', models: searchModels(query).filter(matchesProvider) }];
    }
    const featured = getFeaturedModels().filter(matchesProvider);
    const featuredIds = new Set(featured.map((m) => m.id));
    const rest = getCreateModels().filter((m) => matchesProvider(m) && !featuredIds.has(m.id));
    const byCategory = new Map<string, ModelNodeDefinition[]>();
    for (const m of rest) {
      const arr = byCategory.get(m.category) ?? [];
      arr.push(m);
      byCategory.set(m.category, arr);
    }
    return [
      { label: 'Featured', models: featured },
      ...Array.from(byCategory.entries()).map(([label, models]) => ({ label, models })),
    ];
  }, [query, provider]);

  return (
    <div className="model-picker" role="dialog" aria-label="Choose a model">
      <div className="model-picker__search">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          type="text"
          autoFocus
          placeholder="Search models…"
          aria-label="Search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
      </div>
      <label className="model-picker__provider">
        Provider
        <select aria-label="Model provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
          <option value="">All providers</option>
          {providers.map((item) => <option key={item} value={item}>{item === 'krea' ? 'Krea' : item}</option>)}
        </select>
      </label>
      <div className="model-picker__list">
        {groups.every((group) => group.models.length === 0) && <div className="model-picker__empty" role="status">No models match this search and provider.</div>}
        {groups.filter((group) => group.models.length > 0).map((group) => (
          <div key={group.label} className="model-picker__group">
            <div className="model-picker__group-label">{group.label}</div>
            {group.models.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`model-picker__row${value === m.id ? ' model-picker__row--active' : ''}`}
                aria-label={`${m.displayName}, ${m.category}, ${m.apiProvider}`}
                aria-pressed={value === m.id}
                onClick={() => {
                  onSelect(m.id);
                  onClose();
                }}
              >
                <span className="model-picker__row-name">{m.displayName}</span>
                <span className="model-picker__row-meta">{m.category} · {String(m.apiProvider)}</span>
                {value === m.id && <Check size={15} strokeWidth={2} className="model-picker__row-check" />}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
