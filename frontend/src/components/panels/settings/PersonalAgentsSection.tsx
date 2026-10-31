import { useCallback, useEffect, useRef, useState } from 'react';
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
import { failureMessage, notConnectedBecause } from '../../../lib/errorCopy';
import { clearSetterOnPromote, isPersonRefusal, retryOnPromote } from '../../../lib/clearsOnPromote';
import { LineBox } from '../../LineBox';
import { useFocusHandover } from '../../../hooks/useFocusHandover';
import { PersonLockLine, type LockProps } from '../../PersonLock';
import { usePersonLock } from '../../../hooks/usePersonLock';
import { usePersonView, useReadAsPerson } from '../../../hooks/useTabHeld';

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

/** Gemini: hand the CLI the Gemini API key saved in Settings, only when the person turns it on. */
function KeyOption({ agent, busy, run, lock }: { agent: PersonalAgent; busy: boolean; run: Run; lock: LockProps }) {
  const option = agent.keyOption;
  if (!option) return null;
  const blocked = option.blocked ?? (!option.keySaved && !option.enabled
    ? 'Save a Gemini API key in Settings > API keys (Google) to use this.' : null);
  return (
    <span className="personal-agents__option" data-testid="personal-agent-key-option">
      <label className="personal-agents__option-label">
        <input type="checkbox" role="switch" className="settings-switch" checked={option.enabled}
          disabled={busy || (Boolean(blocked) && !option.enabled)} {...lock}
          onChange={(event) => void run(() => updatePersonalAgent(agent.id, { useNebulaKey: event.target.checked }))} />
        Use my Gemini API key from Nebula
      </label>
      <span className="personal-agents__fine">{option.billing}</span>
      {blocked && <span className="personal-agents__fine">{blocked}</span>}
    </span>
  );
}

