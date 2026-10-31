import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { NODE_DEFINITIONS } from '../../../constants/nodeDefinitions';
import { isKeySet } from '../../../lib/directRoute';
import { matchesModelSearch } from '../../../lib/modelDiscovery';
import { supportsKreaAccount } from '../../../lib/kreaConnection';
import { PROVIDER_KEYS, providerMatches, unlockCount } from '../../../lib/providerCatalog';
import { useSettingsDraftStore, type SettingsDraft } from '../../../store/settingsDraftStore';
import { useUIStore } from '../../../store/uiStore';
import { useProviderReadinessStore } from '../../../store/providerReadinessStore';
import { offlineMark, useBackendOffline } from '../../../lib/useBackendOffline';
import { SETTINGS_SAVED_EVENT, settingsSavedDetail } from '../../../lib/settingsSignal';
import { keyChangedLine } from '../../../lib/settingsWrites';
import { KeyRow } from './KeyRow';
import { KreaSignInRow } from './KreaSignInRow';
import { NousRow } from './NousRow';
import { connectedRows, focusRowIfItMoves, KREA_ROW, NOUS_ROW } from './rowHelpers';
import { useKreaConnection } from './useKreaConnection';

const NODES = Object.values(NODE_DEFINITIONS);
const KREA_ACCOUNT_NODES = NODES.filter((node) => supportsKreaAccount(node));
const NOUS_NODES = NODES.filter((node) => node.apiProvider === 'nous');

