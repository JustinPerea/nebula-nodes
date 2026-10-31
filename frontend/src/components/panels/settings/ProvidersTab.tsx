import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { NODE_DEFINITIONS } from '../../../constants/nodeDefinitions';
import { matchesModelSearch } from '../../../lib/modelDiscovery';
import { supportsKreaAccount } from '../../../lib/kreaConnection';
import { providerCheckIsCurrent } from '../../../lib/providerReadiness';
import { PROVIDER_KEYS, providerMatches, unlockCount } from '../../../lib/providerCatalog';
import { useSettingsDraftStore, type SettingsDraft } from '../../../store/settingsDraftStore';
import { useUIStore } from '../../../store/uiStore';
import { useProviderReadinessStore } from '../../../store/providerReadinessStore';
import { offlineMark, useBackendOffline } from '../../../lib/useBackendOffline';
import { KeyRow } from './KeyRow';
import { KreaSignInRow } from './KreaSignInRow';
import { NousRow } from './NousRow';
import { KREA_ROW, NOUS_ROW } from './rowHelpers';
import { useKreaConnection } from './useKreaConnection';
import { LineText } from '../../LineText';
import { PersonLockLine } from '../../PersonLock';
import { usePersonLock } from '../../../hooks/usePersonLock';

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
  render: () => ReactNode;
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
  // PR #204 round 10 (GM r15, r17 item 1): every key's Add, Replace, Save and Remove, and the
  // Krea sign-in's, are the person's alone. Round 11 (GM r18 a): one lock for the group, its line
  // directly under the first heading ("Connect a provider · 23"), every row described by it.
  const keyLock = usePersonLock('change provider settings');
  const setupTarget = useUIStore((s) => s.settingsProviderTarget);
  const root = useRef<HTMLDivElement>(null);
  // Offline (GM, round 16 of PR #114): the search stays usable; everything
  // that edits sits in the disabled fieldset below it.
  const offline = useBackendOffline();
  const handledTarget = useRef<typeof setupTarget>(null);
  const desktop = typeof window !== 'undefined' ? window.nebulaDesktop : undefined;
  const plaintextWarning = desktop?.credentials ? (desktop.plaintextKeyWarning ?? []) : [];

  const kreaStatus = krea.connection?.status;
  const nousEntry = health.providers.Nous;
  const nousConnected = providerCheckIsCurrent(nousEntry, health.checkedAt) && nousEntry.configured;

  const entries: Entry[] = [
    ...PROVIDER_KEYS.map((spec, order) => {
      const connected = !!saved.apiKeys[spec.key]?.trim();
      return { id: spec.key, connected, reach: unlockCount(spec), order,
        matches: (q: string) => providerMatches(spec, q),
        render: () => <KeyRow key={spec.key} spec={spec} configured={connected} lock={keyLock} /> };
    }),
    { id: KREA_ROW, connected: !!kreaStatus && kreaStatus !== 'disconnected', reach: KREA_ACCOUNT_NODES.length, order: PROVIDER_KEYS.length,
      matches: (q: string) => 'krea sign-in workspace'.includes(q.trim().toLowerCase())
        || KREA_ACCOUNT_NODES.some((node) => matchesModelSearch(node, q)),
      render: () => <KreaSignInRow key={KREA_ROW} krea={krea} mode={saved.kreaConnectionMode} lock={keyLock} /> },
    { id: NOUS_ROW, connected: nousConnected, reach: NOUS_NODES.length, order: PROVIDER_KEYS.length + 1,
      matches: (q: string) => 'nous portal hermes'.includes(q.trim().toLowerCase())
        || NOUS_NODES.some((node) => matchesModelSearch(node, q)),
      render: () => <NousRow key={NOUS_ROW} summary={NOUS_NODES.map((node) => node.displayName).join(', ')} /> },
  ];

  const q = query.trim();
  const visible = entries.filter((entry) => !q || entry.matches(q))
    .sort((a, b) => b.reach - a.reach || a.order - b.order);
  const connected = visible.filter((entry) => entry.connected);
  const toAdd = visible.filter((entry) => !entry.connected);
  const anyConnected = entries.some((entry) => entry.connected);

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
    <div ref={root} className="settings-providers">
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
          <PersonLockLine lock={keyLock} place="heading" />
          <div className="settings-list">{connected.map((entry) => entry.render())}</div>
          {health.error && <p className="settings-row__error" role="alert"><LineText text={health.error} /></p>}
          {desktop?.credentials && <p className="settings-hint settings-list__note">Keys are stored in the macOS Keychain.</p>}
        </section>
      )}

      {toAdd.length > 0 && (
        <section aria-labelledby="settings-add-heading">
          <div className="settings-label">
            <h3 id="settings-add-heading">{anyConnected || q ? 'Add a provider' : 'Connect a provider'} · {toAdd.length}</h3>
          </div>
          {connected.length === 0 && <PersonLockLine lock={keyLock} place="heading" />}
          <div className="settings-list">{toAdd.map((entry) => entry.render())}</div>
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
    </div>
  );
}
