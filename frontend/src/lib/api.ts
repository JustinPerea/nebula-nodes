import { apiFetch, rewriteBackendAssetUrls } from './backend';
import { resolveProjectId } from './currentProject';
import type { Character, Moodboard } from '../types';
import { actorLabel, type TrashedItem } from './trash';
import { MoodboardVersionConflict, type MoodboardEditResult, type MoodboardOp } from './moodboardEdits';
import { CharacterVersionConflict } from './characterEdits';
import { RequestFailedError, copyForStatus, detailText, failureKind, readDetail } from './errorCopy';
import type {
  ProviderRecoveryCheckpoint,
  ProviderStartAmbiguity,
  ProviderStartKind,
} from './runHistory';

export interface ExecutionValidationError {
  nodeId: string;
  portId: string;
  message: string;
}

export interface ExecutionStartResult {
  status: string;
  nodeCount?: number;
  errorCount?: number;
  errors?: ExecutionValidationError[];
  runId?: string;
}

export interface ExecutionCancellationResult {
  runId: string;
  status: 'cancelling' | 'cancelled' | 'completed' | 'failed';
  pendingAdmission?: boolean;
}

export interface ExecutionStatusResult {
  runId: string;
  status: 'running' | 'cancelling' | 'cancelled' | 'completed' | 'failed';
}

/** A received non-2xx response proves the start request reached a backend and
 * was rejected. Network exceptions remain ambiguous and must be reconciled by
 * the caller with the client-owned run ID. */
export class ExecutionStartRejectedError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ExecutionStartRejectedError';
    this.status = status;
  }
}

function executionStartResponseError(
  message: string,
  status: number,
): Error {
  // A gateway/server failure can be returned after the request body was
  // forwarded and the backend scheduled work, so it is not proof of rejection.
  // 507 is Nebula's explicit pre-provider durable-safety rejection.
  if ((status >= 500 && status !== 507) || status === 408) {
    return new Error(message);
  }
  return new ExecutionStartRejectedError(message, status);
}

