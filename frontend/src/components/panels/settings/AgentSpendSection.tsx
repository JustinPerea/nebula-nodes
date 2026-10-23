import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { NODE_DEFINITIONS } from '../../../constants/nodeDefinitions';
import { getOutsideSpend, type OutsideSpend } from '../../../lib/api';
import { saveField } from '../../../lib/settingsWrites';
import {
  DEFAULT_PLAN_RUNS, useSettingsDraftStore, type AgentSpendLimits, type ModelSpendLimit,
} from '../../../store/settingsDraftStore';
import { useUIStore } from '../../../store/uiStore';
import { ConnectedApps } from './ConnectedApps';
import { failureMessage } from '../../../lib/errorCopy';

const SESSION_CHOICES = [2, 5, 10, 25, 50, 100] as const;
const PLAN_RUN_CHOICES = [5, 10, 25, 50, 100, 250] as const;
/** The outside budget's select value while it follows the per-session one. */
const SAME_AS_SESSION = 'session';
/** The plan-runs select value while it is the default. */
const DEFAULT_CHOICE = 'default';
const MODEL_RUN_CHOICES = [0.5, 1, 2, 5, 10, 20] as const;
const MODEL_SESSION_CHOICES = [5, 10, 25, 50, 100] as const;

const CATEGORY_LABELS: Record<string, string> = {
  'image-gen': 'Image', 'video-gen': 'Video', 'audio-gen': 'Audio', 'text-gen': 'Text and chat',
  '3d-gen': '3D', transform: 'Transform', analyzer: 'Analyze', universal: 'Universal',
};

function usd(value: number) {
  return value < 1 ? `$${value.toFixed(2)}` : `$${value}`;
}

/** What was spent, to the cent ("$3.40", "$0.00"). */
function spentUsd(value: number) {
  return `$${value.toFixed(2)}`;
}

/** What the outside agents and connected apps spent in the last 24 hours. The person's view only. */
function useOutsideSpend() {
  const [view, setView] = useState<OutsideSpend | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    getOutsideSpend()
      .then((next) => { setView(next); setError(null); })
      .catch((exc: unknown) => setError(failureMessage(exc, "Couldn't load the connected apps.")));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  return { view, error, reload };
}

function LimitSelect({ id, label, value, choices, none, suffix = '', disabled, onChange, describedBy }: {
  id?: string;
  suffix?: string;
  label?: string;
  value: number | null;
  choices: readonly number[];
  none: string;
  disabled: boolean;
  onChange: (value: number | null) => void;
  describedBy?: string;
}) {
  const current = value === null ? 'none' : String(value);
  const custom = value !== null && !choices.includes(value);
  return (
    <select id={id} aria-label={label} aria-describedby={describedBy} className="settings__select settings__select--compact"
      value={current} disabled={disabled}
      onChange={(event) => onChange(event.target.value === 'none' ? null : Number(event.target.value))}>
      {custom && <option value={current}>{usd(value!)}{suffix}</option>}
      {choices.map((choice) => <option key={choice} value={String(choice)}>{usd(choice)}{suffix}</option>)}
      <option value="none">{none}</option>
    </select>
  );
}

/** Limits on what agents may spend before they have to ask (propose) first.
 * They never stop the person's own runs. Saved to settings.json. */
