import { useEffect, useRef, useState } from 'react';
import {
  getKreaConnection, connectKrea, checkKreaConnection, disconnectKrea, getKreaPlans, startKreaTrial,
  isKreaAuthorizationUrl, type KreaConnectionMode, type KreaConnectionState, type KreaPlans,
} from '../../lib/kreaConnection';
import { useUIStore } from '../../store/uiStore';
import '../../styles/krea-connection.css';

const LABELS: Record<KreaConnectionState['status'], string> = {
  disconnected: 'Not connected', connecting: 'Waiting for Krea sign-in…',
  connected: 'Connected', needs_auth: 'Sign-in needed', error: 'Connection unavailable',
};

const number = new Intl.NumberFormat('en-US');

/** Krea's plans, loaded on request. Links open Krea's own pricing or checkout
 * pages in the browser; nothing here charges or changes the subscription. */
function KreaPlansSection() {
  const [plans, setPlans] = useState<KreaPlans | null>(null);
  const [trialUrl, setTrialUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (value) { setError(value instanceof Error ? value.message : 'Krea plans are unavailable.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="krea-connection__plans" aria-label="Krea plans">
      <div className="krea-connection__actions">
        <button type="button" disabled={busy} onClick={() => void run(async () => setPlans(await getKreaPlans()))}>
          {busy && !plans ? 'Loading plans…' : plans ? 'Refresh plans' : 'Show Krea plans'}
        </button>
        {plans?.manageUrl && <a href={plans.manageUrl} target="_blank" rel="noopener noreferrer">Manage plan</a>}
      </div>
      {plans && <ul className="krea-connection__plan-list">
        {plans.plans.map((plan) => (
          <li key={plan.id ?? plan.name} data-prominent={plan.prominent || undefined}>
            <span className="krea-connection__plan-name">{plan.name}</span>
            <span>{plan.price != null ? `$${plan.price}/mo` : ''}
              {plan.annualPrice != null ? ` · $${plan.annualPrice}/mo yearly` : ''}</span>
            <span>{plan.units != null ? `${number.format(plan.units)} compute units` : ''}</span>
            {plan.checkoutUrl && <a href={plan.checkoutUrl} target="_blank" rel="noopener noreferrer">View on Krea</a>}
          </li>
        ))}
      </ul>}
      {plans?.trialAvailable && !trialUrl && <button type="button" disabled={busy}
        onClick={() => void run(async () => setTrialUrl(await startKreaTrial()))}>Start a free Pro trial</button>}
      {trialUrl && <a className="krea-connection__sign-in" href={trialUrl} target="_blank" rel="noopener noreferrer">
        Open trial checkout</a>}
      {trialUrl && <p>Krea asks for a card on its checkout page. The trial converts to Pro unless you cancel.</p>}
      {error && <p className="krea-connection__error" role="alert">{error}</p>}
    </div>
  );
}

export function KreaConnectionCard({ mode, onModeChange }: {
  mode: KreaConnectionMode;
  onModeChange: (value: KreaConnectionMode) => void;
}) {
  const connection = useUIStore((s) => s.settingsCache.kreaConnection);
  const setConnection = useUIStore((s) => s.setKreaConnection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const version = requestVersion.current;
    getKreaConnection().then((state) => {
      if (!cancelled && requestVersion.current === version) setConnection(state);
    }).catch(() => {
      if (!cancelled && requestVersion.current === version) setError('Could not check Krea. Check that the Nebula backend is available.');
    });
    return () => { cancelled = true; };
  }, [setConnection]);

  useEffect(() => {
    if (connection?.status !== 'connecting') return;
    let cancelled = false;
    const version = requestVersion.current;
    const timer = window.setTimeout(() => {
      getKreaConnection().then((state) => {
        if (!cancelled && requestVersion.current === version) setConnection(state);
      }).catch(() => {
        if (!cancelled && requestVersion.current === version) {
          setError('Could not check sign-in progress. Use Check connection to retry.');
          setConnection({ status: 'error' });
        }
      });
    }, 2000);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [connection, setConnection]);

  async function act(action: () => Promise<KreaConnectionState>) {
    requestVersion.current += 1;
    setBusy(true);
    setError(null);
    setLaunchError(null);
    try { setConnection(await action()); }
    catch (value) { setError(value instanceof Error ? value.message : 'Could not update the Krea connection.'); }
    finally { setBusy(false); }
  }

  function startConnect() {
    const bridge = window.nebulaDesktop?.kreaLinks;
    let signInWindow: Window | null = null;
    if (!bridge) {
      // Reserve during the click, before registration can consume user activation.
      // Setting opener directly preserves the handle without exposing Nebula to Krea.
      try {
        signInWindow = window.open('about:blank', '_blank');
        if (signInWindow) {
          signInWindow.opener = null;
          try {
            signInWindow.document.title = 'Opening Krea sign-in…';
            if (signInWindow.document.body) signInWindow.document.body.textContent = 'Opening Krea sign-in…';
          } catch { /* A host may restrict decoration while still allowing navigation. */ }
        }
      } catch {
        signInWindow?.close();
        signInWindow = null;
      }
    }

    void act(async () => {
      let state: KreaConnectionState;
      try { state = await connectKrea(); }
      catch (value) { signInWindow?.close(); throw value; }
      const url = state.authorizationUrl;
      if (state.status !== 'connecting' || !url || !isKreaAuthorizationUrl(url)) {
        signInWindow?.close();
        if (state.status === 'connecting') setLaunchError('Could not prepare Krea sign-in. Use Restart sign-in to try again.');
        return state;
      }
      try {
        if (bridge) {
          const result = await bridge.open(url);
          if (!result.ok) throw new Error('Browser launch failed');
        } else {
          if (!signInWindow || signInWindow.closed) throw new Error('Sign-in tab unavailable');
          signInWindow.location.replace(url);
        }
      } catch {
        signInWindow?.close();
        setLaunchError('Krea sign-in did not open. Click Open Krea sign-in below to continue.');
      }
      return state;
    });
  }

  const authUrl = connection?.authorizationUrl && isKreaAuthorizationUrl(connection.authorizationUrl)
    ? connection.authorizationUrl : null;

  return (
    <section className="krea-connection" aria-label="Krea MCP connection">
      <div className="krea-connection__header"><strong>Krea MCP</strong>
        <span role="status">{connection ? LABELS[connection.status] : 'Checking connection…'}</span>
      </div>
      <p>Sign in to use the Krea workspace you choose during consent. OAuth generation uses that workspace’s compute units.</p>
      <div className="krea-connection__actions">
        <button type="button" disabled={busy} onClick={startConnect}>
          {busy ? 'Working…' : connection?.status === 'connecting' ? 'Restart sign-in'
            : connection?.status === 'connected' ? 'Reconnect to Krea' : 'Connect to Krea'}
        </button>
        <button type="button" disabled={busy} onClick={() => void act(checkKreaConnection)}>Check connection</button>
        {connection && connection.status !== 'disconnected' && <button type="button" disabled={busy}
          onClick={() => void act(disconnectKrea)}>Disconnect</button>}
      </div>
      {connection?.status === 'connecting' && <p>Finish signing in in your browser, then return here. If no page opened, use Open Krea sign-in below.</p>}
      {authUrl && <a className="krea-connection__sign-in" href={authUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => {
        const bridge = window.nebulaDesktop?.kreaLinks;
        if (!bridge) return;
        event.preventDefault();
        void bridge.open(authUrl).then((result) => {
          if (!result.ok) setError('Could not open Krea sign-in in your browser.');
        }).catch(() => setError('Could not open Krea sign-in in your browser.'));
      }}>Open Krea sign-in</a>}
      {connection?.status === 'connecting' && launchError && <p className="krea-connection__error" role="alert">{launchError}</p>}
      {(error || connection?.error) && <p className="krea-connection__error" role="alert">{error || connection?.error}</p>}
      {connection?.status === 'connected' && <KreaPlansSection />}
      <p>To change workspaces, disconnect and sign in again. Connecting never changes existing nodes or starts generation.</p>
      <label className="krea-connection__default">New Krea model nodes
        <select aria-label="Default Krea connection for new nodes" value={mode}
          onChange={(event) => onModeChange(event.target.value === 'mcp' ? 'mcp' : 'api-token')}>
          <option value="api-token">API token · API balance</option>
          <option value="mcp">Krea sign-in · workspace compute</option>
        </select>
      </label>
      <p>Save Settings to apply this default to future catalog nodes. Each node keeps its chosen connection for reruns. Older saved nodes keep using the API token until you switch them.</p>
    </section>
  );
}