export async function getExecutionStatus(runId: string): Promise<ExecutionStatusResult> {
  const response = await apiFetch(`/api/executions/${encodeURIComponent(runId)}`, {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Execution status unavailable: HTTP ${response.status}.`);
  return response.json();
}

export async function cancelExecution(runId: string): Promise<ExecutionCancellationResult> {
  const response = await apiFetch(`/api/executions/${encodeURIComponent(runId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON responses use the status fallback. */
    }
    throw new Error(detail || `Cancel failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function acknowledgeProviderStartAmbiguity(
  kind: ProviderStartKind,
  nodeId: string,
  runId: string,
): Promise<void> {
  const response = await apiFetch(
    `/api/provider-start-ambiguities/${encodeURIComponent(kind)}/${encodeURIComponent(nodeId)}/${encodeURIComponent(runId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON responses use the status fallback. */
    }
    throw new Error(detail || `Could not unlock provider start: HTTP ${response.status}.`);
  }
}

export async function deleteProviderRecovery(
  runId: string,
  nodeId: string,
  checkpoint: Pick<ProviderRecoveryCheckpoint, 'resumeOperationId' | 'existingWorldId'>,
): Promise<void> {
  const query = new URLSearchParams();
  if (checkpoint.resumeOperationId) {
    query.set('resume_operation_id', checkpoint.resumeOperationId);
  }
  if (checkpoint.existingWorldId) {
    query.set('existing_world_id', checkpoint.existingWorldId);
  }
  if ([...query.keys()].length !== 1) {
    throw new Error('Provider recovery deletion requires exactly one recovery ID.');
  }
  const response = await apiFetch(
    `/api/provider-recoveries/${encodeURIComponent(runId)}/${encodeURIComponent(nodeId)}?${query.toString()}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON responses use the status fallback. */
    }
    throw new Error(detail || `Could not clear provider recovery: HTTP ${response.status}.`);
  }
}

export async function executeGraph(
  nodes: Array<{ id: string; definitionId: string; params: Record<string, unknown>; outputs: Record<string, unknown> }>,
  edges: Array<{ id: string; source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }>,
  runId?: string,
  preserveGraphParams = false,
  approvalId?: string,
): Promise<ExecutionStartResult> {
  const response = await apiFetch('/api/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodes, edges, runId, ...(preserveGraphParams ? { preserveGraphParams } : {}), ...(approvalId ? { approvalId } : {}),
    }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON error responses still fall back to status text. */
    }
    throw executionStartResponseError(
      detail || `Execute failed: ${response.status} ${response.statusText}`,
      response.status,
    );
  }
  return response.json();
}

export async function executeNode(
  nodes: Array<{ id: string; definitionId: string; params: Record<string, unknown>; outputs: Record<string, unknown> }>,
  edges: Array<{ id: string; source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }>,
  targetNodeId: string,
  runId?: string,
  preserveGraphParams = false,
  approvalId?: string,
): Promise<ExecutionStartResult> {
  const response = await apiFetch('/api/execute-node', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nodes, edges, targetNodeId, runId,
      ...(preserveGraphParams ? { preserveGraphParams } : {}), ...(approvalId ? { approvalId } : {}),
    }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON error responses still fall back to status text. */
    }
    throw executionStartResponseError(
      detail || `Execute node failed: ${response.status} ${response.statusText}`,
      response.status,
    );
  }
  return response.json();
}

export async function generateCinemaShot(
  nodes: Array<{ id: string; definitionId: string; params: Record<string, unknown>; outputs: Record<string, unknown> }>,
  edges: Array<{ id: string; source: string; sourceHandle: string | null | undefined; target: string; targetHandle: string | null | undefined }>,
  nodeId: string,
  shotId: string,
  seed?: number,
  variations?: number,
  runId?: string,
): Promise<{ status: string; shotId?: string; variations?: number; errorCount?: number }> {
  const response = await apiFetch('/api/cinema/generate-shot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges, nodeId, shotId, seed, variations, runId }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON error responses still fall back to status text. */
    }
    throw executionStartResponseError(detail || `Generate shot failed: ${response.status} ${response.statusText}`, response.status);
  }
  return response.json();
}

export async function promoteCinemaShotVariation(
  nodeId: string,
  shotId: string,
  index: number,
): Promise<{ status: string; shotId: string; selectedVariation: number; imageUrl: string }> {
  const response = await apiFetch('/api/cinema/promote-shot-variation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeId, shotId, index }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON error responses still fall back to status text. */
    }
    throw new Error(detail || `Promote shot variation failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const response = await apiFetch('/api/settings');
  if (!response.ok) throw new Error(`Get settings failed: ${response.status}`);
  return response.json();
}

export async function updateSettings(settings: Record<string, unknown>): Promise<{ status: string }> {
  const response = await apiFetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!response.ok) throw new Error(`Update settings failed: ${response.status}`);
  return response.json();
}

/** An outside app the person gave a spending token (backend services/app_tokens.py). */
export interface ConnectedApp {
  id: string;
  name: string;
  /** Its own limit over the last 24 hours; null means only the shared outside budget applies. */
  dailyUsd: number | null;
  createdAt: number | null;
  spentUsd: number;
  kreaPlanRuns: number;
  /** Which agent app it is (Settings > Connect your agent), null for tokens made before. */
  client?: string | null;
  /** Its cursor color on the canvas (#RRGGBB); null means one derived from its id. */
  color?: string | null;
}

export interface AgentClientOption { id: string; label: string }

export interface OutsideSpend {
  /** Every agent outside Nebula's chats, apps included, over the last 24 hours. */
  outside: { spentUsd: number; kreaPlanRuns: number };
  apps: ConnectedApp[];
  /** The agent apps Connect your agent offers, and whether this backend can point them at a checkout. */
  connect?: { clients: AgentClientOption[]; available: boolean; reason: string | null };
  /** The person's own agents (outside:personal:<id>), each also inside `outside`. */
  personal?: Array<{ id: string; name: string; spentUsd: number; kreaPlanRuns: number }>;
}

/** The exact config for one agent app (backend services/agent_connect.py). It names the token's
 * file (tokenFile), never the token itself. */
export interface AgentSetup {
  client: string;
  label: string;
  kind: 'command' | 'json' | 'manual';
  format: 'json' | 'yaml' | 'shell' | 'toml' | 'text';
  where: string;
  snippet: string;
  steps: string[];
  alternative: { format: string; where: string; snippet: string } | null;
  /** The 0600 file Nebula saved the token to; the snippet points at it. */
  tokenFile: string | null;
  /** The same setup as one `nebula mcp connect --token-file` command; null for apps it only prints for. */
  cli: string | null;
  warnings: string[];
}

async function agentAppsCall<T>(path: string, init: RequestInit | undefined, what: string): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch { /* not JSON */ }
    throw new Error(detail || `${what} failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function getOutsideSpend(): Promise<OutsideSpend> {
  return agentAppsCall('/api/agent/spend/apps', undefined, 'Loading connected apps');
}

/** The backend keeps a hash and writes the token to tokenFile (0600). The raw token is in this
 * response too, for scripts; Settings shows it only when the person asks. */
export function createConnectedApp(
  name: string,
  dailyUsd: number | null,
  options: { client?: string; color?: string | null } = {},
): Promise<{ app: ConnectedApp; token: string; tokenFile: string | null; setup?: AgentSetup }> {
  return agentAppsCall('/api/agent/spend/apps', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, dailyUsd, ...options }),
  }, 'Creating the app token');
}

export function setConnectedAppColor(id: string, color: string | null): Promise<{ app: ConnectedApp }> {
  return agentAppsCall(`/api/agent/spend/apps/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color }),
  }, 'Saving the app color');
}

