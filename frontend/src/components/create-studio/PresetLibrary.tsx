import { useEffect, useMemo, useState } from 'react';
import { Search, Bookmark } from 'lucide-react';
import { fetchPresets, type Preset } from '../../lib/createPresets';
import { PresetCard } from './PresetCard';

export interface PresetLibraryProps {
  onApply: (preset: Preset) => void;
  onSaveCurrent: () => void;
  onClose: () => void;
  reloadKey: number; // bump to refetch after a save
}

export function PresetLibrary({ onApply, onSaveCurrent, onClose, reloadKey }: PresetLibraryProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');

  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchPresets('global'), fetchPresets('project')])
      .then(([g, p]) => { if (!cancelled) setPresets([...p, ...g]); })
      .catch(() => { if (!cancelled) setPresets([]); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(presets.map((p) => p.category))).sort()],
    [presets],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return presets.filter((p) =>
      (category === 'All' || p.category === category) &&
      (!q || p.name.toLowerCase().includes(q) || p.prompt.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)),
    );
  }, [presets, query, category]);

  return (
    <div className="preset-library" role="dialog" aria-label="Styles">
      <div className="preset-library__top">
        <div className="preset-library__search">
          <Search size={15} strokeWidth={1.75} aria-hidden="true" />
          <input autoFocus type="text" placeholder="Search styles…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button type="button" className="preset-library__save" onClick={onSaveCurrent}>
          <Bookmark size={14} strokeWidth={1.75} aria-hidden="true" /> Save current
        </button>
      </div>
      <div className="preset-library__cats">
        {categories.map((c) => (
          <button key={c} type="button" className={`preset-library__cat${category === c ? ' is-active' : ''}`} onClick={() => setCategory(c)}>{c}</button>
        ))}
      </div>
      <div className="preset-library__grid">
        {visible.map((p) => <PresetCard key={p.id} preset={p} onApply={(pp) => { onApply(pp); onClose(); }} />)}
        {visible.length === 0 && <div className="preset-library__empty">No styles yet.</div>}
      </div>
    </div>
  );
}
