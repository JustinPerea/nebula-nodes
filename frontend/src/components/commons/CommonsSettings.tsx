import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { commonsApi } from '../../lib/commonsApi';
import type { CommonsStatus, FolderLink } from '../../lib/commonsTypes';
import { saveBlob } from '../../lib/commonsFiles';
import { linkedFolderNotice } from '../../lib/commonsFormat';
import { isBackendOffline, isOfflineRefusal } from '../../lib/backendConnection';
import { offlineMark, useBackendOffline } from '../../lib/useBackendOffline';
import { LineText } from '../LineText';
import { CommonsErrorLine } from './CommonsErrorLine';
import { useCommonsLine, useReloadEpoch } from './useCommonsLine';
import { CommonsLoadingLine } from './CommonsLoadingLine';
import { COMMONS_OFF_COPY, loadFailedCause, savedReadBackLine } from '../../lib/errorCopy';
import { isPersonRefusal } from '../../lib/clearsOnPromote';

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
            // Going offline disables the field, which blurs it: not the person
            // leaving it. The text stays, and the next blur online saves it.
            if (isBackendOffline()) return;
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
              {d.error && <span className="commons-meta"><LineText text={d.error} /></span>}
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
  /** The message's tooltip: a linked folder's full path (GM r33). */
  const [messageTitle, setMessageTitle] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  // Round 15 (GM r24 b): the lists' empty states ("No folders linked.", "No new terms proposed
  // yet.") only once they were read: before that, or when the load failed, nothing was. Round 18b
  // (GM r29): the whole form waits for it too (see the early return below).
  const [loaded, setLoaded] = useState(false);
  // PR #204 round 9: a not-connected line clears on the promote, and the settings load again.
  const [loadEpoch, loadAgain] = useReloadEpoch();
  const line = useCommonsLine(setError, null, 'commons.settings-load', loadAgain);

  const load = useCallback(async (): Promise<FolderLink[]> => {
    const [f, s, c] = await Promise.all([commonsApi.folders(), commonsApi.settings(), commonsApi.candidates()]);
    setFolders(f);
    setSettings(s);
    setCandidates(c);
    setLoaded(true);
    return f;
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([commonsApi.folders(), commonsApi.settings(), commonsApi.candidates()]).then(
      ([f, s, c]) => {
        if (cancelled) return;
        setFolders(f);
        setSettings(s);
        setCandidates(c);
        setLoaded(true);
        // Round 18f (GM r35 4): read again by its "Try again": the line goes with the failure.
        setError(null);
      },
      (e: unknown) => { if (!cancelled) line.show(e, "Couldn’t load Commons settings.", { reload: true }); },
    );
    return () => { cancelled = true; };
  }, [loadEpoch, line]);

  /** `readBack` words the message again from what the write answered and the folders read back
   * (round 18f: a linked folder's own name). */
  const run = useCallback(async <T,>(work: () => Promise<T>, done?: string, doneTitle?: string,
    readBack?: (result: T, read: FolderLink[]) => void) => {
    let result: T;
    try {
      result = await work();
    } catch (e) {
      // Refused offline before it was sent: the banner says why (round 16, L4).
      if (!isOfflineRefusal(e)) line.show(e, "Couldn’t save the settings.");
      return false;
    }
    setError(null);
    if (done) { setMessage(done); setMessageTitle(doneTitle); }
    try {
      const read = await load();
      readBack?.(result, read);
    } catch (e) {
      // Round 18d (review 14 LOW-1, GM r32 3): the write landed and only reading it back failed.
      // A load's failure, neutral, in GM's words, with no "Try again" that would send the write
      // again; never the backend's words. Refused because this tab isn't connected as you: the
      // settings load's own because line, which loads them again on the promote.
      const cause = isPersonRefusal(e) ? null : loadFailedCause('load the settings back', e);
      if (isPersonRefusal(e)) line.show(e, "Couldn’t load Commons settings.", { reload: true });
      else if (cause && cause !== COMMONS_OFF_COPY) line.keep(e, savedReadBackLine(cause));
    }
    // The write committed even if its read-back failed.
    onChanged();
    return true;
  }, [load, onChanged, line]);

  const exportZip = async () => {
    try {
      const blob = await commonsApi.exportZip();
      await saveBlob(blob, `commons-export-${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (e) {
      line.show(e, "Couldn’t export Commons.");
    }
  };

  // The panel's name, at every width (GM review of p157: folded into More,
  // the panel had no title anywhere). Under the page's h1, "Commons".
  const headingId = useId();
  // Round 16 (L4): offline the Commons is read-only like the canvas. Its
  // writes sit in disabled fieldsets; reading and Export zip stay.
  const readOnly = useBackendOffline();
  // Round 18b (GM r29): until the settings read answers, or after it failed, only the heading and
  // the line, as Agent review and Blind labeling do. No field or action shows over values nothing
  // read: a Save there could overwrite the person's limits.
  if (!loaded) return (
    <section className="commons-settings" aria-labelledby={headingId}>
      <h2 id={headingId} className="commons-heading commons-panel-title">Settings</h2>
      {/* Round 18d (GM r32 5): the one loading look, under the heading. */}
      {error ? <CommonsErrorLine line={error} onRetry={loadAgain} /> : <CommonsLoadingLine text="Loading settings…" />}
    </section>
  );
  return (
    <section className="commons-settings" aria-labelledby={headingId}>
      <h2 id={headingId} className="commons-heading commons-panel-title">Settings</h2>
      <CommonsErrorLine line={error} />
      {message && <p className="commons-notice" role="status" title={messageTitle}>{message}</p>}

      <section className="commons-detail__section" aria-label="Linked folders">
        <h3 className="commons-heading">Linked folders</h3>
        <fieldset className="commons-fieldset" disabled={readOnly} {...offlineMark(readOnly)}>
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
            // Round 18f (GM r35 3): the typed text until the read-back has the folder, then the
            // folder's own name (the backend resolves "~" or ".."); a failed read-back keeps it.
            void run(() => commonsApi.linkFolder(path), linkedFolderNotice(path), path, (link, read) => {
              const row = read.find((folder) => folder.id === link?.id);
              if (!row) return;
              setMessage(linkedFolderNotice(row.path));
              setMessageTitle(row.path);
            }).then((saved) => {
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
        </fieldset>
      </section>

      <section className="commons-detail__section" aria-label="Meter">
        <h3 className="commons-heading">Meter</h3>
        {status && (
          <p className="commons-meta">
            Analysis calls today {status.meter.calls} / {status.meter.cap}
            {status.agent_adds ? ` · agent adds ${status.agent_adds.calls} / ${status.agent_adds.cap}` : ''}
            {' · '}resets {new Date(status.meter.resets_at).toLocaleString()}
          </p>
        )}
        <fieldset className="commons-fieldset" disabled={readOnly} {...offlineMark(readOnly)}>
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
        </fieldset>
      </section>

      <section className="commons-detail__section" aria-label="Vocabulary candidates">
        <h3 className="commons-heading">Vocabulary candidates</h3>
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
        <h3 className="commons-heading">Maintenance</h3>
        <div className="commons-detail__actions">
          <button
            type="button" className="commons-button" disabled={readOnly} {...offlineMark(readOnly)}
            onClick={() => run(async () => {
              const r = await commonsApi.reanalyzeStale();
              setMessageTitle(undefined);
              setMessage(`Queued ${r.queued} stale item${r.queued === 1 ? '' : 's'} for re-analysis.`);
            })}
          >
            Re-analyze stale
          </button>
          <button
            type="button" className="commons-button" disabled={readOnly} {...offlineMark(readOnly)}
            onClick={() => run(async () => {
              const r = await commonsApi.importMoodboards();
              setMessageTitle(undefined);
              setMessage(`Imported ${r.added} from ${r.collections} moodboard${r.collections === 1 ? '' : 's'}; skipped ${r.skipped.length}.`);
            })}
          >
            Import moodboards
          </button>
          <button type="button" className="commons-button" onClick={() => void exportZip()}>Export zip</button>
        </div>
      </section>
    </section>
  );
}
