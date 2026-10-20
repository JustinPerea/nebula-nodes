import { useEffect, useMemo, useState } from 'react';
import { Search, Bookmark } from 'lucide-react';
import { fetchPresets, type Preset } from '../../lib/createPresets';
import { PresetCard } from './PresetCard';
import { useCurrentProjectId } from '../../lib/currentProject';
import { wsClient } from '../../lib/wsClient';

export interface PresetLibraryProps {
  onApply: (preset: Preset) => void;
  onSaveCurrent: () => void;
  onClose: () => void;
  reloadKey: number; // bump to refetch after a save
  saving?: boolean;
}

export function PresetLibrary({ onApply, onSaveCurrent, onClose, reloadKey, saving = false }: PresetLibraryProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');

  // This project's styles are the open canvas project's (lib/currentProject);
  // with none open, only the global ones show.
  const projectId = useCurrentProjectId();
  // A Style saved, changed, deleted or restored elsewhere (an agent, the
  // Assets panel, another tab) shows up without reopening Styles.
  const [changed, setChanged] = useState(0);
  useEffect(() => wsClient.subscribe((event) => {
    if ((event.type === 'storedAssetChanged' && event.kind === 'style') || event.type === 'socketReconnected') {
      setChanged((value) => value + 1);
    }
  }), []);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetchPresets('global').catch(() => [] as Preset[]),
      projectId ? fetchPresets('project', projectId).catch(() => [] as Preset[]) : Promise.resolve([] as Preset[]),
    ]).then(([g, p]) => { if (!cancelled) setPresets([...p, ...g]); });
    return () => { cancelled = true; };
  }, [reloadKey, projectId, changed]);

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
        <button type="button" className="preset-library__save" onClick={onSaveCurrent} disabled={saving}>
          <Bookmark size={14} strokeWidth={1.75} aria-hidden="true" /> {saving ? 'Saving…' : 'Save current'}
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
