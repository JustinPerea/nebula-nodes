import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, FocusEvent as ReactFocusEvent, RefObject } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { targetsOf, useAssetProposalsStore } from '../../store/assetProposalsStore';
import { openOnce } from '../../store/assetProposalReviewRequest';
import { useUIStore } from '../../store/uiStore';
import { commonsApi, filtersToRequest, uploadFailureCopy, type UrlAddResult } from '../../lib/commonsApi';
import type { FailureCopy } from '../../lib/errorCopy';
import { FailureLines } from '../failure/FailureLines';
import { EMPTY_FILTERS, type Collection, type CommonsStatus, type FilterState, type SearchRow } from '../../lib/commonsTypes';
import { pickFiles } from '../../lib/commonsFiles';
import { useCommonsPrompt } from '../../hooks/useCommonsPrompt';
import { CommonsDetail } from './CommonsDetail';
import { CommonsFilters } from './CommonsFilters';
import { CommonsGrid } from './CommonsGrid';
import { CommonsEvaluation } from './CommonsEvaluation';
import { CommonsReview } from './CommonsReview';
import { CommonsSettings } from './CommonsSettings';
import { CommonsProposalsLine } from './CommonsProposalsLine';
import { WorkspaceHeader } from '../WorkspaceHeader';
import { ToolbarMenuPopover } from '../asset-move/AssetMoveMenu';
import { workspaceLabel } from '../../lib/workspaceLabel';
import { setCommonsUnsaved } from '../../lib/commonsUnsaved';
import { useProjectStore } from '../../store/projectStore';
import { useCommonsLeave } from './commonsLeave';
import { CommonsLeavePopover } from './CommonsLeavePopover';
import '../../styles/commons.css';
import { failureMessage } from '../../lib/errorCopy';

type Tab = 'all' | 'inbox' | 'settings' | 'labeling' | 'review';
type PageResult = Extract<UrlAddResult, { kind: 'page' }>;

const TABS: Tab[] = ['all', 'inbox', 'review', 'labeling', 'settings'];
/**
 * The two least-used sections: Blind labeling (an occasional evaluation
 * session) and Settings (set once). While the Updates chip takes its room in
 * the header below 1440 px they fold into More (commons.css), so the toolbar
 * keeps one row (GM review of Q107 a). All, Inbox and Agent review, the
 * add controls and the worker line are what a visit acts on, so they stay.
 */
const FOLDED_TABS: Tab[] = ['labeling', 'settings'];

function tabLabel(tab: Tab): string {
  return tab === 'all' ? 'All' : tab === 'inbox' ? 'Inbox' : tab === 'labeling' ? 'Blind labeling' : tab === 'review' ? 'Agent review' : 'Settings';
}

/** commons.css's fold: below this width, while the Updates chip shows. */
const FOLD_QUERY = '(max-width: 1439px)';

function subscribeFold(onChange: () => void) {
  const query = window.matchMedia?.(FOLD_QUERY);
  query?.addEventListener('change', onChange);
  // The chip comes and goes with the open project (body.agent-notes-shown).
  const observer = new MutationObserver(onChange);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  return () => {
    query?.removeEventListener('change', onChange);
    observer.disconnect();
  };
}

function foldedNow(): boolean {
  return Boolean(window.matchMedia?.(FOLD_QUERY).matches) && document.body.classList.contains('agent-notes-shown');
}

/** Whether the toolbar folds right now, as the stylesheet decides it. */
function useToolbarFolds(): boolean {
  return useSyncExternalStore(subscribeFold, foldedNow, () => false);
}

type FoldFocus = 'more' | 'tab' | null;

/**
 * Crossing the fold hides More or the folded tabs. If one of them had focus,
 * the browser drops it to <body>; this moves it to the counterpart now on
 * screen (More, or the open folded tab, else the first one). The blur and the
 * media change can come in either order, so a blur to nowhere keeps the mark
 * for two frames, and the move waits one frame and only takes focus from
 * <body> or from these controls.
 */
