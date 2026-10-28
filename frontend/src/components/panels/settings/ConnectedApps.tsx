import { useState } from 'react';
import {
  createConnectedApp,
  revokeConnectedApp,
  setConnectedAppColor,
  setConnectedAppLimit,
  type AgentClientOption,
  type AgentSetup,
  type ConnectedApp,
  type OutsideSpend,
} from '../../../lib/api';
import { failureMessage } from '../../../lib/errorCopy';

const APP_LIMIT_CHOICES = [1, 2, 5, 10, 25, 50] as const;
/** Cursor colors on offer. Bright enough to read on the dark canvas; null keeps the one derived from the app's id. */
const AGENT_COLORS = ['#3FC1A5', '#7AD3FF', '#B392F0', '#FF6B9A', '#FF9F43', '#F2C14E', '#C3E86B'] as const;
/** Shown until the backend's list arrives, and kept in step with services/agent_connect.CLIENTS. */
const FALLBACK_CLIENTS: AgentClientOption[] = [
  { id: 'hermes', label: 'Hermes' },
  { id: 'openclaw', label: 'OpenClaw' },
  { id: 'claude-desktop', label: 'Claude Desktop' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'codex', label: 'Codex' },
  { id: 'other', label: 'Other MCP client' },
];

function usd(value: number) {
  return value < 1 ? `$${value.toFixed(2)}` : `$${value}`;
}

function defaultName(client: AgentClientOption | undefined) {
  if (!client) return '';
  return client.id === 'other' ? '' : `My ${client.label}`;
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

function ColorPicker({ value, disabled, onChange }: {
  value: string | null;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <span className="settings-apps__colors" role="radiogroup" aria-label="Cursor color">
      <button type="button" role="radio" aria-checked={value === null} aria-label="Automatic color" disabled={disabled}
        className="settings-apps__swatch settings-apps__swatch--auto" onClick={() => onChange(null)} />
      {AGENT_COLORS.map((color) => (
        <button key={color} type="button" role="radio" aria-checked={value === color} aria-label={`Color ${color}`}
          disabled={disabled} className="settings-apps__swatch" style={{ ['--swatch' as string]: color }}
          onClick={() => onChange(color)} />
      ))}
    </span>
  );
}

function CopyBlock({ label, where, text, onError }: {
  label: string;
  where: string;
  text: string;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      onError('Couldn’t copy. Select the text and copy it yourself.');
    }
  };
  return (
    <div className="settings-apps__block">
      <div className="settings-apps__block-head">
        <span className="settings-pref__description">{where}</span>
        <button type="button" className="settings__button" aria-label={`Copy ${label}`} onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="settings-apps__code" aria-label={label} tabIndex={0}>{text}</pre>
    </div>
  );
}