interface Entry {
  id: string;
  connected: boolean;
  /** Nodes it opens up; the add list sorts by it. */
  reach: number;
  order: number;
  matches: (query: string) => boolean;
  render: (moved: boolean) => ReactNode;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Connected providers first, then everything you could add, ordered by how
 * many nodes each one opens up. Search covers provider names and the models
 * they run, so "Veo" finds every provider that can run Veo.
 */
export function ProvidersTab({ saved }: { saved: SettingsDraft }) {
  const [query, setQuery] = useState('');
  const health = useProviderReadinessStore();
  const krea = useKreaConnection();
  const setupTarget = useUIStore((s) => s.settingsProviderTarget);
  const root = useRef<HTMLDivElement>(null);
  // Offline (GM, round 16 of PR #114): the search stays usable; everything
  // that edits sits in the disabled fieldset below it.
  const offline = useBackendOffline();
  const handledTarget = useRef<typeof setupTarget>(null);
  const desktop = typeof window !== 'undefined' ? window.nebulaDesktop : undefined;
  const plaintextWarning = desktop?.credentials ? (desktop.plaintextKeyWarning ?? []) : [];

  const kreaStatus = krea.connection?.status;
  // One source for each row's section, the heading and the tab's badge
  // (rowHelpers.connectedRows; review 11 of PR #203, copy NIT-2). A key is
  // set as the agent gate and the run read it (directRoute isKeySet).
  const rows = connectedRows({ apiKeys: saved.apiKeys, kreaStatus, health });

  const entries: Entry[] = [
    ...PROVIDER_KEYS.map((spec, order) => {
      const connected = rows[spec.key];
      return { id: spec.key, connected, reach: unlockCount(spec), order,
        matches: (q: string) => providerMatches(spec, q),
        render: (moved: boolean) => <KeyRow key={spec.key} spec={spec} configured={connected} moved={moved} /> };
    }),
    { id: KREA_ROW, connected: rows[KREA_ROW], reach: KREA_ACCOUNT_NODES.length, order: PROVIDER_KEYS.length,
      matches: (q: string) => 'krea sign-in workspace'.includes(q.trim().toLowerCase())
        || KREA_ACCOUNT_NODES.some((node) => matchesModelSearch(node, q)),
      render: () => <KreaSignInRow key={KREA_ROW} krea={krea} mode={saved.kreaConnectionMode} /> },
    { id: NOUS_ROW, connected: rows[NOUS_ROW], reach: NOUS_NODES.length, order: PROVIDER_KEYS.length + 1,
      matches: (q: string) => 'nous portal hermes'.includes(q.trim().toLowerCase())
        || NOUS_NODES.some((node) => matchesModelSearch(node, q)),
      render: () => <NousRow key={NOUS_ROW} summary={NOUS_NODES.map((node) => node.displayName).join(', ')} /> },
  ];

  // GM, PR #203 r19 item 6: a change made elsewhere updates the panel in
  // place, but never moves a row the person is in (focus inside it, or its
  // edit view open): that row's status changes where it stands, and it moves
  // once they leave it. `held` is the section each such row stays in, kept
  // in the store so the tab badge counts the rows as shown (r21 item 3).
  const held = useSettingsDraftStore((s) => s.heldRows);
  const setHeld = useCallback((next: (current: Record<string, boolean>) => Record<string, boolean>) => {
    useSettingsDraftStore.setState((state) => {
      const heldRows = next(state.heldRows);
      return heldRows === state.heldRows ? state : { heldRows };
    });
  }, []);
  // Nothing is held once the tab is gone (another tab, the panel closed).
  useEffect(() => () => useSettingsDraftStore.setState({ heldRows: {} }), []);
  const openRow = useSettingsDraftStore((s) => s.openRow);
  const placedRef = useRef<Record<string, boolean>>({});
  // GM, PR #203 r21 item 4: a key set or removed elsewhere is said once,
  // politely ("Replicate key saved."), when the read it asked for lands: the
  // first read to land after the latest signal (Settings drops every older
  // one), never a save of this tab's that lands first (review 11, copy
  // MEDIUM-1). This tab's own write's echo never reaches here
  // (store/settingsChangedSocket.ts).
  const toAnnounce = useRef(new Set<string>());
  const announceAfter = useRef<number | null>(null);
  const reads = useSettingsDraftStore((s) => s.reads);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (announceAfter.current === null || reads <= announceAfter.current) return;
    announceAfter.current = null;
    // The backend names only the keys whose value changed (main._changed_keys).
    const lines = [...toAnnounce.current].map((key) => keyChangedLine(key, isKeySet(saved.apiKeys, key)));
    toAnnounce.current.clear();
    if (lines.length === 0) return;
    // Emptied first, so the same line said twice is read twice.
    let said = 0;
    const emptied = requestAnimationFrame(() => {
      setAnnouncement('');
      said = requestAnimationFrame(() => setAnnouncement(lines.join(' ')));
    });
    return () => { cancelAnimationFrame(emptied); cancelAnimationFrame(said); };
  }, [reads, saved.apiKeys]);
  const activeRows = useCallback((): Set<string> => {
    const active = new Set<string>();
    const open = useSettingsDraftStore.getState().openRow;
    if (open?.mode === 'edit') active.add(open.id);
    const focused = typeof document !== 'undefined' ? document.activeElement : null;
    const row = focused && root.current?.contains(focused) ? focused.closest<HTMLElement>('[data-row]') : null;
    if (row?.dataset.row) active.add(row.dataset.row);
    return active;
  }, []);
  useEffect(() => {
    const heard = (event: Event) => {
      const detail = settingsSavedDetail(event);
      if (detail?.source === 'local') {
        // The person's own save or removal moves its row at once. A held
        // row it moves keeps keyboard focus: the row that lands takes it, as
        // a row their own save moves always does (review 10 of PR #203,
        // copy MEDIUM-1). The DOM is still the one they acted in here.
        const own = new Set(detail.keys ?? []);
        const { heldRows: current, saved: now } = useSettingsDraftStore.getState();
        const focused = typeof document !== 'undefined' ? document.activeElement : null;
        for (const id of own) {
          if (!Object.hasOwn(current, id)) continue;
          const row = root.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
          // Only when releasing it moves the row: a held row already shown
          // where its key now puts it stays mounted (copy LOW-1).
          if (row && focused && row.contains(focused)) focusRowIfItMoves(id, current[id], isKeySet(now?.apiKeys ?? {}, id));
        }
        if (own.size) {
          setHeld((held) => (Object.keys(held).some((id) => own.has(id))
            ? Object.fromEntries(Object.entries(held).filter(([id]) => !own.has(id))) : held));
        }
        return;
      }
      if (detail?.source !== 'remote' && detail?.source !== 'reconnect') return;
      for (const key of detail.keys ?? []) toAnnounce.current.add(key);
      if (toAnnounce.current.size) announceAfter.current = useSettingsDraftStore.getState().reads;
      // Before the read lands: hold each row the person is in where it is shown now.
      const hold: Record<string, boolean> = {};
      for (const id of activeRows()) if (id in placedRef.current) hold[id] = placedRef.current[id];
      if (Object.keys(hold).length) setHeld((current) => ({ ...hold, ...current }));
    };
    window.addEventListener(SETTINGS_SAVED_EVENT, heard);
    return () => window.removeEventListener(SETTINGS_SAVED_EVENT, heard);
  }, [activeRows, setHeld]);
  // Leaving a held row (focus out of it, its edit view closed) lets it move.
  const release = useCallback(() => {
    requestAnimationFrame(() => setHeld((current) => {
      if (Object.keys(current).length === 0) return current;
      const active = activeRows();
      const kept = Object.fromEntries(Object.entries(current).filter(([id]) => active.has(id)));
      return Object.keys(kept).length === Object.keys(current).length ? current : kept;
    }));
  }, [activeRows, setHeld]);
  useEffect(() => { release(); }, [openRow, release]);

  const q = query.trim();
  const visible = entries.filter((entry) => !q || entry.matches(q))
    .sort((a, b) => b.reach - a.reach || a.order - b.order);
  const shownConnected = (entry: Entry) => (Object.hasOwn(held, entry.id) ? held[entry.id] : entry.connected);
  const connected = visible.filter((entry) => shownConnected(entry));
  const toAdd = visible.filter((entry) => !shownConnected(entry));
  const anyConnected = entries.some((entry) => entry.connected);
  // A row that changed section since the last placement springs in where
  // it lands (--settings-spring, as a row's body opens): the placement is
  // compared during render (React's "state from the previous render").
  const placement = JSON.stringify(entries.map((entry) => [entry.id, shownConnected(entry)]));
  const [placed, setPlaced] = useState({ placement, moved: new Set<string>() });
  if (placed.placement !== placement) {
    const before = new Map(JSON.parse(placed.placement) as Array<[string, boolean]>);
    setPlaced({ placement, moved: new Set(entries.filter((entry) => before.has(entry.id)
      && before.get(entry.id) !== shownConnected(entry)).map((entry) => entry.id)) });
  }
  const moved = (entry: Entry) => placed.moved.has(entry.id);
  // Where each row is shown now, for the signal handler above to hold.
  useLayoutEffect(() => {
    placedRef.current = Object.fromEntries(JSON.parse(placement) as Array<[string, boolean]>);
  }, [placement]);

  // Read through a ref: Krea's status arriving mid-handoff must not cancel the focus below.
  const kreaStatusRef = useRef(kreaStatus);
  useEffect(() => { kreaStatusRef.current = kreaStatus; }, [kreaStatus]);

  // A setup link from a node or the library opens the row it's about, once per link.
  useEffect(() => {
    if (!setupTarget || handledTarget.current === setupTarget) return;
    handledTarget.current = setupTarget;
    queueMicrotask(() => setQuery(''));
    const id = setupTarget.kind === 'api-key' ? setupTarget.key : setupTarget.kind === 'krea-mcp' ? KREA_ROW : NOUS_ROW;
    const mode = setupTarget.kind === 'api-key' ? 'edit' : 'manage';
    const krea = kreaStatusRef.current;
    if (setupTarget.kind !== 'krea-mcp' || (krea && krea !== 'disconnected')) {
      useSettingsDraftStore.setState({ openRow: { id, mode } });
    }
    const frame = requestAnimationFrame(() => {
      const container = root.current;
      if (!container) return;
      const target = setupTarget.kind === 'api-key'
        ? [...container.querySelectorAll<HTMLElement>('[data-provider-key]')].find((element) => element.dataset.providerKey === setupTarget.key)
        : container.querySelector<HTMLElement>(`[data-provider-setup="${setupTarget.kind === 'krea-mcp' ? 'krea-mcp' : 'nous'}"] button`);
      target?.focus();
      target?.scrollIntoView?.({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [setupTarget]);

  return (
    <div ref={root} className="settings-providers" onBlur={release} onFocus={release}>
      {plaintextWarning.length > 0 && (
        <p className="settings-alert" role="alert">
          Keys for {plaintextWarning.join(', ')} are stored as plain text in the settings file.
          Remove them from that file and add them again here so they go into the macOS Keychain.
        </p>
      )}
      <label className="settings-search">
        <Search size={13} strokeWidth={2} aria-hidden="true" focusable="false" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          // Capture: claim Escape before the dock's own listener closes Settings.
          onKeyDownCapture={(event) => { if (event.key === 'Escape' && query) { event.preventDefault(); setQuery(''); } }}
          placeholder="Search providers or models (e.g. “Veo”)"
          aria-label="Search providers and models"
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <fieldset className="settings__fieldset settings__fieldset--providers" disabled={offline} {...offlineMark(offline)}>

      {connected.length > 0 && (
        <section aria-labelledby="settings-connected-heading">
          <div className="settings-label">
            <h3 id="settings-connected-heading">Connected · {connected.length}</h3>
            <button type="button" className="settings-label__action" disabled={health.loading}
              onClick={() => void health.checkConnections()}>{health.loading ? 'Checking…' : 'Check connections'}</button>
          </div>
          <div className="settings-list">{connected.map((entry) => entry.render(moved(entry)))}</div>
          {health.error && <p className="settings-row__error" role="alert">{health.error}</p>}
          {desktop?.credentials && <p className="settings-hint settings-list__note">Keys are stored in the macOS Keychain.</p>}
        </section>
      )}

      {toAdd.length > 0 && (
        <section aria-labelledby="settings-add-heading">
          <div className="settings-label">
            <h3 id="settings-add-heading">{anyConnected || q ? 'Add a provider' : 'Connect a provider'} · {toAdd.length}</h3>
          </div>
          <div className="settings-list">{toAdd.map((entry) => entry.render(moved(entry)))}</div>
          {!anyConnected && !q && (
            <p className="settings-hint settings-list__note">Sorted by how many nodes each one runs. Keys stay on this computer.</p>
          )}
        </section>
      )}

      {visible.length === 0 && (
        <div className="settings-empty" role="status">
          <p>No provider runs “{q}”.</p>
          <p className="settings-hint">fal.ai, Replicate and OpenRouter have universal nodes that reach models not listed here.</p>
        </div>
      )}
      </fieldset>
      <span className="settings-sr" role="status">{q ? `${plural(visible.length, 'provider')} match` : ''}</span>
      <span className="settings-sr" role="status" aria-live="polite" data-key-changes="">{announcement}</span>
    </div>
  );
}