function useFoldFocusHandoff(folded: boolean, tab: Tab) {
  const moreRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const mark = useRef<{ kind: FoldFocus; seq: number }>({ kind: null, seq: 0 });
  const wasFolded = useRef(folded);

  useEffect(() => {
    if (wasFolded.current === folded) return;
    wasFolded.current = folded;
    if (!mark.current.kind) return;
    const frame = requestAnimationFrame(() => {
      const at = document.activeElement;
      const ours = at === moreRef.current || FOLDED_TABS.some((t) => tabRefs.current[t] === at);
      if (at && at !== document.body && !ours) return;
      const target = folded ? moreRef.current : tabRefs.current[FOLDED_TABS.includes(tab) ? tab : FOLDED_TABS[0]];
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [folded, tab]);

  const onFocus = useCallback((kind: Exclude<FoldFocus, null>) => {
    mark.current = { kind, seq: mark.current.seq + 1 };
  }, []);
  const onBlur = useCallback((event: ReactFocusEvent<HTMLElement>, keep = false) => {
    if (keep) return;
    if (event.relatedTarget) {
      mark.current = { kind: null, seq: mark.current.seq + 1 };
      return;
    }
    const seq = mark.current.seq;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (mark.current.seq === seq) mark.current = { kind: null, seq: seq + 1 };
    }));
  }, []);
  return { moreRef, tabRefs, onFocus, onBlur };
}

/** The folded sections' button and menu (the app's toolbar menu, AssetMoveMenu's). */
function MoreSections({ tab, unsaved, onChoose, triggerRef, onFocus, onBlur }: {
  tab: Tab;
  /** A folded section holds unsaved labels: More carries its mark. */
  unsaved: boolean;
  onChoose: (tab: Tab) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onFocus: () => void;
  /** `keep`: focus went into this menu, so More still holds it. */
  onBlur: (event: ReactFocusEvent<HTMLElement>, keep: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, [triggerRef]);
  // With a folded section open, More stands in for its hidden tab. Its text
  // stays "More": "Blind labeling" is 46 px wider and wraps the toolbar at
  // 1280 (measured), so the menu marks the open one instead (asset-move.css).
  const active = FOLDED_TABS.includes(tab);
  return (
    <>
      <button ref={triggerRef} type="button" className={`commons-tab commons-tabs__more${active ? ' commons-tab--active' : ''}`}
        aria-label={`${active ? `More: ${tabLabel(tab)}` : 'More'}${unsaved ? ' · Unsaved' : ''}`} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined} onClick={() => setOpen((value) => !value)}
        onFocus={onFocus}
        onBlur={(event) => onBlur(event, event.relatedTarget instanceof Element && Boolean(event.relatedTarget.closest(`[id="${menuId}"]`)))}>
        More{unsaved && <span className="commons-tab__dot" aria-hidden="true" />}<span className="asset-move__caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <ToolbarMenuPopover anchorRef={triggerRef} id={menuId} label="More Commons sections" onClose={close}
          choices={FOLDED_TABS.map((id) => ({ id, label: tabLabel(id), checked: id === tab }))}
          onChoose={(choice) => { close(true); onChoose(choice.id); }} />
      )}
    </>
  );
}

const NEW_COLLECTION = '__new__';
const STATUS_POLL_MS = 5000;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * The worker's status text. GM - Design: "Keep the worker status to its state
 * plus one action, short enough to show whole at 1280 (about 36 characters),
 * with the full explanation in the tooltip." The text is the status a person
 * reads at a glance; its title (the tooltip) says what it means and what
 * resumes it. It still truncates on one line down to a minimum (commons.css),
 * the safety net for a status longer than the room (p157c), and it stays the
 * element's own text, so assistive tech reads it.
 */
function StatusText({ text, title }: { text: string; title: string }) {
  // Its length caps the room a short status reserves (commons.css).
  const style = { '--commons-status-chars': [...text].length } as CSSProperties;
  return <span className="commons-status__text" title={title} style={style}>{text}</span>;
}

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

