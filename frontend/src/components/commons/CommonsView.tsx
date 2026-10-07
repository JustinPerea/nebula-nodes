import { useCallback, useEffect, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { commonsApi, filtersToRequest, type UrlAddResult } from '../../lib/commonsApi';
import { EMPTY_FILTERS, type Collection, type CommonsStatus, type FilterState, type SearchRow } from '../../lib/commonsTypes';
import { pickFiles } from '../../lib/commonsFiles';
import { useCommonsPrompt } from '../../hooks/useCommonsPrompt';
import { CommonsDetail } from './CommonsDetail';
import { CommonsFilters } from './CommonsFilters';
import { CommonsGrid } from './CommonsGrid';
import { CommonsEvaluation } from './CommonsEvaluation';
import { CommonsReview } from './CommonsReview';
import { CommonsSettings } from './CommonsSettings';
import '../../styles/commons.css';

type Tab = 'all' | 'inbox' | 'settings' | 'labeling' | 'review';
type PageResult = Extract<UrlAddResult, { kind: 'page' }>;

const NEW_COLLECTION = '__new__';
const STATUS_POLL_MS = 5000;
const SEARCH_DEBOUNCE_MS = 250;

export function StatusLine({ status, onStart, onStop }: { status: CommonsStatus | null; onStart: () => void; onStop: () => void }) {
  if (!status) return <span className="commons-status">Connecting…</span>;
  if (status.evaluation_waiting) {
    return <span className="commons-status">{status.evaluation_assisted
      ? 'Library analysis paused · close the agent review to resume'
      : 'Library analysis paused until reference labels are sealed'}</span>;
  }
  const waiting = status.queue.queued ?? 0;
  const held = status.queue.held ?? 0;
  const tail = held ? ` · ${held} held` : '';
  const { state, running } = status.worker;
  if (!running && state !== 'budget_exhausted') {
    return (
      <span className="commons-status commons-status--stopped">
        Worker stopped{waiting ? ` · ${waiting} queued` : ''}{tail}
        <button type="button" className="commons-button commons-button--primary" onClick={onStart}>Start</button>
      </span>
    );
  }
  let text: string;
  if (state === 'budget_exhausted') {
    text = `Call budget used (${status.worker.budget_used}/${status.worker.budget ?? '∞'})`;
  } else if (state === 'cap_reached' || status.meter.remaining === 0) {
    text = `Daily cap reached, resets ${new Date(status.meter.resets_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else if (state === 'paused_load') {
    text = `Paused: machine busy (load ${status.load} / ${status.load_threshold})`;
  } else if (waiting || state === 'analyzing') {
    text = `Analyzing (${waiting} queued)`;
  } else {
    text = 'Worker idle';
  }
  return (
    <span className={`commons-status commons-status--${state}`}>
      {text}{tail}
      {running && <button type="button" className="commons-button" onClick={onStop}>Stop</button>}
    </span>
  );
}

export function CommonsView() {
  const restoreWorkspace = useUIStore((s) => s.exitCommons);
  const exitCommons = () => {
    restoreWorkspace();
    const hash = new URLSearchParams(window.location.hash.slice(1));
    if (window.location.hash === '#commons' || hash.get('view') === 'commons') {
      hash.delete('view');
      const rest = window.location.hash === '#commons' ? '' : hash.toString();
      window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search + (rest ? `#${rest}` : ''));
    }
  };
  const [tab, setTab] = useState<Tab>('all');
  const [labelingDirty, setLabelingDirty] = useState(false);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [target, setTarget] = useState('');
  const [status, setStatus] = useState<CommonsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [page, setPage] = useState<PageResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [ask, promptElement] = useCommonsPrompt();

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const fail = (e: unknown) => setError((e as Error).message);

  const loadCollections = useCallback(async () => {
    const list = (await commonsApi.collections()).filter((c) => c.kind !== 'system');
    setCollections(list);
    setTarget((current) => current || list[0]?.id || '');
  }, []);

  useEffect(() => {
    let cancelled = false;
    commonsApi.collections().then(
      (all) => {
        if (cancelled) return;
        const list = all.filter((c) => c.kind !== 'system');
        setCollections(list);
        setTarget((current) => current || list[0]?.id || '');
      },
      (e: Error) => { if (!cancelled) setError(e.message); },
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = () => commonsApi.status().then((s) => { if (!cancelled) setStatus(s); }, (e: Error) => { if (!cancelled) setError(e.message); });
    poll();
    const timer = window.setInterval(poll, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshKey]);

  useEffect(() => {
    if (tab === 'settings' || tab === 'labeling' || tab === 'review') return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      const request = filtersToRequest({ ...filters, inbox: tab === 'inbox' });
      commonsApi.search({ ...request, all_scopes: true }).then(
        (r) => {
          if (cancelled) return;
          setRows(r.results);
          setError(null);
          setLoading(false);
        },
        (e: Error) => {
          if (cancelled) return;
          setError(e.message);
          setLoading(false);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filters, tab, refreshKey]);

  const chooseTarget = async (value: string) => {
    if (value !== NEW_COLLECTION) {
      setTarget(value);
      return;
    }
    const name = await ask('New collection name');
    if (!name || !name.trim()) return;
    try {
      const created = await commonsApi.createCollection(name.trim());
      await loadCollections();
      setTarget(created.id);
    } catch (e) {
      fail(e);
    }
  };

  const requireTarget = (): string | null => {
    if (target) return target;
    setError('Pick or create a collection first.');
    return null;
  };

  const upload = async (files: File[]) => {
    const collectionId = requireTarget();
    if (!collectionId || files.length === 0) return;
    try {
      const { results } = await commonsApi.uploadFiles(collectionId, files);
      const failed = results.filter((r) => !r.ok);
      setNotice(`Added ${results.length - failed.length} of ${results.length}.`);
      setError(failed.length ? failed.map((r) => `${r.filename}: ${r.error}`).join('; ') : null);
      refresh();
    } catch (e) {
      fail(e);
    }
  };

  const addUrl = async (url: string, from?: PageResult) => {
    const collectionId = requireTarget();
    if (!collectionId || !url.trim()) return;
    try {
      const result = await commonsApi.addUrl({
        url: url.trim(), collection_id: collectionId,
        ...(from ? { page_url: from.page_url, page_title: from.page_title ?? undefined } : {}),
      });
      if (result.kind === 'page') {
        setPage(result);
        setNotice(result.candidates.length ? 'That is a page. Pick an image from it.' : 'No images found on that page.');
      } else {
        setPage(null);
        setUrlDraft('');
        setNotice('Added.');
        refresh();
      }
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  const importMoodboards = async () => {
    try {
      const r = await commonsApi.importMoodboards();
      setNotice(`Imported ${r.added} from ${r.collections} moodboards; skipped ${r.skipped.length}.`);
      await loadCollections();
      refresh();
    } catch (e) {
      fail(e);
    }
  };

  const workerAction = (work: () => Promise<unknown>) => {
    work().then(refresh, fail);
  };

  const openAsset = (id: string) => {
    setSelectedId(id);
    if (tab === 'settings') setTab('all');
  };

  const emptyHint = tab === 'inbox'
    ? 'Nothing waiting in the inbox. Items agents add land here for you to accept.'
    : 'No matches. Drop images or videos here, or use Add.';

  return (
    <div className={`commons-view${selectedId && tab !== 'settings' && tab !== 'labeling' && tab !== 'review' ? ' commons-view--detail' : ''}`}>
      <header className="commons-toolbar">
        <button type="button" className="commons-button" disabled={labelingDirty} onClick={exitCommons}>← Back</button>
        <span className="commons-toolbar__title">Commons</span>
        <div className="commons-tabs" role="tablist" aria-label="Commons sections">
          {(['all', 'inbox', 'review', 'labeling', 'settings'] as Tab[]).map((t) => (
            <button
              key={t} type="button" role="tab" disabled={labelingDirty} aria-selected={tab === t}
              className={`commons-tab${tab === t ? ' commons-tab--active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'all' ? 'All' : t === 'inbox' ? `Inbox` : t === 'labeling' ? 'Blind labeling' : t === 'review' ? 'Agent review' : 'Settings'}
            </button>
          ))}
        </div>
        <label className="commons-field commons-field--inline">
          Add to
          <select value={target} onChange={(event) => void chooseTarget(event.target.value)}>
            {collections.length === 0 && <option value="">No collections</option>}
            {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            <option value={NEW_COLLECTION}>New collection…</option>
          </select>
        </label>
        <div className="commons-add">
          <button
            type="button" className="commons-button commons-button--primary" aria-expanded={addOpen}
            onClick={() => setAddOpen((open) => !open)}
          >
            Add
          </button>
          {addOpen && (
            <div className="commons-add__menu" role="menu">
              <button
                type="button" role="menuitem" className="commons-button"
                onClick={() => {
                  setAddOpen(false);
                  pickFiles({ multiple: true, accept: 'image/*,video/*' }).then(upload, fail);
                }}
              >
                Choose files…
              </button>
              <form
                className="commons-add__url"
                onSubmit={(event) => {
                  event.preventDefault();
                  void addUrl(urlDraft);
                }}
              >
                <input aria-label="Image or page URL" placeholder="Paste an image or page URL" value={urlDraft}
                  onChange={(event) => setUrlDraft(event.target.value)} />
                <button type="submit" className="commons-button" disabled={!urlDraft.trim()}>Add URL</button>
              </form>
              <button
                type="button" role="menuitem" className="commons-button"
                onClick={() => {
                  setAddOpen(false);
                  void importMoodboards();
                }}
              >
                Import moodboards
              </button>
            </div>
          )}
        </div>
        <span className="commons-spacer" />
        <StatusLine
          status={status}
          onStart={() => workerAction(commonsApi.workerStart)}
          onStop={() => workerAction(commonsApi.workerStop)}
        />
      </header>

      {(error || notice) && (
        <div className="commons-messages">
          {error && <p className="commons-notice commons-notice--error" role="alert">{error}</p>}
          {!error && notice && <p className="commons-notice" role="status">{notice}</p>}
        </div>
      )}

      {page && (
        <section className="commons-candidates" aria-label="Images on the page">
          <div className="commons-candidates__head">
            <span>{page.page_title || page.page_url}</span>
            <button type="button" className="commons-link" onClick={() => setPage(null)}>Dismiss</button>
          </div>
          <div className="commons-candidates__list">
            {page.candidates.map((c) => (
              <button key={c.url} type="button" className="commons-candidate" onClick={() => void addUrl(c.url, page)}>
                <img src={c.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
                <span className="commons-meta">{c.width && c.height ? `${c.width}×${c.height}` : 'size unknown'}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {tab === 'review' ? <CommonsReview onDirtyChange={setLabelingDirty} /> : tab === 'labeling' ? <CommonsEvaluation onDirtyChange={setLabelingDirty} /> : tab === 'settings' ? (
        <main className="commons-main commons-main--settings">
          <CommonsSettings status={status} onOpenAsset={openAsset} onChanged={refresh} />
        </main>
      ) : (
        <>
          <CommonsFilters filters={filters} collections={collections} onChange={setFilters} />
          <main className="commons-main">
            <CommonsGrid
              rows={rows}
              selectedId={selectedId}
              loading={loading}
              emptyHint={emptyHint}
              onOpen={(row) => setSelectedId(row.id)}
              onDropFiles={(files) => void upload(files)}
            />
            {rows.length === 20 && <p className="commons-meta">Showing the top 20. Narrow the search to see others.</p>}
          </main>
          {selectedId && (
            <CommonsDetail
              key={selectedId}
              assetId={selectedId}
              onClose={() => setSelectedId(null)}
              onChanged={refresh}
              onDeleted={() => {
                setSelectedId(null);
                refresh();
              }}
            />
          )}
        </>
      )}
      {promptElement}
    </div>
  );
}
