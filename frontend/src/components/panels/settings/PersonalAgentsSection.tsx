import { useCallback, useEffect, useState } from 'react';
import {
  antigravityAction,
  createPersonalAgent,
  deletePersonalAgent,
  fetchPersonalAgents,
  updatePersonalAgent,
  type PersonalAgent,
  type PersonalAgentList,
} from '../../../lib/api';
import { PERSONAL_AGENTS_CHANGED_EVENT } from '../../../lib/personalAgentsEvents';
import '../../../styles/personal-agents.css';
import { failureMessage } from '../../../lib/errorCopy';
import { SettingsSwitch } from './Switch';

const STATUS_TEXT: Record<PersonalAgent['status'], string> = {
  ready: 'Ready',
  disabled: 'Off',
  not_installed: 'Not installed',
  needs_node: 'Needs a newer Node.js',
  needs_setup: 'Not set up yet',
};

function announceChange() {
  window.dispatchEvent(new CustomEvent(PERSONAL_AGENTS_CHANGED_EVENT));
}

const POLL_MS = 1000;

function megabytes(bytes: number | null | undefined): string {
  return `${Math.round((bytes ?? 0) / 1_000_000)} MB`;
}

/** Something Nebula is doing for an agent that Settings should follow (a download, a sign-in). */
function personalAgentBusy(agent: PersonalAgent): boolean {
  return agent.install?.state === 'downloading' || agent.signIn?.state === 'waiting';
}

type Run = (work: () => Promise<unknown>) => Promise<void>;

/** A switch whose own change is being saved, and the position the person
 * gave it (GM, PR #205 r1 answer 6: shown at once, held while it saves). */
type Switching = { id: string; field: 'enabled' | 'useNebulaKey'; to: boolean };
type Toggle = (switching: Switching, work: () => Promise<unknown>) => void;

/** One switch of the section: the person's new position while its own save
 * is out; any switch here is held while the section is busy (held, then the
 * locked look after 150 ms, so a quick save greys nothing). */
function switchState(busy: boolean, switching: Switching | null, id: string, field: Switching['field'], saved: boolean) {
  const own = switching && switching.id === id && switching.field === field ? switching : null;
  return { checked: own ? own.to : saved, saving: busy };
}

/** Gemini: hand the CLI the Gemini API key saved in Settings, only when the person turns it on. */
function KeyOption({ agent, busy, switching, toggle }: { agent: PersonalAgent; busy: boolean; switching: Switching | null; toggle: Toggle }) {
  const option = agent.keyOption;
  if (!option) return null;
  const blocked = option.blocked ?? (!option.keySaved && !option.enabled
    ? 'Save a Gemini API key in Settings > API keys (Google) to use this.' : null);
  return (
    <span className="personal-agents__option" data-testid="personal-agent-key-option">
      <label className="personal-agents__option-label">
        <SettingsSwitch {...switchState(busy, switching, agent.id, 'useNebulaKey', option.enabled)}
          disabled={Boolean(blocked) && !option.enabled}
          onChange={(to) => toggle({ id: agent.id, field: 'useNebulaKey', to }, () => updatePersonalAgent(agent.id, { useNebulaKey: to }))} />
        Use my Gemini API key from Nebula
      </label>
      <span className="personal-agents__fine">{option.billing}</span>
      {blocked && <span className="personal-agents__fine">{blocked}</span>}
    </span>
  );
}

