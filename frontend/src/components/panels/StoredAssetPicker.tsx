import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { fetchCharacters, fetchMoodboards } from '../../lib/api';
import { wsClient } from '../../lib/wsClient';
import { useUIStore } from '../../store/uiStore';
import {
  characterSummary,
  moodboardSummary,
  useStoredAsset,
  type StoredAssetKind,
  type StoredAssetSummary,
} from '../../store/storedAssetsStore';

interface StoredAssetPickerProps {
  kind: StoredAssetKind;
  label: string;
  value: string;
  onChange: (id: string) => void;
}

const NOUN: Record<StoredAssetKind, string> = { moodboard: 'board', character: 'character' };

/** Global and this project's saved assets, by name. A scope that can't be
 *  read (no open project yet) is left out, not an error. */
async function listAssets(kind: StoredAssetKind): Promise<StoredAssetSummary[]> {
  const scopes = ['global', 'project'] as const;
  const lists = await Promise.all(scopes.map((scope) => (kind === 'moodboard'
    ? fetchMoodboards(scope).then((items) => items.map(moodboardSummary))
    : fetchCharacters(scope).then((items) => items.map(characterSummary))
  ).catch(() => [] as StoredAssetSummary[])));
  const byId = new Map<string, StoredAssetSummary>();
  for (const item of lists.flat()) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
}

/**
 * The Inspector control for a `moodboard` or `character` param: which saved
 * asset the node shows. The value is the asset's id, the same one agents set.
 */
export function StoredAssetPicker({ kind, label, value, onChange }: StoredAssetPickerProps) {
  const enterMoodboardEditor = useUIStore((s) => s.enterMoodboardEditor);
  const enterCharacterEditor = useUIStore((s) => s.enterCharacterEditor);
  const current = useStoredAsset(kind, value);
  const [options, setOptions] = useState<StoredAssetSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void listAssets(kind).then((items) => {
        if (!cancelled) setOptions(items);
      });
    };
    load();
    // A board saved, renamed or deleted elsewhere (the Studio, an agent).
    const unsubscribe = wsClient.subscribe((event) => {
      if (event.type === 'storedAssetChanged' && event.kind === kind) load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [kind]);

  const listed = options?.some((option) => option.id === value) ?? false;
  const missing = current?.status === 'missing';
  const open = () => (kind === 'moodboard' ? enterMoodboardEditor(value) : enterCharacterEditor(value));

  return (
    <div className="inspector__control-stack" data-stored-asset-picker={kind}>
      <select
        className="inspector__field"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {!value && <option value="">{options === null ? 'Loading…' : `Choose a ${NOUN[kind]}…`}</option>}
        {value && !listed && (
          <option value={value}>
            {missing ? `Not found (#${value})` : current?.summary?.name || `#${value}`}
          </option>
        )}
        {(options ?? []).map((option) => (
          <option key={option.id} value={option.id}>{option.name || `#${option.id}`}</option>
        ))}
      </select>
      {options !== null && options.length === 0 && !value && (
        <div className="inspector__notice" role="note">No saved {NOUN[kind]}s yet. Make one from the Assets panel.</div>
      )}
      {missing && (
        <div className="inspector__notice" role="note">This {NOUN[kind]} was deleted or never existed. Pick another.</div>
      )}
      {value && !missing && (
        <button type="button" className="inspector__action-button" onClick={open}>
          <ExternalLink className="inspector__action-icon" size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
          <span>Open {kind === 'moodboard' ? 'Moodboard' : 'Character'}</span>
        </button>
      )}
    </div>
  );
}
