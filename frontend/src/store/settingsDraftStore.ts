import { create } from 'zustand';
import { normalizeKreaMode, type KreaConnectionMode } from '../lib/kreaConnection';

/** Settings as the backend reports them. API keys arrive masked ("***abcd"). */
/** USD limits on what agents may spend without asking (backend/services/agent_spend.py). Null means no limit. */
export interface ModelSpendLimit {
  perRunUsd: number | null;
  sessionUsd: number | null;
}

export interface AgentSpendLimits {
  sessionUsd: number | null;
  /** What every agent outside Nebula's chats may spend together over the last
   * 24 hours. Left out (undefined): the same as sessionUsd. Null: no limit. */
  outsideDailyUsd?: number | null;
  /** Runs one chat, or the outside agents in 24 hours, may bill to the Krea plan. Null: no limit. */
  kreaPlanRuns: number | null;
  /** Keyed by node definition id. */
  models: Record<string, ModelSpendLimit>;
}

export interface SettingsDraft {
  apiKeys: Record<string, string>;
  routing: Record<string, string>;
  kreaConnectionMode: KreaConnectionMode;
  outputPath: string;
  exportFolder: string;
  zoomTelemetryEnabled: boolean;
  agentSpend: AgentSpendLimits;
}

/** Settings that save on their own, outside API keys. */
export type SettingsField = 'outputPath' | 'exportFolder' | 'zoomTelemetryEnabled' | 'kreaConnectionMode' | 'agentSpend';

export type SettingsTab = 'providers' | 'preferences' | 'storage';

export interface SettingsNotice {
  id: number;
  message: string;
  /** A key that was just added; Undo removes it. Replacements can't be undone (the old secret is gone). */
  undoKey?: string;
}

interface SettingsState {
  /** Last state the backend confirmed. Null until the first load succeeds. */
  saved: SettingsDraft | null;
  /** Key text typed but not saved. Survives closing the panel; never written to browser storage. */
  keyDrafts: Record<string, string>;
  /** Path text typed but not saved yet (it saves on Enter or leaving the field). */
  fieldDrafts: Partial<Record<'outputPath' | 'exportFolder', string>>;
  /** The provider row that's open, and whether it's open to manage or to enter a key. */
  openRow: { id: string; mode: 'manage' | 'edit' } | null;
  tab: SettingsTab;
  /** Fields and keys with a write in flight, by key name or field name. */
  pending: Record<string, true>;
  /** The last failed write per key or field. Cleared when that one is retried or edited. */
  errors: Record<string, string>;
  /** The field that just saved, for its brief "Saved" mark. */
  justSaved: string | null;
  notice: SettingsNotice | null;
}

// Deliberately volatile: unsaved credentials survive dock unmounting but are
// never written to localStorage/sessionStorage and disappear on page reload.
export const useSettingsDraftStore = create<SettingsState>(() => ({
  saved: null,
  keyDrafts: {},
  fieldDrafts: {},
  openRow: null,
  tab: 'providers',
  pending: {},
  errors: {},
  justSaved: null,
  notice: null,
}));

export function readSettingsDraft(settings: Record<string, unknown>): SettingsDraft {
  const readStringRecord = (value: unknown): Record<string, string> => {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.values(value).some((entry) => typeof entry !== 'string')) {
      throw new Error('Invalid settings response');
    }
    return { ...value } as Record<string, string>;
  };
  return {
    apiKeys: readStringRecord(settings.apiKeys),
    routing: readStringRecord(settings.routing ?? {}),
    kreaConnectionMode: normalizeKreaMode(settings.kreaConnectionMode),
    outputPath: typeof settings.outputPath === 'string' ? settings.outputPath : '',
    exportFolder: typeof settings.exportFolder === 'string' ? settings.exportFolder : '',
    zoomTelemetryEnabled: settings.zoomTelemetryEnabled === true,
    agentSpend: readAgentSpend(settings.agentSpend),
  };
}

function readLimit(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Anything unreadable counts as no limit, as on the backend. */
export function readAgentSpend(value: unknown): AgentSpendLimits {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const models: Record<string, ModelSpendLimit> = {};
  const rawModels = raw.models && typeof raw.models === 'object' && !Array.isArray(raw.models)
    ? raw.models as Record<string, unknown> : {};
  for (const [id, limits] of Object.entries(rawModels)) {
    if (!limits || typeof limits !== 'object') continue;
    const entry = limits as Record<string, unknown>;
    const limit = { perRunUsd: readLimit(entry.perRunUsd), sessionUsd: readLimit(entry.sessionUsd) };
    if (limit.perRunUsd !== null || limit.sessionUsd !== null) models[id] = limit;
  }
  const planRuns = raw.kreaPlanRuns;
  const limits: AgentSpendLimits = {
    sessionUsd: readLimit(raw.sessionUsd),
    kreaPlanRuns: typeof planRuns === 'number' && Number.isInteger(planRuns) && planRuns > 0 ? planRuns : null,
    models,
  };
  // Only a saved value overrides the per-session amount; an unreadable one
  // falls back to it, as on the backend (never to no limit).
  if ('outsideDailyUsd' in raw && (raw.outsideDailyUsd === null || readLimit(raw.outsideDailyUsd) !== null)) {
    limits.outsideDailyUsd = readLimit(raw.outsideDailyUsd);
  }
  return limits;
}

/** True while any key or field is still being written. */
export function settingsWriteInFlight(state: Pick<SettingsState, 'pending'> = useSettingsDraftStore.getState()): boolean {
  return Object.keys(state.pending).length > 0;
}