/** Antigravity: the pinned download and Google's sign-in, run by Google's own server. */
function DownloadAndSignIn({ agent, busy, run }: { agent: PersonalAgent; busy: boolean; run: Run }) {
  const install = agent.install;
  if (!install) return null;
  const job = install.job;
  const signIn = agent.signIn;
  const signJob = signIn?.job;
  return (
    <span className="personal-agents__option" data-testid="personal-agent-download">
      {install.state === 'downloading' && job ? (
        <span className="personal-agents__progress" role="status">
          <progress max={job.totalBytes || 1} value={job.receivedBytes ?? 0}
            aria-label={`Downloading ${agent.displayName}`} />
          {job.message} {megabytes(job.receivedBytes)} of {megabytes(job.totalBytes)}
        </span>
      ) : job?.state === 'failed' ? <span className="settings-row__error" role="alert">{job.message}</span> : null}
      <span className="personal-agents__actions">
        {(install.state === 'missing' || install.state === 'changed') && (
          <button type="button" className="settings__button settings__button--primary" disabled={busy}
            onClick={() => void run(() => antigravityAction('install'))}>
            {install.state === 'changed' ? 'Download again' : `Download ${install.version} (${megabytes(install.sizeBytes)})`}
          </button>
        )}
        {install.state === 'downloading' && (
          <button type="button" className="settings__button" disabled={busy}
            onClick={() => void run(() => antigravityAction('remove'))}>Stop download</button>
        )}
        {install.state === 'installed' && signIn?.state === 'signed_out' && (
          <button type="button" className="settings__button settings__button--primary" disabled={busy}
            onClick={() => void run(() => antigravityAction('sign-in'))}>Sign in with Google</button>
        )}
        {signIn?.state === 'waiting' && (
          <button type="button" className="settings__button" disabled={busy}
            onClick={() => void run(() => antigravityAction('cancel-sign-in'))}>Cancel sign-in</button>
        )}
        {signIn?.state === 'signed_in' && (
          <button type="button" className="settings__button settings__button--neutral" disabled={busy}
            onClick={() => void run(() => antigravityAction('sign-out'))}>Sign out</button>
        )}
        {(install.state === 'installed' || install.state === 'changed') && (
          <button type="button" className="settings__button settings__button--danger" disabled={busy || signIn?.state === 'waiting'}
            onClick={() => void run(() => antigravityAction('remove'))}>Remove download</button>
        )}
      </span>
      {signIn?.state === 'waiting' && signJob && (
        <span className="personal-agents__fine" role="status">
          {signJob.message}
          {signJob.signInUrl && <> <a href={signJob.signInUrl} target="_blank" rel="noreferrer noopener">
            Open Google&rsquo;s sign-in page</a></>}
        </span>
      )}
      {signJob?.state === 'failed' && <span className="settings-row__error" role="alert">{signJob.message}</span>}
      {install.source && install.state !== 'unsupported' && (
        <span className="personal-agents__fine">
          From {new URL(install.source).host}, pinned to {install.version} and checked by SHA-256 before it runs.
          Nebula never updates it on its own.
        </span>
      )}
    </span>
  );
}

/** Settings > Preferences > Personal agents: the person's own ACP agents that
 * the chat panel can start (backend services/personal_agents.py). */