/** Antigravity: the pinned download and Google's sign-in, run by Google's own server. */
function DownloadAndSignIn({ agent, busy, run, lock }: { agent: PersonalAgent; busy: boolean; run: Run; lock: LockProps }) {
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
          <button type="button" className="settings__button settings__button--primary" disabled={busy} {...lock}
            onClick={() => void run(() => antigravityAction('install'))}>
            {install.state === 'changed' ? 'Download again' : `Download ${install.version} (${megabytes(install.sizeBytes)})`}
          </button>
        )}
        {install.state === 'downloading' && (
          <button type="button" className="settings__button" disabled={busy} {...lock}
            onClick={() => void run(() => antigravityAction('remove'))}>Stop download</button>
        )}
        {install.state === 'installed' && signIn?.state === 'signed_out' && (
          <button type="button" className="settings__button settings__button--primary" disabled={busy} {...lock}
            onClick={() => void run(() => antigravityAction('sign-in'))}>Sign in with Google</button>
        )}
        {signIn?.state === 'waiting' && (
          <button type="button" className="settings__button" disabled={busy} {...lock}
            onClick={() => void run(() => antigravityAction('cancel-sign-in'))}>Cancel sign-in</button>
        )}
        {signIn?.state === 'signed_in' && (
          <button type="button" className="settings__button settings__button--neutral" disabled={busy} {...lock}
            onClick={() => void run(() => antigravityAction('sign-out'))}>Sign out</button>
        )}
        {(install.state === 'installed' || install.state === 'changed') && (
          <button type="button" className="settings__button settings__button--danger" disabled={busy || signIn?.state === 'waiting'} {...lock}
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
  const [draft, setDraft] = useState({ id: '', displayName: '', command: '', args: '' });
  // PR #204 round 10 (GM r15, r17 item 4): every route here is the person's alone. A listed
  // agent's switches, Remove and Antigravity's download and sign-in lock as a group, with one
  // line under the heading; Add has its own line (GM's words).
  const rowLock = usePersonLock('change your agents');
  const addLock = usePersonLock('add an agent');
  // GM r17 item 6 (b): a held or demoted tab shows what a tab that never connected shows.
  // PR #204 round 11: the list is read only on a tab connected as the person (usePersonView).
  const { held: demoted, ready, epoch, readsOnPromote } = usePersonView();

  const load = useCallback(function readAgain() {
    fetchPersonalAgents()
      .then((next) => { setList(next); setError(null); })
      .catch((exc: unknown) => {
        // GM r6 (2): what retries on the promote says why in the "because" form.
        const line = isPersonRefusal(exc) ? notConnectedBecause('load your agents') : failureMessage(exc, "Couldn't load your agents.");
        setError(line);
        // GM, #204 r3 and r6: refused only because this tab isn't connected as you: on the
        // promote the line goes and the read runs again, through retryOnPromote.
        clearSetterOnPromote(exc, setError, line, null); // clears-on-promote: settings.agents-load
        // Round 13 (review 10 NIT-1): unless the held view settled, whose promote reads it anyway.
        retryOnPromote(exc, 'settings.agents-load', () => { if (!readsOnPromote.current) readAgain(); }); // clears-on-promote: settings.agents-load-retry
      });
  }, [readsOnPromote]);

  useReadAsPerson(load, ready, epoch);
  // Round 11 (review 9 MEDIUM-3, GM r19 2): a demote that takes away the focused row moves focus
  // to the section's line, not to the page.
  const sectionRef = useRef<HTMLElement>(null);
  const handover = useFocusHandover(demoted, () => sectionRef.current,
    () => document.getElementById('settings-personal-agents-heading'));

  // Follow a download or sign-in while it runs.
  const following = !demoted && (list?.agents ?? []).some(personalAgentBusy);
  useEffect(() => {
    if (!following) return undefined;
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [following, load]);

  const run = async (work: () => Promise<unknown>) => {
    // Every change here is the person's alone (aria-disabled doesn't stop a click or a change).
    if (rowLock.locked) return;
    setBusy(true);
    setError(null);
    try {
      await work();
      load();
      announceChange();
    } catch (exc) {
      const line = failureMessage(exc, "Couldn't update your agents.");
      setError(line);
      clearSetterOnPromote(exc, setError, line, null); // clears-on-promote: settings.agents (GM, #204 r3)
    } finally {
      setBusy(false);
    }
  };

  const addCustom = () => run(async () => {
    const args = draft.args.trim() ? draft.args.trim().split(/\s+/) : [];
    await createPersonalAgent({
      id: draft.id.trim(), displayName: draft.displayName.trim() || undefined, command: draft.command.trim(), args,
    });
    setDraft({ id: '', displayName: '', command: '', args: '' });
  });

  const agents = demoted ? [] : (list?.agents ?? []);
  const shownError = demoted ? notConnectedBecause('load your agents') : error;
  return (
    <section aria-labelledby="settings-personal-agents-heading" data-testid="settings-personal-agents" ref={sectionRef} onFocus={handover.onFocus}>
      <div className="settings-label"><h3 id="settings-personal-agents-heading" tabIndex={-1}>Personal agents</h3></div>
      {agents.length > 0 && <PersonLockLine lock={rowLock} place="heading" />}
      <p className="settings-hint">
        Chat with your own agent (your login, settings, memory and MCP servers) in the chat panel. Nebula adds its
        canvas tools and counts their runs in the budget for agents outside Nebula&rsquo;s chats. The agent keeps its
        own shell, network and files; Nebula doesn&rsquo;t sandbox it. See docs/PERSONAL-AGENTS.md.
      </p>
      {/* Round 11 (GM r18 c): the section's own line, in the shared box (components/LineBox). */}
      <LineBox text={shownError} />
      <div className="settings-list">
        {agents.map((agent) => (
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
              <KeyOption agent={agent} busy={busy} run={run} lock={rowLock.control()} />
              <DownloadAndSignIn agent={agent} busy={busy} run={run} lock={rowLock.control()} />
            </span>
            <span className="settings-model-limit__controls">
              {agent.startable && (
                <input type="checkbox" role="switch" className="settings-switch" checked={agent.enabled}
                  aria-label={`Use ${agent.displayName} in chat`} disabled={busy} {...rowLock.control()}
                  onChange={(event) => void run(() => updatePersonalAgent(agent.id, { enabled: event.target.checked }))} />
              )}
              {agent.kind === 'custom' && (
                <button type="button" className="settings__button settings__button--danger" disabled={busy}
                  aria-label={`Remove ${agent.displayName}`} {...rowLock.control()}
                  onClick={() => void run(() => deletePersonalAgent(agent.id))}>
                  Remove
                </button>
              )}
            </span>
          </div>
        ))}
        <form className="settings-pref settings-model-limit settings-apps__new"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.id.trim() && draft.command.trim() && !addLock.locked) void addCustom();
          }}>
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
              disabled={busy || !draft.id.trim() || !draft.command.trim()} {...addLock.control()}>Add</button>
          </span>
          <PersonLockLine lock={addLock} place="control" />
        </form>
      </div>
    </section>
  );
}