export function setConnectedAppLimit(id: string, dailyUsd: number | null): Promise<{ app: ConnectedApp }> {
  return agentAppsCall(`/api/agent/spend/apps/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dailyUsd }),
  }, 'Saving the app limit');
}

export function revokeConnectedApp(id: string): Promise<{ status: string }> {
  return agentAppsCall(`/api/agent/spend/apps/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Revoking the app');
}

/** Remove one browser-managed provider key without resubmitting other settings. */
export async function deleteSettingsApiKey(provider: string): Promise<{ status: string }> {
  const response = await apiFetch(`/api/settings/api-keys/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error(`Remove API key failed: ${response.status}`);
  return response.json();
}

/**
 * Update a single in-memory injected credential on the backend (desktop mode).
 *
 * Called after `nebulaDesktop.credentials.set()` or `.clear()` to update
 * the backend's `_INJECTED_KEYS` dict without a sidecar restart. An empty
 * key string removes the provider from the in-memory store.
 */
export async function updateCredential(provider: string, key: string): Promise<{ status: string }> {
  const response = await apiFetch('/api/credentials/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, key }),
  });
  if (!response.ok) throw new Error(`Credential update failed: ${response.status}`);
  return response.json();
}

export interface OpenRouterModel {
  id: string;
  name: string;
  input_modalities: string[];
  output_modalities: string[];
  context_length: number;
  pricing: Record<string, string>;
}

export async function fetchOpenRouterModels(): Promise<{ models: OpenRouterModel[]; count: number }> {
  const response = await apiFetch('/api/openrouter/models');
  if (!response.ok) throw new Error(`Fetch OpenRouter models failed: ${response.status}`);
  return response.json();
}

// Nous Portal models share the OpenRouter shape after the backend slims them.
// Reuse the type alias instead of duplicating the interface.
export type NousModel = OpenRouterModel;

export async function fetchNousModels(): Promise<{ models: NousModel[]; count: number }> {
  const response = await apiFetch('/api/nous/models');
  if (!response.ok) {
    // Surface the backend's auth message verbatim — usually instructs the
    // user to run `hermes model` and pick Nous Portal.
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON error responses still fall back to the status message. */
    }
    throw new Error(detail || `Fetch Nous models failed: ${response.status}`);
  }
  return response.json();
}

export type ChatProvider = 'claude' | 'codex';
/** What the chat panel can talk to: Nebula's own Claude/Codex runners, or one
 * of the person's own agents over ACP (backend services/acp_session.py). */
export type ChatAgentId = ChatProvider | `personal:${string}`;

export function isPersonalAgent(agent: string): agent is `personal:${string}` {
  return agent.startsWith('personal:');
}

export type PersonalAgentStatus = 'ready' | 'not_installed' | 'needs_node' | 'needs_setup' | 'disabled';

/** One of the person's own agents (backend services/personal_agents.py). */
export interface PersonalAgent {
  id: string;
  kind: 'preset' | 'custom';
  displayName: string;
  color: string;
  enabled: boolean;
  command: string;
  args: string[];
  status: PersonalAgentStatus;
  resolvedPath: string | null;
  note: string;
  startable: boolean;
  /** The installed CLI's version, when Nebula checked it (Gemini, Antigravity). */
  version?: string | null;
  /** Gemini: hand this agent the Gemini API key saved in Settings. Off until the person turns it on. */
  keyOption?: { enabled: boolean; keySaved: boolean; billing: string; blocked: string | null } | null;
  /** Antigravity: Google's ACP server, downloaded pinned and SHA-256 checked. */
  install?: {
    state: 'unsupported' | 'missing' | 'downloading' | 'changed' | 'installed';
    version: string; sizeBytes: number | null; message: string; source: string | null;
    job?: PersonalAgentJob;
  } | null;
  /** Antigravity: the Google sign-in Google's server runs in the browser. */
  signIn?: { state: 'signed_out' | 'waiting' | 'signed_in'; job?: PersonalAgentJob } | null;
  /** What using this agent means for the person's own account (Antigravity's terms). */
  termsNote?: string;
}

export interface PersonalAgentJob {
  state: 'running' | 'done' | 'failed' | 'cancelled';
  message: string;
  receivedBytes?: number;
  totalBytes?: number;
  signInUrl?: string;
}

/** A model (or thinking level) the person may pick for one personal session. */
export interface PersonalSessionOption {
  id: string;
  name: string;
  category: string;
  current: string | null;
  options: Array<{ value: string; name: string }>;
}

export function parsePersonalSessionOptions(raw: unknown): PersonalSessionOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): PersonalSessionOption[] => {
    if (!item || typeof item !== 'object') return [];
    const option = item as Record<string, unknown>;
    if (typeof option.id !== 'string' || !Array.isArray(option.options)) return [];
    const values = option.options.flatMap((value): Array<{ value: string; name: string }> => {
      if (!value || typeof value !== 'object') return [];
      const entry = value as Record<string, unknown>;
      return typeof entry.value === 'string' ? [{ value: entry.value, name: String(entry.name ?? entry.value) }] : [];
    });
    if (!values.length) return [];
    return [{ id: option.id, name: String(option.name ?? option.id), category: String(option.category ?? ''),
      current: typeof option.current === 'string' ? option.current : null, options: values }];
  });
}

export interface PersonalAgentList {
  warningAcknowledged: boolean;
  agents: PersonalAgent[];
}

export function fetchPersonalAgents(): Promise<PersonalAgentList> {
  return agentAppsCall('/api/personal-agents', undefined, 'Loading personal agents');
}

export function acknowledgePersonalAgentWarning(): Promise<{ warningAcknowledgedAt: string }> {
  return agentAppsCall('/api/personal-agents/acknowledge-warning', { method: 'POST' }, 'Saving your answer');
}

export function updatePersonalAgent(
  id: string,
  changes: Partial<Pick<PersonalAgent, 'enabled' | 'displayName' | 'color' | 'command' | 'args'>> & { useNebulaKey?: boolean },
): Promise<{ agent: PersonalAgent }> {
  return agentAppsCall(`/api/personal-agents/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes),
  }, 'Saving the agent');
}

