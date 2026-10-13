import { useCallback, useEffect, useState } from 'react';
import {
  createPersonalAgent,
  deletePersonalAgent,
  fetchPersonalAgents,
  updatePersonalAgent,
  type PersonalAgent,
  type PersonalAgentList,
} from '../../../lib/api';
import '../../../styles/personal-agents.css';

export const PERSONAL_AGENTS_CHANGED_EVENT = 'nebula:personal-agents-changed';

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

/** Settings > Preferences > Personal agents: the person's own ACP agents that
 * the chat panel can start (backend services/personal_agents.py). */
export function PersonalAgentsSection() {
  const [list, setList] = useState<PersonalAgentList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState({ id: '', displayName: '', command: '', args: '' });

  const load = useCallback(() => {
    fetchPersonalAgents()
      .then((next) => { setList(next); setError(null); })
      .catch((exc: unknown) => setError(exc instanceof Error ? exc.message : String(exc)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      load();
      announceChange();
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : String(exc));
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
              </span>
            </span>
            <span className="settings-model-limit__controls">
              {agent.startable && (
                <input type="checkbox" role="switch" className="settings-switch" checked={agent.enabled}
                  aria-label={`Use ${agent.displayName} in chat`} disabled={busy}
                  onChange={(event) => void run(() => updatePersonalAgent(agent.id, { enabled: event.target.checked }))} />
              )}
              {agent.kind === 'custom' && (
                <button type="button" className="settings__button" disabled={busy}
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
