import { useCallback, useEffect, useRef, useState } from 'react';
import { commonsApi } from '../../lib/commonsApi';
import type { CommonsStatus, FolderLink } from '../../lib/commonsTypes';
import { saveBlob } from '../../lib/commonsFiles';

interface Props {
  status: CommonsStatus | null;
  onOpenAsset: (assetId: string) => void;
  onChanged: () => void;
}

const NUMBER_SETTINGS: { key: string; label: string; step: number }[] = [
  { key: 'daily_cap', label: 'Analysis calls per day', step: 1 },
  { key: 'agent_add_daily_cap', label: 'Agent adds per day', step: 1 },
  { key: 'load_threshold', label: 'Pause above load', step: 1 },
];

function summaryText(summary: Record<string, unknown> | null): string {
  if (!summary) return 'not scanned yet';
  return Object.entries(summary)
    .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
    .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
    .join(' · ');
}

function FolderRow({ link, run }: { link: FolderLink; run: (work: () => Promise<unknown>) => Promise<boolean> }) {
  const pending = link.device_states.filter((d) => d.state !== 'ok' && d.state !== 'local');
  return (
    <li className="commons-folder">
      <div className="commons-folder__head">
        <code className="commons-folder__path">{link.path}</code>
        <button type="button" className="commons-button" onClick={() => run(() => commonsApi.rescan(link.id))}>Rescan</button>
      </div>
      <label className="commons-field">
        Ignore (comma separated)
        <input
          key={link.ignores.join(',')}
          defaultValue={link.ignores.join(', ')}
          onBlur={(event) => {
            const ignores = event.target.value.split(',').map((s) => s.trim()).filter(Boolean);
            if (ignores.join(',') !== link.ignores.join(',')) void run(() => commonsApi.setIgnores(link.id, ignores));
          }}
        />
      </label>
      <p className="commons-meta">
        Last scan {link.last_scan_at ? new Date(link.last_scan_at).toLocaleString() : 'never'} · {summaryText(link.last_scan_summary)}
      </p>
      {pending.length > 0 && (
        <ul className="commons-list">
          {pending.map((d) => (
            <li key={d.path} className="commons-list__item">
              <span className={`commons-badge commons-badge--${d.state}`}>{d.state}</span>
              <span className="commons-list__text">{d.path.split('/').pop()}</span>
              {d.error && <span className="commons-meta">{d.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function CommonsSettings({ status, onOpenAsset, onChanged }: Props) {
  const [folders, setFolders] = useState<FolderLink[]>([]);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [candidates, setCandidates] = useState<{ term: string; count: number; assets: string[] }[]>([]);
  const [linkPath, setLinkPath] = useState('');
  const [linking, setLinking] = useState(false);
  const linkingRef = useRef(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [f, s, c] = await Promise.all([commonsApi.folders(), commonsApi.settings(), commonsApi.candidates()]);
    setFolders(f);
    setSettings(s);
    setCandidates(c);
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([commonsApi.folders(), commonsApi.settings(), commonsApi.candidates()]).then(
      ([f, s, c]) => {
        if (cancelled) return;
        setFolders(f);
        setSettings(s);
        setCandidates(c);
      },
      (e: Error) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
  }, []);

  const run = useCallback(async (work: () => Promise<unknown>, done?: string) => {
    let committed = false;
    try {
      await work();
      committed = true;
      setError(null);
      if (done) setMessage(done);
      await load();
      onChanged();
      return true;
    } catch (e) {
      setError((e as Error).message);
      // The write may have committed even if its read-back failed. Preserve
      // the error without inviting the user to submit that write again.
      if (committed) onChanged();
      return committed;
    }
  }, [load, onChanged]);

  const exportZip = async () => {
    try {
      const blob = await commonsApi.exportZip();
      await saveBlob(blob, `commons-export-${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="commons-settings">
      {error && <p className="commons-notice commons-notice--error" role="alert">{error}</p>}
      {message && <p className="commons-notice" role="status">{message}</p>}

      <section className="commons-detail__section" aria-label="Linked folders">
        <h2 className="commons-heading">Linked folders</h2>
        <ul className="commons-folders">
          {folders.map((link) => <FolderRow key={link.id} link={link} run={run} />)}
        </ul>
        {folders.length === 0 && <p className="commons-meta">No folders linked. Linked folders are read, never written.</p>}
        <form
          className="commons-detail__row"
          onSubmit={(event) => {
            event.preventDefault();
            const path = linkPath.trim();
            if (!path || linkingRef.current) return;
            const submittedPath = linkPath;
            linkingRef.current = true;
            setLinking(true);
            void run(() => commonsApi.linkFolder(path), `Linked ${path}; scanning.`).then((saved) => {
              if (saved) setLinkPath((current) => current === submittedPath ? '' : current);
            }).finally(() => {
              linkingRef.current = false;
              setLinking(false);
            });
          }}
        >
          <label className="commons-field commons-field--grow">
            Folder path
            <input value={linkPath} placeholder="/Users/you/Pictures/refs" onChange={(e) => setLinkPath(e.target.value)} />
          </label>
          <button type="submit" className="commons-button" disabled={linking || !linkPath.trim()}>Link folder</button>
        </form>
      </section>

      <section className="commons-detail__section" aria-label="Meter">
        <h2 className="commons-heading">Meter</h2>
        {status && (
          <p className="commons-meta">
            Analysis calls today {status.meter.calls} / {status.meter.cap}
            {status.agent_adds ? ` · agent adds ${status.agent_adds.calls} / ${status.agent_adds.cap}` : ''}
            {' · '}resets {new Date(status.meter.resets_at).toLocaleString()}
          </p>
        )}
        <form
          className="commons-detail__grid"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const body: Record<string, number> = {};
            for (const { key } of NUMBER_SETTINGS) {
              const raw = data.get(key);
              if (raw !== null && raw !== '' && Number(raw) !== settings[key]) body[key] = Number(raw);
            }
            if (Object.keys(body).length) void run(() => commonsApi.patchSettings(body), 'Settings saved.');
          }}
        >
          {NUMBER_SETTINGS.map(({ key, label, step }) => (
            <label key={key} className="commons-field">
              {label}
              <input
                key={String(settings[key])} name={key} type="number" min={0} step={step}
                defaultValue={typeof settings[key] === 'number' ? (settings[key] as number) : ''}
              />
            </label>
          ))}
          <button type="submit" className="commons-button">Save</button>
        </form>
      </section>

      <section className="commons-detail__section" aria-label="Vocabulary candidates">
        <h2 className="commons-heading">Vocabulary candidates</h2>
        {candidates.length === 0 ? (
          <p className="commons-meta">No new terms proposed yet.</p>
        ) : (
          <ul className="commons-list">
            {candidates.map((c) => (
              <li key={c.term} className="commons-list__item">
                <strong>{c.term}</strong>
                <span className="commons-meta">×{c.count}</span>
                {c.assets.slice(0, 6).map((id) => (
                  <button key={id} type="button" className="commons-link" onClick={() => onOpenAsset(id)}>{id.slice(-6)}</button>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="commons-detail__section" aria-label="Maintenance">
        <h2 className="commons-heading">Maintenance</h2>
        <div className="commons-detail__actions">
          <button
            type="button" className="commons-button"
            onClick={() => run(async () => {
              const r = await commonsApi.reanalyzeStale();
              setMessage(`Queued ${r.queued} stale item${r.queued === 1 ? '' : 's'} for re-analysis.`);
            })}
          >
            Re-analyze stale
          </button>
          <button
            type="button" className="commons-button"
            onClick={() => run(async () => {
              const r = await commonsApi.importMoodboards();
              setMessage(`Imported ${r.added} from ${r.collections} moodboard${r.collections === 1 ? '' : 's'}; skipped ${r.skipped.length}.`);
            })}
          >
            Import moodboards
          </button>
          <button type="button" className="commons-button" onClick={() => void exportZip()}>Export zip</button>
        </div>
      </section>
    </div>
  );
}