export function createPersonalAgent(agent: {
  id: string; displayName?: string; color?: string; command: string; args?: string[];
}): Promise<{ agent: PersonalAgent }> {
  return agentAppsCall('/api/personal-agents', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(agent),
  }, 'Adding the agent');
}

export function deletePersonalAgent(id: string): Promise<{ ok: boolean }> {
  return agentAppsCall(`/api/personal-agents/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Removing the agent');
}

/** Antigravity's download, sign-in and sign-out (backend services/antigravity_agent.py). */
export function antigravityAction(
  action: 'install' | 'remove' | 'sign-in' | 'cancel-sign-in' | 'sign-out',
): Promise<{ agent: PersonalAgent; message?: string }> {
  const [path, method, what] = {
    install: ['install', 'POST', 'Starting the download'],
    remove: ['install', 'DELETE', 'Removing the download'],
    'sign-in': ['sign-in', 'POST', 'Starting the sign-in'],
    'cancel-sign-in': ['sign-in', 'DELETE', 'Stopping the sign-in'],
    'sign-out': ['sign-out', 'POST', 'Signing out'],
  }[action];
  return agentAppsCall(`/api/personal-agents/antigravity/${path}`, { method }, what);
}

export function chatAuthUsesProviderBilling(mode: string | null): boolean {
  return /api|bearer|bedrock|vertex|foundry/i.test(mode || '');
}

export interface ChatModelCatalog {
  agent: ChatProvider;
  status: 'ready' | 'not_installed' | 'not_authenticated' | 'unavailable';
  auth: { mode: string | null; planType?: string | null };
  catalog: { source: string; runtimeVersion: string | null; fetchedAt: string };
  models: Array<{
    id: string;
    label: string;
    description?: string;
    resolvedModel?: string;
    isDefault: boolean;
    defaultEffort: string | null;
    supportedEfforts: Array<{ id: string; label: string; description?: string }>;
  }>;
  error?: { code: string; message: string };
}

export async function fetchChatModels(agent: ChatProvider, refresh = false): Promise<ChatModelCatalog> {
  const response = await apiFetch(`/api/agents/${agent}/models${refresh ? '?refresh=true' : ''}`);
  if (!response.ok) throw new Error(response.status === 404
    ? 'Model discovery needs the updated Nebula backend. Restart it, then retry.'
    : 'Model discovery is unavailable. Check the Nebula backend, then retry.');
  return response.json();
}

export interface CodexStatus {
  installed: boolean;
  loggedIn: boolean;
  mode: 'chatgpt' | 'api' | 'access_token' | null;
  message: string;
}

export interface CodexChatGPTLoginState {
  running: boolean;
  mode: 'browser' | 'device';
  authUrl: string | null;
  deviceCode: string | null;
  message: string;
  output: string[];
  exitCode: number | null;
}

export interface ClaudeStatus {
  installed: boolean;
  loggedIn: boolean;
  authMethod: string | null;
  subscriptionType: string | null;
  email: string | null;
  message: string;
}

export async function fetchClaudeStatus(): Promise<ClaudeStatus> {
  const response = await apiFetch('/api/agents/claude/status');
  if (!response.ok) throw new Error(`Fetch Claude status failed: ${response.status}`);
  return response.json();
}

export async function fetchCodexStatus(): Promise<CodexStatus> {
  const response = await apiFetch('/api/agents/codex/status');
  if (!response.ok) throw new Error(`Fetch Codex status failed: ${response.status}`);
  return response.json();
}

export async function startCodexChatGPTLogin(deviceAuth = false): Promise<CodexChatGPTLoginState> {
  const response = await apiFetch('/api/agents/codex/login/chatgpt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceAuth }),
  });
  if (!response.ok) throw new Error(`Start Codex ChatGPT login failed: ${response.status}`);
  return response.json();
}

export async function fetchCodexChatGPTLoginState(): Promise<CodexChatGPTLoginState> {
  const response = await apiFetch('/api/agents/codex/login/chatgpt');
  if (!response.ok) throw new Error(`Fetch Codex ChatGPT login failed: ${response.status}`);
  return response.json();
}

export interface QuiverModel {
  id: string;
  name: string;
  description?: string | null;
  input_modalities: string[];
  output_modalities: string[];
  supported_operations: string[];
  pricing_credits: Record<string, number>;
}

export async function fetchQuiverModels(): Promise<{ models: QuiverModel[]; count: number }> {
  const response = await apiFetch('/api/quiver/models');
  if (!response.ok) {
    // 400 is the offline-fallback signal — frontend uses hardcoded
    // arrow-1 / arrow-1.1 / arrow-1.1-max if QUIVER_API_KEY is unset.
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON error responses still fall back to the status message. */
    }
    throw new Error(detail || `Fetch Quiver models failed: ${response.status}`);
  }
  return response.json();
}

export interface ReplicateSchema {
  version_id: string;
  model_id: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  description: string;
}

export async function fetchCLIGraph(): Promise<{
  nodes: unknown[];
  edges: unknown[];
  empty: boolean;
  activeProjectId?: string | null;
  workspaceRevision?: string;
  providerRecoveries?: ProviderRecoveryCheckpoint[];
  providerStartAmbiguities?: ProviderStartAmbiguity[];
  executionStatuses?: ExecutionStatusResult[];
  /** Agent edits waiting for a canvas to lay out their new nodes (services/canvas_arrange.py). */
  arrange?: unknown;
}> {
  const response = await apiFetch('/api/graph/export');
  if (!response.ok) throw new Error(`Fetch CLI graph failed: ${response.status}`);
  return rewriteBackendAssetUrls(await response.json());
}

export async function fetchReplicateSchema(owner: string, name: string): Promise<ReplicateSchema> {
  const response = await apiFetch(`/api/replicate/schema/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`Fetch Replicate schema failed: ${response.status}`);
  return response.json();
}