export function PersonalAgentsSection() {
  const [list, setList] = useState<PersonalAgentList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState<Switching | null>(null);
  const [draft, setDraft] = useState({ id: '', displayName: '', command: '', args: '' });

  const load = useCallback(() => fetchPersonalAgents()
    .then((next) => { setList(next); setError(null); })
    .catch((exc: unknown) => setError(failureMessage(exc, "Couldn't load your agents."))), []);

  useEffect(() => { load(); }, [load]);

  // Follow a download or sign-in while it runs.
  const following = (list?.agents ?? []).some(personalAgentBusy);
  useEffect(() => {
    if (!following) return undefined;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [following, load]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      // The list answers before the hold ends, so a switch never shows its
      // old position between the save and the reload.
      await load();
      announceChange();
    } catch (exc) {
      setError(failureMessage(exc, "Couldn't update your agents."));
    } finally {
      setBusy(false);
    }
  };

  const toggle: Toggle = (next, work) => {
    setSwitching(next);
    void run(work).finally(() => setSwitching(null));
  };

  const addCustom = () => run(async () => {
    const args = draft.args.trim() ? draft.args.trim().split(/\s+/) : [];
    await createPersonalAgent({
      id: draft.id.trim(), displayName: draft.displayName.trim() || undefined, command: draft.command.trim(), args,
    });
    setDraft({ id: '', displayName: '', command: '', args: '' });
  });

  return (
    <section aria-labelledby="settings-personal-agents-heading" data-testid="settings-personal-agents">
      <div className="settings-label"><h3 id="settings-personal-agents-heading">Personal agents</h3></div>
      <p className="settings-hint">
        Chat with your own agent (your login, settings, memory and MCP servers) in the chat panel. Nebula adds its
        canvas tools and counts their runs in the budget for agents outside Nebula&rsquo;s chats. The agent keeps its
        own shell, network and files; Nebula doesn&rsquo;t sandbox it. See docs/PERSONAL-AGENTS.md.
      </p>
      {error && <p className="settings-row__error" role="alert">{error}</p>}
      <div className="settings-list">
        {(list?.agents ?? []).map((agent) => (
          <div className="settings-pref settings-model-limit" key={agent.id} data-testid="personal-agent-row"
            data-agent-id={agent.id}>
            <span className="settings-pref__text">
              <span className="settings-pref__title">
                <span className="personal-agents__swatch" style={{ background: agent.color }} aria-hidden="true" />
                {agent.displayName}
              </span>
              <span className="settings-pref__description">
                <span className="personal-agents__status" data-status={agent.status}>{STATUS_TEXT[agent.status]}</span>
                {agent.note ? ` · ${agent.note}` : ''}
                <br />
                <code>{[agent.command, ...agent.args].join(' ')}</code>
                {agent.termsNote && <span className="personal-agents__terms" role="note">{agent.termsNote}</span>}
              </span>
              <KeyOption agent={agent} busy={busy} switching={switching} toggle={toggle} />
              <DownloadAndSignIn agent={agent} busy={busy} run={run} />
            </span>
            <span className="settings-model-limit__controls">
              {agent.startable && (
                <SettingsSwitch {...switchState(busy, switching, agent.id, 'enabled', agent.enabled)}
                  aria-label={`Use ${agent.displayName} in chat`}
                  onChange={(to) => toggle({ id: agent.id, field: 'enabled', to }, () => updatePersonalAgent(agent.id, { enabled: to }))} />
              )}
              {agent.kind === 'custom' && (
                <button type="button" className="settings__button settings__button--danger" disabled={busy}
                  aria-label={`Remove ${agent.displayName}`} onClick={() => void run(() => deletePersonalAgent(agent.id))}>
                  Remove
                </button>
              )}
            </span>
          </div>
        ))}
        <form className="settings-pref settings-model-limit settings-apps__new"
          onSubmit={(event) => { event.preventDefault(); if (draft.id.trim() && draft.command.trim()) void addCustom(); }}>
          <span className="settings-pref__text">
            <span className="settings-pref__title">Add an ACP agent</span>
            <span className="settings-pref__description">
              Any agent that speaks the Agent Client Protocol over stdio: an absolute path or a command name, plus its
              arguments
            </span>
          </span>
          <span className="settings-model-limit__controls">
            <input className="settings-folder__input" aria-label="Custom agent id" placeholder="my-agent" maxLength={32}
              value={draft.id} disabled={busy} onChange={(event) => setDraft({ ...draft, id: event.target.value })} />
            <input className="settings-folder__input" aria-label="Custom agent name" placeholder="Name" maxLength={32}
              value={draft.displayName} disabled={busy}
              onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
            <input className="settings-folder__input" aria-label="Custom agent command" placeholder="/path/to/agent"
              value={draft.command} disabled={busy} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
            <input className="settings-folder__input" aria-label="Custom agent arguments" placeholder="--acp"
              value={draft.args} disabled={busy} onChange={(event) => setDraft({ ...draft, args: event.target.value })} />
            <button type="submit" className="settings__button settings__button--primary"
              disabled={busy || !draft.id.trim() || !draft.command.trim()}>Add</button>
          </span>
        </form>
      </div>
    </section>
  );
}
