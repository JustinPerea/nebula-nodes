import { useMemo, useState } from 'react';
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

  const groups = useMemo(() => {
    if (query.trim()) {
      return [{ label: 'Results', models: searchModels(query) }];
    }
    const featured = getFeaturedModels();
    const featuredIds = new Set(featured.map((m) => m.id));
    const rest = getCreateModels().filter((m) => !featuredIds.has(m.id));
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
  }, [query]);

  return (
    <div className="model-picker" role="dialog" aria-label="Choose a model">
      <div className="model-picker__search">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          type="text"
          autoFocus
          placeholder="Search models…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
      </div>
      <div className="model-picker__list">
        {groups.map((group) => (
          <div key={group.label} className="model-picker__group">
            <div className="model-picker__group-label">{group.label}</div>
            {group.models.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`model-picker__row${value === m.id ? ' model-picker__row--active' : ''}`}
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