// ---------------------------------------------------------------------------
// Character CRUD helpers
// ---------------------------------------------------------------------------

type CharacterCreateInput = Omit<Character, 'id' | 'version' | 'thumbnail' | 'createdAt' | 'updatedAt'>;
type CharacterUpdateInput = Partial<CharacterCreateInput>;

export async function fetchCharacters(scope: 'project' | 'global', projectId?: string): Promise<Character[]> {
  const params = new URLSearchParams({ scope });
  if (scope === 'project') params.append('projectId', await resolveProjectId(projectId));
  const response = await apiFetch(`/api/characters?${params.toString()}`);
  if (!response.ok) throw new Error(`Fetch characters failed: ${response.status}`);
  return response.json();
}

/** One Character by id, or null when there's none (deleted, or never existed). */
export async function fetchCharacter(id: string): Promise<Character | null> {
  const response = await apiFetch(`/api/characters/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Fetch character failed: ${response.status}`);
  return response.json();
}

export async function createCharacter(body: CharacterCreateInput): Promise<Character> {
  const response = await apiFetch('/api/characters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Create character failed: ${response.status}`);
  return response.json();
}

/** Why a Studio save failed. Someone (often an agent) may have moved the
 * asset to Recently deleted while it was open: say so, since restoring it and
 * saving again keeps the edits (backend main.py _asset_not_found). */
async function saveFailure(response: Response, kind: 'moodboard' | 'character', fallback: string): Promise<Error> {
  if (response.status === 404) {
    try {
      const body = await response.json() as { code?: unknown; trashed?: { deletedBy?: { kind?: string; name?: string } } };
      if (body?.code === 'in_trash') {
        const by = body.trashed?.deletedBy;
        const who = !by || by.kind === 'person' ? '' : ` by ${actorLabel(by)}`;
        const noun = kind === 'moodboard' ? 'board' : 'Character';
        return new Error(`This ${noun} was moved to Recently deleted${who}. Restore it from the list on the left, then Retry to save your changes.`);
      }
    } catch { /* not JSON: plain not found */ }
  }
  return new Error(fallback);
}

/** A 409 from a Character PUT sent with `baseVersion`: someone else saved it
 *  since it was read. The answer carries the Character as it is now. */
async function characterConflict(response: Response): Promise<CharacterVersionConflict | null> {
  if (response.status !== 409) return null;
  try {
    const body = await response.clone().json() as { code?: string; character?: Character };
    return body.code === 'version_conflict' && body.character ? new CharacterVersionConflict(body.character) : null;
  } catch {
    return null;
  }
}

/** With `baseVersion`, a Character saved elsewhere since is a
 *  CharacterVersionConflict, not an overwrite. */
export async function updateCharacter(id: string, body: CharacterUpdateInput & { baseVersion?: number }): Promise<Character> {
  const response = await apiFetch(`/api/characters/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await characterConflict(response) ?? await saveFailure(response, 'character', `Update character failed: ${response.status}`);
  }
  return response.json();
}

/** Moves the Character to Recently deleted; the result is its trash record. */
export async function deleteCharacter(id: string): Promise<TrashedItem> {
  const response = await apiFetch(`/api/characters/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Delete character failed: ${response.status}`);
  return ((await response.json()) as { trashed: TrashedItem }).trashed;
}

// ---------------------------------------------------------------------------
// Moodboard CRUD helpers
// ---------------------------------------------------------------------------

// The board's layout fields are never sent: the backend refuses them on a save.
type MoodboardCreateInput = Omit<Moodboard, 'id' | 'version' | 'thumbnail' | 'createdAt' | 'updatedAt' | 'brief'
  | 'briefOverride' | 'layoutVersion' | 'frames' | 'suggestions' | 'readings'>
  & { briefOverride?: { text: string } | null };
type MoodboardUpdateInput = Partial<MoodboardCreateInput>;

/** Why a moodboard call failed, as copy (lib/errorCopy.ts, GM error-copy):
 *  GM's "Nebula didn't respond. Try again." for 408, 429 and 5xx; else the
 *  backend's reason (a string, or FastAPI's list of field errors) after
 *  "<what> failed:", so Studio can say what to fix; else GM's line for the
 *  status, which stands alone as GM's other lines do. Never the status code;
 *  the error keeps it, and the raw detail, for debugging. */
async function moodboardError(response: Response, what: string): Promise<Error> {
  const body = await readDetail(response);
  let detail = detailText(body);
  if (Array.isArray(body)) {
    detail = body.map((item: { loc?: unknown[]; msg?: string }) =>
      [Array.isArray(item.loc) ? item.loc.filter((part) => part !== 'body').join('.') : '', item.msg ?? '']
        .filter(Boolean).join(': ')).join('; ');
  }
  const message = failureKind(response.status) === 'refused' && detail
    ? `${what} failed: ${detail}`
    : copyForStatus(response.status, undefined);
  return new RequestFailedError(message, response.status, body);
}

/** Why a read of a board failed, as copy: GM's lines for 408, 429 and 5xx,
 *  else the backend's reason, else GM's line for the status. */
async function loadError(response: Response): Promise<Error> {
  const detail = await readDetail(response);
  return new RequestFailedError(copyForStatus(response.status, detail), response.status, detail);
}

/** Why a write to a saved board failed: that it went to Recently deleted
 * meanwhile (saveFailure), else the backend's reason (moodboardError). */
async function moodboardWriteError(response: Response, what: string): Promise<Error> {
  if (response.status === 404) {
    const trashed = await saveFailure(response.clone(), 'moodboard', '');
    if (trashed.message) return trashed;
  }
  return moodboardError(response, what);
}

export async function fetchMoodboards(scope: 'project' | 'global', projectId?: string): Promise<Moodboard[]> {
  const params = new URLSearchParams({ scope });
  if (scope === 'project') params.append('projectId', await resolveProjectId(projectId));
  const response = await apiFetch(`/api/moodboards?${params.toString()}`);
  if (!response.ok) throw await loadError(response);
  return response.json();
}

/** One Moodboard by id, or null when there's none (deleted, or never existed). */
export async function fetchMoodboard(id: string): Promise<Moodboard | null> {
  const response = await apiFetch(`/api/moodboards/${encodeURIComponent(id)}`);
  if (response.status === 404) return null;
  if (!response.ok) throw await loadError(response);
  return response.json();
}

export async function createMoodboard(body: MoodboardCreateInput): Promise<Moodboard> {
  const response = await apiFetch('/api/moodboards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await moodboardError(response, 'Create moodboard');
  return response.json();
}

/** A 409 from a write sent with `baseVersion`: someone else saved the board
 *  since it was read. The answer carries the board as it is now. */
async function moodboardConflict(response: Response): Promise<MoodboardVersionConflict | null> {
  if (response.status !== 409) return null;
  try {
    const body = await response.clone().json() as { code?: string; board?: Moodboard };
    return body.code === 'version_conflict' && body.board ? new MoodboardVersionConflict(body.board) : null;
  } catch {
    return null;
  }
}

/** Board fields only (the Studio sends images as checked edits, below).
 *  With `baseVersion`, a board saved elsewhere since is a
 *  MoodboardVersionConflict, not an overwrite. The answer is the board plus
 *  `undo`, the `restore` that takes this write back (absent on an older
 *  backend). */
export async function updateMoodboard(id: string, body: MoodboardUpdateInput & { baseVersion?: number }):
  Promise<Moodboard & { undo?: MoodboardEditResult['undo'] }> {
  const response = await apiFetch(`/api/moodboards/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await moodboardConflict(response) ?? await moodboardWriteError(response, 'Save');
  return response.json();
}

/** Checked board edits (`POST /api/moodboards/{id}/edits`): the ops land
 *  together, or none do. */
export async function editMoodboard(id: string, ops: MoodboardOp[], baseVersion?: number): Promise<MoodboardEditResult> {
  const response = await apiFetch(`/api/moodboards/${encodeURIComponent(id)}/edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseVersion === undefined ? { ops } : { ops, baseVersion }),
  });
  if (!response.ok) throw await moodboardConflict(response) ?? await moodboardWriteError(response, 'Save');
  return response.json();
}

export async function analyzeMoodboard(id: string): Promise<Moodboard> {
  const response = await apiFetch(`/api/moodboards/${id}/analyze`, { method: 'POST' });
  if (!response.ok) throw await moodboardError(response, 'Analyze');
  return response.json();
}

/** Keep a board's hand-written brief after the board changed: clears
 *  "board changed since you edited this" until the next change. */
export async function keepMoodboardBriefOverride(id: string): Promise<Moodboard> {
  const response = await apiFetch(`/api/moodboards/${encodeURIComponent(id)}/brief-override/keep`, { method: 'POST' });
  if (!response.ok) throw await moodboardWriteError(response, 'Keep brief');
  return response.json();
}

/** Moves the board to Recently deleted; the result is its trash record. */
export async function deleteMoodboard(id: string): Promise<TrashedItem> {
  const response = await apiFetch(`/api/moodboards/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) throw await moodboardError(response, 'Delete');
  return ((await response.json()) as { trashed: TrashedItem }).trashed;
}

/** What a move answered (backend main.py _move_stored_asset). `from` / `to`
 * are canvas project ids, null for Global. */
export interface StoredAssetMove<T> {
  status: 'moved' | 'unchanged';
  from: string | null;
  to: string | null;
  fromName: string;
  toName: string;
  detail: string;
  asset: T;
}

/** Move a saved board or Character to a canvas project (`projectId`) or to
 * Global (null). Only where it's listed changes: its id, version and
 * contents stay, and nodes that use it work in every project. */
export async function moveStoredAsset<K extends 'moodboard' | 'character'>(
  kind: K, id: string, projectId: string | null,
): Promise<StoredAssetMove<K extends 'moodboard' ? Moodboard : Character>> {
  const response = await apiFetch(`/api/${kind === 'moodboard' ? 'moodboards' : 'characters'}/${encodeURIComponent(id)}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId }),
  });
  if (!response.ok) throw await moodboardError(response, 'Move');
  return response.json();
}

// ---------------------------------------------------------------------------
// One saved asset as a card shows it: live, in Recently deleted, or gone
// ---------------------------------------------------------------------------

export type StoredAssetLookup<T> =
  | { status: 'ready'; asset: T }
  | { status: 'trashed'; trashed: TrashedItem }
  | { status: 'missing' };

/** A moodboard or character by id. A 404 whose body says `in_trash` (backend
 * main.py _asset_not_found) is in Recently deleted and can be restored. */
export async function lookupStoredAsset<K extends 'moodboard' | 'character'>(
  kind: K, id: string,
): Promise<StoredAssetLookup<K extends 'moodboard' ? Moodboard : Character>> {
  const response = await apiFetch(`/api/${kind === 'moodboard' ? 'moodboards' : 'characters'}/${encodeURIComponent(id)}`);
  if (response.status === 404) {
    try {
      const body = await response.json() as { code?: unknown; trashed?: TrashedItem };
      if (body?.code === 'in_trash' && body.trashed) return { status: 'trashed', trashed: body.trashed };
    } catch { /* not JSON: plain not found */ }
    return { status: 'missing' };
  }
  if (!response.ok) throw await loadError(response);
  return { status: 'ready', asset: await response.json() };
}