export function AgentSpendSection() {
  const saved = useSettingsDraftStore((s) => s.saved?.agentSpend);
  const pending = useSettingsDraftStore((s) => !!s.pending.agentSpend);
  const error = useSettingsDraftStore((s) => s.errors.agentSpend);
  const perRun = useUIStore((s) => s.runCostConfirmUsd);
  const outside = useOutsideSpend();

  const paidModels = useMemo(() => {
    const groups = new Map<string, { id: string; name: string }[]>();
    for (const definition of Object.values(NODE_DEFINITIONS)) {
      if (!definition || definition.apiProvider === 'utility') continue;
      const label = CATEGORY_LABELS[definition.category] ?? 'Other';
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push({ id: definition.id, name: definition.displayName });
    }
    for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return [...groups.entries()];
  }, []);

  if (!saved) return null;
  const limits: AgentSpendLimits = saved;
  const save = (next: AgentSpendLimits) => void saveField('agentSpend', next);
  const setModel = (id: string, next: ModelSpendLimit | null) => {
    const models = { ...limits.models };
    if (next && (next.perRunUsd !== null || next.sessionUsd !== null)) models[id] = next; else delete models[id];
    save({ ...limits, models });
  };
  const modelIds = Object.keys(limits.models).sort((a, b) =>
    (NODE_DEFINITIONS[a]?.displayName ?? a).localeCompare(NODE_DEFINITIONS[b]?.displayName ?? b));

  return (
    <section aria-labelledby="settings-agent-spend-heading">
      <div className="settings-label"><h3 id="settings-agent-spend-heading">Agent spending</h3></div>
      <p className="settings-hint" id="settings-agent-spend-help">
        Agents must ask before going over these, and before any node without a published price.
        Your own runs aren&rsquo;t limited.{' '}
        {perRun === null ? 'There is no per-run limit.' : `The per-run limit above (${usd(perRun)}) applies to agents too.`}
      </p>
      <p className="settings-hint" id="settings-agent-spend-who">
        &ldquo;You&rdquo; means this canvas, opened from the link the backend printed at launch (or the desktop app).
        Only it can change these limits, keys and connections. That holds against Nebula&rsquo;s own chats (Codex&rsquo;s
        shell has no network) and any agent that reaches Nebula only through its
        MCP server or API. A program running as you with its own unrestricted shell could read the link&rsquo;s token,
        so these limits don&rsquo;t bind it.
      </p>
      <div className="settings-list">
        <div className="settings-pref">
          <span className="settings-pref__text">
            <label className="settings-pref__title" htmlFor="settings-agent-session">Per chat session</label>
            <span className="settings-pref__description">Everything one agent chat may run in total</span>
          </span>
          <LimitSelect id="settings-agent-session" value={limits.sessionUsd} choices={SESSION_CHOICES}
            none="No limit" disabled={pending} describedBy="settings-agent-spend-help"
            onChange={(sessionUsd) => save({ ...limits, sessionUsd })} />
        </div>
        <div className="settings-pref">
          <span className="settings-pref__text">
            <label className="settings-pref__title" htmlFor="settings-agent-outside">Agents outside Nebula chats</label>
            <span className="settings-pref__description" id="settings-agent-outside-help">
              Shared by every agent that isn&rsquo;t a Nebula chat: Claude Desktop, terminal tools, scripts. Counts the
              last 24 hours; restarting Nebula doesn&rsquo;t reset it.
              {outside.view && (
                <span className="settings-agent-spent" data-testid="settings-agent-outside-spent">
                  {' '}{spentUsd(outside.view.outside.spentUsd)} in the last 24 h
                  {outside.view.outside.kreaPlanRuns > 0 && `, ${outside.view.outside.kreaPlanRuns} Krea plan runs`}.
                </span>
              )}
            </span>
          </span>
          <OutsideSelect limits={limits} disabled={pending} onChange={save} />
        </div>
        <PersonalAgentSpend view={outside.view} />
        <div className="settings-pref">
          <span className="settings-pref__text">
            <label className="settings-pref__title" htmlFor="settings-agent-plan-runs">Krea plan runs</label>
            <span className="settings-pref__description" id="settings-agent-plan-runs-help">
              Per agent chat, or for the outside agents over 24 hours. Krea doesn&rsquo;t price its compute units per
              model, so these count runs. Only you can move a node between your API balance and your Krea plan; agents
              have to ask.
            </span>
          </span>
          <PlanRunsSelect limits={limits} disabled={pending} onChange={save} />
        </div>
        {modelIds.map((id) => {
          const name = NODE_DEFINITIONS[id]?.displayName ?? id;
          const limit = limits.models[id];
          return (
            <div className="settings-pref settings-model-limit" key={id}>
              <span className="settings-pref__text">
                <span className="settings-pref__title">{name}</span>
                <span className="settings-pref__description">Per run replaces the general limit for this model</span>
              </span>
              <span className="settings-model-limit__controls">
                <LimitSelect label={`${name} per run`} value={limit.perRunUsd} choices={MODEL_RUN_CHOICES}
                  none="General limit" suffix=" / run" disabled={pending} onChange={(perRunUsd) => setModel(id, { ...limit, perRunUsd })} />
                <LimitSelect label={`${name} per session`} value={limit.sessionUsd} choices={MODEL_SESSION_CHOICES}
                  none="No session limit" suffix=" / session" disabled={pending} onChange={(sessionUsd) => setModel(id, { ...limit, sessionUsd })} />
                <button type="button" className="settings__button settings__button--ghost settings-model-limit__remove"
                  aria-label={`Remove the limits for ${name}`} disabled={pending} onClick={() => setModel(id, null)}>
                  <X size={14} strokeWidth={1.75} aria-hidden="true" focusable="false" />
                </button>
              </span>
            </div>
          );
        })}
        <div className="settings-pref">
          <span className="settings-pref__text">
            <label className="settings-pref__title" htmlFor="settings-agent-add-model">Limit a model</label>
            <span className="settings-pref__description">Per run, per session, or both</span>
          </span>
          <select id="settings-agent-add-model" className="settings__select settings__select--compact" value=""
            disabled={pending}
            onChange={(event) => {
              const id = event.target.value;
              if (id) setModel(id, { perRunUsd: perRun ?? 1, sessionUsd: null });
            }}>
            <option value="">Choose…</option>
            {paidModels.map(([group, models]) => (
              <optgroup key={group} label={group}>
                {models.filter((model) => !limits.models[model.id]).map((model) => (
                  <option key={model.id} value={model.id}>{model.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>
      {error && <p className="settings-row__error" role="alert">{error}</p>}
      <ConnectedApps view={outside.view} loadError={outside.error} onChanged={outside.reload} />
    </section>
  );
}

/** Each of the person's own agents (Settings > Personal agents) that spent in
 * the last 24 hours. Read-only: their spending counts inside the outside
 * budget above (services/agent_spend.py PERSONAL_AGENT_BUDGET), so there is no
 * separate limit to set. */
function PersonalAgentSpend({ view }: { view: OutsideSpend | null }) {
  const rows = (view?.personal ?? []).filter((agent) => agent.spentUsd > 0 || agent.kreaPlanRuns > 0);
  if (rows.length === 0) return null;
  return (
    <>
      {rows.map((agent) => (
        <div className="settings-pref" key={agent.id} data-testid="settings-personal-spend-row">
          <span className="settings-pref__text">
            <span className="settings-pref__title">{agent.name}</span>
            <span className="settings-pref__description">
              {spentUsd(agent.spentUsd)} in the last 24 h
              {agent.kreaPlanRuns > 0 && `, ${agent.kreaPlanRuns} Krea plan runs`}, inside the budget above
            </span>
          </span>
        </div>
      ))}
    </>
  );
}

/** Krea plan runs: DEFAULT_PLAN_RUNS until the person picks a number, 0 (ask every time) or no limit. */
function PlanRunsSelect({ limits, disabled, onChange }: {
  limits: AgentSpendLimits;
  disabled: boolean;
  onChange: (next: AgentSpendLimits) => void;
}) {
  const own = limits.kreaPlanRuns;
  const current = own === undefined ? DEFAULT_CHOICE : own === null ? 'none' : String(own);
  const custom = typeof own === 'number' && own !== 0 && !(PLAN_RUN_CHOICES as readonly number[]).includes(own);
  return (
    <select id="settings-agent-plan-runs" className="settings__select settings__select--compact"
      aria-describedby="settings-agent-plan-runs-help" value={current} disabled={disabled}
      onChange={(event) => {
        const { value } = event.target;
        const next = { ...limits };
        if (value === DEFAULT_CHOICE) delete next.kreaPlanRuns;
        else next.kreaPlanRuns = value === 'none' ? null : Number(value);
        onChange(next);
      }}>
      <option value={DEFAULT_CHOICE}>{DEFAULT_PLAN_RUNS} (default)</option>
      <option value="0">Ask every time</option>
      {custom && <option value={current}>{own} run{own === 1 ? '' : 's'}</option>}
      {PLAN_RUN_CHOICES.map((choice) => <option key={choice} value={String(choice)}>{choice} runs</option>)}
      <option value="none">No limit</option>
    </select>
  );
}

/** The outside agents' 24-hour budget: the per-session amount until the person picks one. */
function OutsideSelect({ limits, disabled, onChange }: {
  limits: AgentSpendLimits;
  disabled: boolean;
  onChange: (next: AgentSpendLimits) => void;
}) {
  const own = limits.outsideDailyUsd;
  const current = own === undefined ? SAME_AS_SESSION : own === null ? 'none' : String(own);
  const custom = typeof own === 'number' && !(SESSION_CHOICES as readonly number[]).includes(own);
  const session = limits.sessionUsd === null ? 'no limit' : usd(limits.sessionUsd);
  return (
    <select id="settings-agent-outside" className="settings__select settings__select--compact"
      aria-describedby="settings-agent-outside-help" value={current} disabled={disabled}
      onChange={(event) => {
        const { value } = event.target;
        const next = { ...limits };
        if (value === SAME_AS_SESSION) delete next.outsideDailyUsd;
        else next.outsideDailyUsd = value === 'none' ? null : Number(value);
        onChange(next);
      }}>
      <option value={SAME_AS_SESSION}>Same as a chat ({session})</option>
      {custom && <option value={current}>{usd(own)} / 24 h</option>}
      {SESSION_CHOICES.map((choice) => <option key={choice} value={String(choice)}>{usd(choice)} / 24 h</option>)}
      <option value="none">No limit</option>
    </select>
  );
}
