import { useMemo, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Search, Check } from 'lucide-react';
import type { ModelNodeDefinition } from '../../types';
import { getCreateModels, getFeaturedModels, searchModels } from '../../lib/createModels';
import { usePanelFocus } from '../../hooks/usePanelFocus';
import { CATEGORY_LABELS, providerLabel, modelInputSummary, supportedModelProviders, matchesModelProvider } from '../../lib/modelDiscovery';
import { ProviderReadinessBadge } from '../ProviderReadinessBadge';

interface ModelPickerProps {
  value: string | null;
  onSelect: (definitionId: string) => void;
  onClose: () => void;
  selectedParams?: Record<string, unknown>;
}

export function ModelPicker({ value, onSelect, onClose, selectedParams }: ModelPickerProps) {
  const [query, setQuery] = useState('');
  const [provider, setProvider] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const providers = useMemo(() => [...new Set(getCreateModels().flatMap(supportedModelProviders))]
    .sort((left, right) => providerLabel(left).localeCompare(providerLabel(right))), []);
  usePanelFocus(true, panelRef, onClose, { initialFocus: 'input', trap: true });

  const groups = useMemo(() => {
    const matchesProvider = (model: ModelNodeDefinition) => matchesModelProvider(model, provider);
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

  return createPortal(
    <div className="model-picker-overlay" onMouseDown={onClose}>
    <div ref={panelRef} className="model-picker" role="dialog" aria-modal="true" aria-label="Choose a model"
      tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
      <div className="model-picker__search">
        <Search size={15} strokeWidth={1.75} aria-hidden="true" />
        <input
          type="text"
          placeholder="Search models…"
          aria-label="Search models"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <label className="model-picker__provider">
        Provider
        <select aria-label="Model provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
          <option value="">All providers</option>
          {providers.map((item) => <option key={item} value={item}>{providerLabel(item)}</option>)}
        </select>
      </label>
      <div className="model-picker__list">
        {groups.every((group) => group.models.length === 0) && <div className="model-picker__empty">
          <p role="status">No models match this search and provider.</p>
          <p>Try a model name, provider or task such as “animate a logo”.</p>
          <button type="button" onClick={() => { setQuery(''); setProvider(''); }}>Clear filters</button>
        </div>}
        {groups.filter((group) => group.models.length > 0).map((group) => (
          <div key={group.label} className="model-picker__group">
            <div className="model-picker__group-label">{CATEGORY_LABELS[group.label as keyof typeof CATEGORY_LABELS] ?? group.label}</div>
            {group.models.map((m) => (
              <div key={m.id} className="model-picker__entry">
              <button
                type="button"
                className={`model-picker__row${value === m.id ? ' model-picker__row--active' : ''}`}
                aria-label={`${m.displayName}, ${CATEGORY_LABELS[m.category] ?? m.category}, ${providerLabel(String(m.apiProvider))}`}
                aria-pressed={value === m.id}
                onClick={() => {
                  onSelect(m.id);
                  onClose();
                }}
              >
                <span className="model-picker__row-content">
                  <span className="model-picker__row-name">{m.displayName}</span>
                  <span className="model-picker__row-meta">{CATEGORY_LABELS[m.category] ?? m.category} · {providerLabel(String(m.apiProvider))}</span>
                  <span className="model-picker__row-inputs">{modelInputSummary(m)}</span>
                </span>
                {value === m.id && <Check size={15} strokeWidth={2} className="model-picker__row-check" />}
              </button>
              <ProviderReadinessBadge definition={m} params={value === m.id ? selectedParams : undefined} onSetup={onClose} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
    </div>, document.body,
  );
}