/** What to paste or run in the agent's app. It names the token's file, never the token. */
function SetupPanel({ name, setup, onDone, onError }: {
  name: string;
  setup: AgentSetup;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="settings-apps__setup" role="region" aria-label={`Set up ${name} in ${setup.label}`}>
      <p className="settings-apps__setup-title">Set up {name} in {setup.label}</p>
      {setup.tokenFile && (
        <p className="settings-hint">
          Nebula saved {name}&rsquo;s token in <code>{setup.tokenFile}</code>, which only your macOS user can read.
          The config points at that file, so it holds no secret.
        </p>
      )}
      <ol className="settings-apps__steps">
        {setup.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      <CopyBlock label={`${setup.label} config`} where={setup.where} text={setup.snippet} onError={onError} />
      {setup.alternative && (
        <CopyBlock label={`${setup.label} alternative config`} where={`Or: ${setup.alternative.where}`}
          text={setup.alternative.snippet} onError={onError} />
      )}
      {setup.cli && (
        <CopyBlock label={`${setup.label} nebula command`}
          where="Or let Nebula's CLI do it (it checks the token first and asks before changing anything)"
          text={setup.cli} onError={onError} />
      )}
      <ul className="settings-apps__warnings" aria-label="Before you paste it">
        {setup.warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>
      <div>
        <button type="button" className="settings__button settings__button--primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

/** Settings > Connect your agent: the person's own agent apps (Hermes, OpenClaw,
 * Claude, Cursor, Codex...) each get a token, a name and color for their canvas
 * cursor, and a daily limit (backend services/app_tokens.py), plus the exact
 * config to paste (services/agent_connect.py). Every app still counts inside
 * "Agents outside Nebula chats", so a token never adds headroom. */
export function ConnectedApps({ view, loadError, onChanged }: {
  view: OutsideSpend | null;
  loadError: string | null;
  onChanged: () => void;
}) {
  const clients = view?.connect?.clients?.length ? view.connect.clients : FALLBACK_CLIENTS;
  const available = view?.connect?.available ?? true;
  const [clientId, setClientId] = useState(clients[0].id);
  const [name, setName] = useState(defaultName(clients[0]));
  const [nameTouched, setNameTouched] = useState(false);
  const [color, setColor] = useState<string | null>(null);
  const [limit, setLimit] = useState<number | null>(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ name: string; token: string; tokenFile: string | null; setup?: AgentSetup } | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const [recoloring, setRecoloring] = useState<string | null>(null);
  const labelOf = (id: string | null | undefined) => clients.find((client) => client.id === id)?.label;

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (exc) {
      setError(failureMessage(exc, "Couldn't update the connected apps."));
    } finally {
      setBusy(false);
    }
  };

  const pickClient = (id: string) => {
    setClientId(id);
    if (!nameTouched) setName(defaultName(clients.find((client) => client.id === id)));
  };

  const create = () => run(async () => {
    const result = await createConnectedApp(name.trim(), limit, available ? { client: clientId, color } : { color });
    setMade({ name: result.app.name, token: result.token, tokenFile: result.tokenFile ?? null, setup: result.setup });
    setRevealed(false);
    setCopied(false);
    setNameTouched(false);
    setName(defaultName(clients.find((client) => client.id === clientId)));
    setColor(null);
  });

  const copyToken = async () => {
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
        <h4 id="settings-apps-heading" className="settings-apps__title">Connect your agent</h4>
        <p className="settings-hint" id="settings-apps-help">
          Let an agent you already use work on this canvas through Nebula&rsquo;s MCP server. It keeps its own memory
          and tools, shows up as a named cursor, and gets its own daily limit inside &ldquo;Agents outside Nebula
          chats&rdquo;. Revoke a token you no longer use.
        </p>
      </div>
      {loadError && <p className="settings-row__error" role="alert">{loadError}</p>}
      {!available && view?.connect?.reason && (
        <p className="settings-hint" role="note">{view.connect.reason} You can still make a plain token below.</p>
      )}
      <div className="settings-list">
        {apps.map((app) => (
          <div className="settings-pref settings-model-limit" key={app.id} data-testid="settings-app-row">
            <span className="settings-pref__text">
              <span className="settings-pref__title settings-apps__app-name">
                <button type="button" className="settings-apps__dot-button" disabled={busy}
                  aria-label={`Change the cursor color for ${app.name}`} aria-expanded={recoloring === app.id}
                  onClick={() => setRecoloring(recoloring === app.id ? null : app.id)}>
                  <span className={`settings-apps__dot${app.color ? '' : ' settings-apps__swatch--auto'}`} aria-hidden="true"
                    style={app.color ? { ['--swatch' as string]: app.color } : undefined} />
                </button>
                {app.name}
              </span>
              <span className="settings-pref__description">
                {labelOf(app.client) ? `${labelOf(app.client)} · ` : ''}
                ${app.spentUsd.toFixed(2)} in the last 24 h
                {app.kreaPlanRuns > 0 && `, ${app.kreaPlanRuns} Krea plan runs`}
              </span>
            </span>
            <span className="settings-model-limit__controls">
              <AppLimitSelect label={`${app.name} daily limit`} value={app.dailyUsd} disabled={busy}
                onChange={(dailyUsd) => void run(async () => { await setConnectedAppLimit(app.id, dailyUsd); })} />
              {armed === app.id ? (
                <span className="settings__remove-confirm">
                  <button type="button" className="settings__button settings__confirm--danger" disabled={busy}
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
            {recoloring === app.id && (
              <span className="settings-model-limit__controls" role="group" aria-label={`Cursor color for ${app.name}`}>
                <ColorPicker value={app.color ?? null} disabled={busy}
                  onChange={(next) => void run(async () => {
                    await setConnectedAppColor(app.id, next);
                    setRecoloring(null);
                  })} />
              </span>
            )}
          </div>
        ))}
        <form className="settings-pref settings-model-limit settings-apps__new"
          onSubmit={(event) => { event.preventDefault(); if (name.trim()) void create(); }}>
          <span className="settings-pref__text">
            <span className="settings-pref__title">Add an agent</span>
            <span className="settings-pref__description">
              Pick the app it runs in, a name for its cursor, a color and a daily limit
            </span>
          </span>
          <span className="settings-model-limit__controls">
            {available && (
              <select aria-label="Agent app" className="settings__select settings__select--compact settings-apps__client"
                value={clientId} disabled={busy} onChange={(event) => pickClient(event.target.value)}>
                {clients.map((client) => <option key={client.id} value={client.id}>{client.label}</option>)}
              </select>
            )}
            <input id="settings-app-name" aria-label="Agent name" className="settings-folder__input settings-apps__name"
              type="text" placeholder="My Hermes" maxLength={60} value={name} disabled={busy}
              onChange={(event) => { setName(event.target.value); setNameTouched(true); }} />
            <ColorPicker value={color} disabled={busy} onChange={setColor} />
            <AppLimitSelect label="New agent daily limit" value={limit} disabled={busy} onChange={setLimit} />
            <button type="submit" className="settings__button settings__button--primary" disabled={busy || !name.trim()}>
              {available ? 'Connect' : 'Create token'}
            </button>
          </span>
        </form>
      </div>
      {made?.setup && (
        <SetupPanel name={made.name} setup={made.setup} onDone={() => setMade(null)} onError={setError} />
      )}
      {made && !made.setup && (
        <div className="settings-apps__token" role="status">
          {made.tokenFile ? (
            <p className="settings-hint">
              Nebula saved the token for {made.name} in <code>{made.tokenFile}</code>, which only your macOS user can
              read. Give Nebula&rsquo;s MCP server that path as <code>NEBULA_APP_TOKEN_FILE</code>, or have a script
              read the file. Revoking deletes it.
            </p>
          ) : (
            <p className="settings-hint">Token for {made.name}. Nebula keeps only a fingerprint and can&rsquo;t show it again.</p>
          )}
          {/* An app that can't read a file needs the value itself. That copy is outside Nebula's
              control, so it stays hidden until asked for. */}
          {revealed || !made.tokenFile ? (
            <div className="settings-apps__token-row">
              <input className="settings-folder__input" readOnly aria-label={`Token for ${made.name}`} value={made.token}
                onFocus={(event) => event.target.select()} />
              <button type="button" className="settings__button" onClick={() => void copyToken()}>{copied ? 'Copied' : 'Copy'}</button>
              <button type="button" className="settings__button settings__button--ghost" onClick={() => setMade(null)}>Done</button>
            </div>
          ) : (
            <div className="settings-apps__token-row">
              <button type="button" className="settings__button" onClick={() => setRevealed(true)}>
                Show the token for an app that can&rsquo;t read a file
              </button>
              <button type="button" className="settings__button settings__button--ghost" onClick={() => setMade(null)}>Done</button>
            </div>
          )}
        </div>
      )}
      {error && <p className="settings-row__error" role="alert">{error}</p>}
    </div>
  );
}
