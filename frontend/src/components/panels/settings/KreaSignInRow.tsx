import { useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { getKreaPlans, startKreaTrial, isKreaAuthorizationUrl, type KreaConnectionMode, type KreaConnectionState, type KreaPlans } from '../../../lib/kreaConnection';
import { useSettingsDraftStore } from '../../../store/settingsDraftStore';
import { saveField } from '../../../lib/settingsWrites';
import { ProviderRow } from './ProviderRow';
import { KREA_ROW, type RowTone } from './rowHelpers';
import type { KreaController } from './useKreaConnection';
import '../../../styles/krea-connection.css';
import { failureMessage } from '../../../lib/errorCopy';

const STATUS: Record<KreaConnectionState['status'], { label: string; tone: RowTone }> = {
  disconnected: { label: 'Not signed in', tone: 'idle' },
  connecting: { label: 'Waiting for sign-in…', tone: 'busy' },
  connected: { label: 'Signed in', tone: 'ok' },
  needs_auth: { label: 'Sign-in needed', tone: 'warn' },
  error: { label: 'Connection unavailable', tone: 'warn' },
};

const number = new Intl.NumberFormat('en-US');


/** Krea's plans, loaded on request. Links open Krea's own pricing or checkout
 * pages in the browser; nothing here charges or changes the subscription. */
function KreaPlans() {
  const [plans, setPlans] = useState<KreaPlans | null>(null);
  const [trialUrl, setTrialUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (value) { setError(failureMessage(value, "Couldn't load the Krea plans.")); }
    finally { setBusy(false); }
  }

  if (!plans) {
    return (
      <>
        <button type="button" className="settings__button settings__button--ghost" disabled={busy}
          onClick={() => void run(async () => setPlans(await getKreaPlans()))}>{busy ? 'Loading plans…' : 'Show plans'}</button>
        {error && <p className="settings-row__error" role="alert">{error}</p>}
      </>
    );
  }
  return (
    <div className="krea-connection__plans" aria-label="Krea plans">
      <ul className="krea-connection__plan-list">
        {plans.plans.map((plan) => (
          <li key={plan.id ?? plan.name} data-prominent={plan.prominent || undefined}>
            <span className="krea-connection__plan-name">{plan.name}</span>
            <span>{plan.price != null ? `$${plan.price}/mo` : ''}
              {plan.annualPrice != null ? ` · $${plan.annualPrice}/mo yearly` : ''}</span>
            <span>{plan.units != null ? `${number.format(plan.units)} compute units` : ''}</span>
            {plan.checkoutUrl && <a href={plan.checkoutUrl} target="_blank" rel="noopener noreferrer">View on Krea</a>}
          </li>
        ))}
      </ul>
      <div className="settings-row__buttons">
        {plans.manageUrl && <a className="settings__button settings__button--ghost" href={plans.manageUrl} target="_blank" rel="noopener noreferrer">Manage plan ↗</a>}
        {plans.trialAvailable && !trialUrl && <button type="button" className="settings__button settings__button--ghost" disabled={busy}
          onClick={() => void run(async () => setTrialUrl(await startKreaTrial()))}>Start a free Pro trial</button>}
        {trialUrl && <a className="settings__button" href={trialUrl} target="_blank" rel="noopener noreferrer">Open trial checkout ↗</a>}
      </div>
      {trialUrl && <p className="settings-hint">Krea asks for a card on its checkout page. The trial converts to Pro unless you cancel.</p>}
      {error && <p className="settings-row__error" role="alert">{error}</p>}
    </div>
  );
}

/** Which connection new Krea model nodes start with. Existing nodes keep theirs. */
function KreaDefault({ mode }: { mode: KreaConnectionMode }) {
  const pending = useSettingsDraftStore((s) => !!s.pending.kreaConnectionMode);
  const justSaved = useSettingsDraftStore((s) => s.justSaved === 'kreaConnectionMode');
  const error = useSettingsDraftStore((s) => s.errors.kreaConnectionMode);
  return (
    <div className="settings-krea-default">
      <label className="settings-hint" htmlFor="settings-krea-default">New Krea nodes use</label>
      <div className="settings-krea-default__control">
        <select id="settings-krea-default" className="settings__select" aria-label="Default Krea connection for new nodes"
          value={mode} disabled={pending}
          onChange={(event) => void saveField('kreaConnectionMode', event.target.value === 'mcp' ? 'mcp' : 'api-token')}>
          <option value="api-token">API token · API balance</option>
          <option value="mcp">Krea sign-in · workspace compute</option>
        </select>
        <span className="settings-saved" role="status">{justSaved ? 'Saved' : ''}</span>
      </div>
      {error && <p className="settings-row__error" role="alert">{error}</p>}
      <p className="settings-hint">Nodes you already placed keep their connection.</p>
    </div>
  );
}

export function KreaSignInRow({ krea, mode }: { krea: KreaController; mode: KreaConnectionMode }) {
  const open = useSettingsDraftStore((s) => s.openRow?.id === KREA_ROW);
  const { connection, busy, error, launchError } = krea;
  const status = connection?.status;
  const signedIn = status === 'connected';
  const started = !!status && status !== 'disconnected';
  const trigger = useRef<HTMLButtonElement>(null);
  const setOpen = (on: boolean) => useSettingsDraftStore.setState({ openRow: on ? { id: KREA_ROW, mode: 'manage' } : null });
  const authUrl = connection?.authorizationUrl && isKreaAuthorizationUrl(connection.authorizationUrl)
    ? connection.authorizationUrl : null;
  const shown = status ? STATUS[status] : { label: 'Checking…', tone: 'busy' as const };
  const problem = (status === 'connecting' && launchError) || error || connection?.error;
  // A pending sign-in or a problem opens the row by itself: the fallback link
  // and the error are what you need next, so they can't hide behind ⋯.
  const showBody = started ? open || status === 'connecting' || !!problem : !!problem || mode === 'mcp';

  const action = started ? (
    <button ref={trigger} type="button" className="settings-row__more" aria-label="Manage Krea sign-in"
      aria-expanded={showBody} aria-controls="settings-row-krea" onClick={() => setOpen(!showBody)}>
      <MoreHorizontal size={15} strokeWidth={1.75} aria-hidden="true" focusable="false" />
    </button>
  ) : (
    <button ref={trigger} type="button" className="settings__button" aria-label="Sign in to Krea" disabled={busy} onClick={krea.signIn}>
      {busy ? 'Opening…' : 'Sign in'}
    </button>
  );

  return (
    <div onKeyDownCapture={(event) => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }}>
      <ProviderRow id={KREA_ROW} setup="krea-mcp" tone={shown.tone} name="Krea · sign-in"
        status={started || !status ? shown.label : undefined} statusTone={signedIn ? 'ok' : shown.tone === 'warn' ? 'warn' : undefined}
        summary={signedIn ? 'workspace compute' : started ? undefined
          : mode === 'mcp' ? 'New Krea nodes are set to use it' : 'Uses your Krea plan instead of an API key'}
        title="Uses the Krea workspace you pick during sign-in and its compute units. Connecting never changes existing nodes or starts generation."
        action={action}>
        {showBody ? (
          <div id="settings-row-krea" className="settings-row__manage">
            {started && (
              <div className="settings-row__buttons">
                <button type="button" className="settings__button" disabled={busy} onClick={krea.signIn}>
                  {busy ? 'Working…' : status === 'connecting' ? 'Restart sign-in' : 'Reconnect'}
                </button>
                <button type="button" className="settings__button settings__button--ghost" disabled={busy} onClick={krea.check}>Check connection</button>
                <button type="button" className="settings__button settings__button--ghost settings__button--danger" disabled={busy} onClick={krea.disconnect}>Disconnect</button>
              </div>
            )}
            {status === 'connecting' && <p className="settings-hint">Finish signing in in your browser, then come back. If no page opened, use Open Krea sign-in.</p>}
            {authUrl && <a className="settings__button settings__button--ghost" href={authUrl} target="_blank" rel="noopener noreferrer" onClick={(event) => {
              const bridge = window.nebulaDesktop?.kreaLinks;
              if (!bridge) return;
              event.preventDefault();
              void bridge.open(authUrl).then((result) => {
                if (!result.ok) krea.setError("Couldn't open Krea sign-in in your browser.");
              }).catch(() => krea.setError("Couldn't open Krea sign-in in your browser."));
            }}>Open Krea sign-in ↗</a>}
            {problem && <p className="settings-row__error" role="alert">{problem}</p>}
            {(started || mode === 'mcp') && <KreaDefault mode={mode} />}
            {signedIn && <KreaPlans />}
            {started && <p className="settings-hint">To change workspaces, disconnect and sign in again.</p>}
          </div>
        ) : null}
      </ProviderRow>
    </div>
  );
}