export function StatusLine({ status, onStart, onStop }: { status: CommonsStatus | null; onStart: () => void; onStop: () => void }) {
  if (!status) {
    return <span className="commons-status"><StatusText text="Connecting…" title="Connecting to library analysis…" /></span>;
  }
  if (status.evaluation_waiting) {
    // GM: "the label names whatever has to be fixed first, and the tooltip
    // lists anything still blocking after that." Sealing or closing only
    // lifts the hold: a stopped worker (the default at launch) stays stopped,
    // so the label leads with "Stopped", in the stopped colour, and Start is
    // here ("\"Paused\" next to \"Start\" reads as a contradiction"). A used
    // call budget comes first of all: only a restart resets it.
    const { running, state } = status.worker;
    const then = status.evaluation_assisted ? 'the agent review is closed' : 'the reference labels are sealed';
    if (state === 'budget_exhausted') {
      const budget = status.worker.budget ?? '∞';
      return (
        <span className="commons-status commons-status--stopped">
          <StatusText text={`Stopped · call budget used (${status.worker.budget_used}/${budget})`}
            title={`Library analysis is stopped: it used this run's call budget (${status.worker.budget_used} of ${budget} calls). Restart Nebula to reset it. Analysis then stays paused until ${then}.`} />
        </span>
      );
    }
    const after = running
      ? ' to resume.'
      : ", then press Start: library analysis is stopped, so it won't resume on its own.";
    const text = status.evaluation_assisted
      ? (running ? 'Paused · close agent review to resume' : 'Stopped · agent review open')
      : (running ? 'Paused until labels are sealed' : 'Stopped · labels not sealed');
    return <span className={running ? 'commons-status' : 'commons-status commons-status--stopped'}>{status.evaluation_assisted
      ? <StatusText text={text}
          title={`Library analysis is paused: the agent graded these references before the blind labels were sealed, so they can no longer be sealed as blind labels. Close them as an assisted review (in Agent review or Blind labeling)${after}`} />
      : <StatusText text={text}
          title={`Library analysis is paused while blind labeling is open, so it can't sway your reference labels. Seal the labels, or close the batch without sealing, in Blind labeling${after}`} />}
      {!running && <button type="button" className="commons-button commons-button--primary" onClick={onStart}>Start</button>}
    </span>;
  }
  const waiting = status.queue.queued ?? 0;
  const held = status.queue.held ?? 0;
  // Agent adds over today's cap wait in the Inbox: a part of every worker status.
  const tail = held ? ` · ${held} held` : '';
  const heldNote = held
    ? ` ${held} ${plural(held, 'reference added by an agent is held until you accept it', 'references added by agents are held until you accept them')} in the Inbox.`
    : '';
  const { state, running } = status.worker;
  if (!running && state !== 'budget_exhausted') {
    const queued = waiting ? ` ${waiting} ${plural(waiting, 'reference is', 'references are')} waiting to be read.` : '';
    return (
      <span className="commons-status commons-status--stopped">
        <StatusText text={`Stopped${waiting ? ` · ${waiting} queued` : ''}${tail}`}
          title={`Library analysis is stopped.${queued}${heldNote} Start runs it while Nebula is open.`} />
        <button type="button" className="commons-button commons-button--primary" onClick={onStart}>Start</button>
      </span>
    );
  }
  let text: string;
  let title: string;
  if (state === 'budget_exhausted') {
    const budget = status.worker.budget ?? '∞';
    text = `Stopped · call budget used (${status.worker.budget_used}/${budget})`;
    title = `Library analysis is stopped: it used this run's call budget (${status.worker.budget_used} of ${budget} calls). Restart Nebula to reset it.`;
  } else if (state === 'cap_reached' || status.meter.remaining === 0) {
    // Settings takes a cap from 0: a cap of 0 never resets, and a cap lowered
    // below today's calls is not the number made (review of sf).
    const { calls, cap } = status.meter;
    if (cap === 0) {
      text = 'Paused · daily cap is 0';
      title = 'Library analysis is paused. Settings has “Analysis calls per day” at 0, so it reads nothing. Raise it to resume.';
    } else {
      const resets = new Date(status.meter.resets_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      text = `Paused until ${resets} · daily cap`;
      title = `Library analysis is paused. It made ${calls} analysis calls today, and Settings has “Analysis calls per day” at ${cap}. It resumes on its own at ${resets}.`;
    }
  } else if (state === 'paused_load') {
    text = `Paused · computer busy (${status.load}/${status.load_threshold})`;
    title = `Library analysis is paused while this computer is busy. Its load average is ${status.load}, and Settings has “Pause above load” at ${status.load_threshold}. It resumes on its own when the load drops.`;
  } else if (waiting || state === 'analyzing') {
    text = `Analyzing${waiting ? ` · ${waiting} queued` : ''}`;
    title = `Library analysis is reading references${waiting ? `: ${waiting} waiting` : ''}.`;
  } else {
    text = 'Idle';
    title = 'Library analysis is running and has nothing to read. New references are read as they arrive.';
  }
  return (
    <span className={`commons-status commons-status--${state}`}>
      <StatusText text={`${text}${tail}`} title={`${title}${heldNote}`} />
      {running && <button type="button" className="commons-button" onClick={onStop}>Stop</button>}
    </span>
  );
}

export function CommonsView() {
  const returnView = useUIStore((s) => s.commonsReturnView);
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
  const folded = useToolbarFolds();
  const foldFocus = useFoldFocusHandoff(folded, tab);
  // Blind labeling and Agent review stay mounted once opened, hidden while
  // another section shows, so their drafts (and a grading run) live as long
  // as the Commons: moving between sections isn't leaving (commons-leave).
  const [opened, setOpened] = useState<Tab[]>([]);
  if ((tab === 'labeling' || tab === 'review') && !opened.includes(tab)) setOpened([...opened, tab]);
  const backRef = useRef<HTMLButtonElement>(null);
  const leave = useCommonsLeave(backRef);
  const [busyAt, setBusyAt] = useState<'back' | 'home' | null>(null);
  // A leave waiting on a save in progress marks its control; a later one takes the mark over.
  const busyFor = useCallback((which: 'back' | 'home') => (on: boolean) =>
    setBusyAt((at) => (on ? which : at === which ? null : at)), []);
  // While a panel holds unsaved work nothing leaves the Commons without
  // asking: the stores hold agents' and the system's exits (lib/commonsUnsaved),
  // and the person's own exits ask here (leave.request).
  useEffect(() => {
    setCommonsUnsaved(leave.hold);
    return () => setCommonsUnsaved(false);
  }, [leave.hold]);
  // The browser's Back or a hash edit: the hash routes' exits are held, the
  // URL goes back to what's shown, and the popover asks, anchored to Back.
  // Pushed, not replaced: after a Back the current entry is the one the
  // person went back to, and it must survive, so leaving is one Back to it.
  const { request } = leave;
  useEffect(() => {
    if (!leave.hold) return;
    const stay = (event: HashChangeEvent) => {
      window.history.pushState(window.history.state, '', event.oldURL);
      request({ anchor: backRef.current, go: () => window.history.back(), busy: busyFor('back') });
    };
    window.addEventListener('hashchange', stay);
    return () => window.removeEventListener('hashchange', stay);
  }, [leave.hold, request, busyFor]);
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [target, setTarget] = useState('');
  const [status, setStatus] = useState<CommonsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The files the last upload couldn't add, each "Couldn't upload {filename}."
   * over its reason (GM, error-copy round 2). Their own list: the refresh
   * after an upload must not clear them, as it clears a search's error. */
  const [uploadFailures, setUploadFailures] = useState<FailureCopy[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [urlDraft, setUrlDraft] = useState('');
  const [page, setPage] = useState<PageResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [ask, promptElement] = useCommonsPrompt();
  const proposedIds = useAssetProposalsStore(useShallow((state) => targetsOf(state, 'commons')));
  const proposed = useMemo(() => new Set(proposedIds), [proposedIds]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const fail = (e: unknown) => setError(failureMessage(e, "Couldn't update the library."));

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
      (e: unknown) => { if (!cancelled) setError(failureMessage(e, "Couldn't load the collections.")); },
    );
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = () => commonsApi.status().then((s) => { if (!cancelled) setStatus(s); }, (e: unknown) => { if (!cancelled) setError(failureMessage(e, "Couldn't load the library status.")); });
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
        (e: unknown) => {
          if (cancelled) return;
          setError(failureMessage(e, "Couldn't search the library."));
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
    setUploadFailures([]);
    try {
      const { results } = await commonsApi.uploadFiles(collectionId, files);
      const failed = results.filter((r) => !r.ok);
      setNotice(`Added ${results.length - failed.length} of ${results.length}.`);
      // Never the backend's raw `error` (GM): its reason code, mapped.
      setUploadFailures(failed.map(uploadFailureCopy));
      setError(null);
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

  // A reference an agent asks to change: its detail, where the proposal waits.
  // Another section of the same Commons: unsaved labels keep (commons-leave).
  const reviewProposal = (id: string) => {
    setSelectedId(id);
    if (tab !== 'all' && tab !== 'inbox') setTab('all');
  };

  // Review on the proposal's Update (Q92 a): open that reference's detail;
  // the strip there takes the request and comes into view. Each request opens
  // it once: a later visit doesn't reopen it when no strip took the request.
  const reviewAsked = useAssetProposalsStore((state) => (state.review?.kind === 'commons' ? state.review : null));
  useEffect(() => {
    if (reviewAsked && openOnce(reviewAsked)) reviewProposal(reviewAsked.targetId);
    // Only a new request opens a detail; the tab and draft state are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewAsked]);

  const emptyHint = tab === 'inbox'
    ? 'Nothing waiting in the inbox. Items agents add land here for you to accept.'
    : 'No matches. Drop images or videos here, or use Add.';

  return (
    <div className={`commons-view${selectedId && tab !== 'settings' && tab !== 'labeling' && tab !== 'review' ? ' commons-view--detail' : ''}`}>
      <WorkspaceHeader title="Commons" backLabel={workspaceLabel(returnView)} className="commons-toolbar" backRef={backRef}
        onBack={() => request({ anchor: backRef.current, go: exitCommons, busy: busyFor('back') }, true)}
        backBusy={busyAt === 'back'} homeBusy={busyAt === 'home'}
        onHome={(button) => request({ anchor: button, go: () => void useProjectStore.getState().goHome(), busy: busyFor('home') }, true)}>
        <div className="commons-tabs" role="tablist" aria-label="Commons sections">
          {TABS.map((t) => {
            const folds = FOLDED_TABS.includes(t);
            const marked = (t === 'labeling' && leave.unsaved.labeling) || (t === 'review' && leave.unsaved.review);
            return (
              <button
                key={t} type="button" role="tab" aria-selected={tab === t}
                className={`commons-tab${tab === t ? ' commons-tab--active' : ''}${folds ? ' commons-tab--overflow' : ''}`}
                // Folded, the open one is hidden on screen (commons.css): keep Tab off it.
                tabIndex={folded && folds && tab === t ? -1 : undefined}
                ref={folds ? (el) => { foldFocus.tabRefs.current[t] = el; } : undefined}
                onFocus={folds ? () => foldFocus.onFocus('tab') : undefined}
                onBlur={folds ? (event) => foldFocus.onBlur(event) : undefined}
                onClick={() => setTab(t)}
              >
                {tabLabel(t)}
                {marked && <><span className="commons-tab__dot" aria-hidden="true" /><span className="commons-sr-only"> · Unsaved</span></>}
              </button>
            );
          })}
        </div>
        <MoreSections tab={tab} unsaved={leave.unsaved.labeling} onChoose={setTab} triggerRef={foldFocus.moreRef}
          onFocus={() => foldFocus.onFocus('more')} onBlur={foldFocus.onBlur} />
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
        {/* The status takes the row's free room itself (commons.css): no spacer. */}
        <StatusLine
          status={status}
          onStart={() => workerAction(commonsApi.workerStart)}
          onStop={() => workerAction(commonsApi.workerStop)}
        />
      </WorkspaceHeader>

      {(error || notice || uploadFailures.length > 0 || proposed.size > 0) && (
        <div className="commons-messages">
          {error && <p className="commons-notice commons-notice--error" role="alert">{error}</p>}
          {uploadFailures.length > 0 && (
            <p className="commons-notice commons-notice--error" role="alert">
              <span className="commons-notice__list">
                {uploadFailures.map((failure, index) => <FailureLines key={index} failure={failure} />)}
              </span>
            </p>
          )}
          {!error && notice && <p className="commons-notice" role="status">{notice}</p>}
          <CommonsProposalsLine onOpen={reviewProposal} />
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

      {/* Hidden, not unmounted, while another section shows (display: contents
          otherwise, so each panel stays the view's grid item; commons.css). */}
      {opened.includes('review') && (
        <div className="commons-panel-slot" hidden={tab !== 'review'}>
          <CommonsReview active={tab === 'review'} onWork={leave.report.review} />
        </div>
      )}
      {opened.includes('labeling') && (
        <div className="commons-panel-slot" hidden={tab !== 'labeling'}>
          <CommonsEvaluation active={tab === 'labeling'} onWork={leave.report.labeling} />
        </div>
      )}
      {tab === 'review' || tab === 'labeling' ? null : tab === 'settings' ? (
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
              proposed={proposed}
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
      {leave.asking && (
        <CommonsLeavePopover asking={leave.asking} unsaved={leave.unsaved.labeling || leave.unsaved.review} running={leave.running}
          onChoose={(choice) => void leave.choose(choice)} onStay={leave.close} />
      )}
    </div>
  );
}
