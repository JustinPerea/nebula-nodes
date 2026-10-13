import { useState } from 'react';
import {
  createConnectedApp,
  revokeConnectedApp,
  setConnectedAppLimit,
  type ConnectedApp,
  type OutsideSpend,
} from '../../../lib/api';

const APP_LIMIT_CHOICES = [1, 2, 5, 10, 25, 50] as const;

function usd(value: number) {
  return value < 1 ? `$${value.toFixed(2)}` : `$${value}`;
}

function AppLimitSelect({ id, label, value, disabled, onChange }: {
  id?: string;
  label?: string;
  value: number | null;
  disabled: boolean;
  onChange: (value: number | null) => void;
}) {
  const current = value === null ? 'none' : String(value);
  const custom = value !== null && !(APP_LIMIT_CHOICES as readonly number[]).includes(value);
  return (
    <select id={id} aria-label={label} className="settings__select settings__select--compact" value={current}
      disabled={disabled} onChange={(event) => onChange(event.target.value === 'none' ? null : Number(event.target.value))}>
      {custom && <option value={current}>{usd(value!)} / 24 h</option>}
      {APP_LIMIT_CHOICES.map((choice) => <option key={choice} value={String(choice)}>{usd(choice)} / 24 h</option>)}
      <option value="none">Shared budget only</option>
    </select>
  );
}

/** Outside apps the person gave their own token (backend services/app_tokens.py).
 * Each gets a line with its 24-hour spend and an optional limit, and still
 * counts inside "Agents outside Nebula chats", so a token never adds headroom. */
export function ConnectedApps({ view, loadError, onChanged }: {
  view: OutsideSpend | null;
  loadError: string | null;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [limit, setLimit] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
    } finally {
      setBusy(false);
    }
  };

  const create = () => run(async () => {
    const result = await createConnectedApp(name.trim(), limit);
    setMade({ name: result.app.name, token: result.token });
    setCopied(false);
    setName('');
    setLimit(null);
  });

  const copy = async () => {
    if (!made) return;
    try {
      await navigator.clipboard.writeText(made.token);
      setCopied(true);
    } catch {
      setError('Couldn’t copy. Select the token and copy it yourself.');
    }
  };

  const apps: ConnectedApp[] = view?.apps ?? [];
  return (
    <div className="settings-apps" aria-labelledby="settings-apps-heading" role="group">
      <div className="settings-apps__head">
        <h4 id="settings-apps-heading" className="settings-apps__title">Connected apps</h4>
        <p className="settings-hint" id="settings-apps-help">
          Give an outside app its own token to see what it spends and give it its own daily limit. Put the token in the
          app&rsquo;s Nebula MCP server config as <code>NEBULA_APP_TOKEN</code>. Its runs still count toward
          &ldquo;Agents outside Nebula chats&rdquo;. Anyone who can read that config file can spend as the app, so revoke
          a token you no longer use.
        </p>
      </div>
      {loadError && <p className="settings-row__error" role="alert">{loadError}</p>}
      <div className="settings-list">
        {apps.map((app) => (
          <div className="settings-pref settings-model-limit" key={app.id} data-testid="settings-app-row">
            <span className="settings-pref__text">
              <span className="settings-pref__title">{app.name}</span>
              <span className="settings-pref__description">
                ${app.spentUsd.toFixed(2)} in the last 24 h
                {app.kreaPlanRuns > 0 && `, ${app.kreaPlanRuns} Krea plan runs`}
              </span>
            </span>
            <span className="settings-model-limit__controls">
              <AppLimitSelect label={`${app.name} daily limit`} value={app.dailyUsd} disabled={busy}
                onChange={(dailyUsd) => void run(async () => { await setConnectedAppLimit(app.id, dailyUsd); })} />
              {armed === app.id ? (
                <span className="settings__remove-confirm">
                  <button type="button" className="settings__button settings__remove-key--armed" disabled={busy}
                    onClick={() => void run(async () => { await revokeConnectedApp(app.id); setArmed(null); })}>
                    Revoke {app.name}
                  </button>
                  <button type="button" className="settings__button settings__button--ghost" disabled={busy}
                    onClick={() => setArmed(null)}>Keep</button>
                </span>
              ) : (
                <button type="button" className="settings__button" disabled={busy}
                  aria-label={`Revoke the token for ${app.name}`} onClick={() => setArmed(app.id)}>Revoke</button>
              )}
            </span>
          </div>
        ))}
        <form className="settings-pref settings-model-limit settings-apps__new"
          onSubmit={(event) => { event.preventDefault(); if (name.trim()) void create(); }}>
          <span className="settings-pref__text">
            <label className="settings-pref__title" htmlFor="settings-app-name">Add an app</label>
            <span className="settings-pref__description">A name you&rsquo;ll recognize, and an optional daily limit</span>
          </span>
          <span className="settings-model-limit__controls">
            <input id="settings-app-name" className="settings-folder__input settings-apps__name" type="text"
              placeholder="Claude Desktop" maxLength={60} value={name} disabled={busy}
              onChange={(event) => setName(event.target.value)} />
            <AppLimitSelect label="New app daily limit" value={limit} disabled={busy} onChange={setLimit} />
            <button type="submit" className="settings__button settings__button--primary" disabled={busy || !name.trim()}>
              Create token
            </button>
          </span>
        </form>
      </div>
      {made && (
        <div className="settings-apps__token" role="status">
          <p className="settings-hint">
            Token for {made.name}. Copy it now: Nebula keeps only a fingerprint and can&rsquo;t show it again.
          </p>
          <div className="settings-apps__token-row">
            <input className="settings-folder__input" readOnly aria-label={`Token for ${made.name}`} value={made.token}
              onFocus={(event) => event.target.select()} />
            <button type="button" className="settings__button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
            <button type="button" className="settings__button settings__button--ghost" onClick={() => setMade(null)}>Done</button>
          </div>
        </div>
      )}
      {error && <p className="settings-row__error" role="alert">{error}</p>}
    </div>
  );
}
