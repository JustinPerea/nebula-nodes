import { apiFetch, rewriteBackendAssetUrls } from './backend';
import { resolveProjectId } from './currentProject';
import type { Character, Moodboard } from '../types';
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

/** The exact config for one agent app (backend services/agent_connect.py). Holds the token: shown once. */
export interface AgentSetup {
  client: string;
  label: string;
  kind: 'command' | 'json' | 'manual';
  format: 'json' | 'yaml' | 'shell' | 'toml' | 'text';
  where: string;
  snippet: string;
  steps: string[];
  alternative: { format: string; where: string; snippet: string } | null;
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

/** The token is in this response only; the backend keeps a hash. */
export function createConnectedApp(
  name: string,
  dailyUsd: number | null,
  options: { client?: string; color?: string | null } = {},
): Promise<{ app: ConnectedApp; token: string; setup?: AgentSetup }> {
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
  id: string, changes: Partial<Pick<PersonalAgent, 'enabled' | 'displayName' | 'color' | 'command' | 'args'>>,
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

export async function createCharacter(body: CharacterCreateInput): Promise<Character> {
  const response = await apiFetch('/api/characters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Create character failed: ${response.status}`);
  return response.json();
}

export async function updateCharacter(id: string, body: CharacterUpdateInput): Promise<Character> {
  const response = await apiFetch(`/api/characters/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Update character failed: ${response.status}`);
  return response.json();
}

export async function deleteCharacter(id: string): Promise<void> {
  const response = await apiFetch(`/api/characters/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Delete character failed: ${response.status}`);
}

// ---------------------------------------------------------------------------
// Moodboard CRUD helpers
// ---------------------------------------------------------------------------

type MoodboardCreateInput = Omit<Moodboard, 'id' | 'version' | 'thumbnail' | 'createdAt' | 'updatedAt'>;
type MoodboardUpdateInput = Partial<MoodboardCreateInput>;

export async function fetchMoodboards(scope: 'project' | 'global', projectId?: string): Promise<Moodboard[]> {
  const params = new URLSearchParams({ scope });
  if (scope === 'project') params.append('projectId', await resolveProjectId(projectId));
  const response = await apiFetch(`/api/moodboards?${params.toString()}`);
  if (!response.ok) throw new Error(`Fetch moodboards failed: ${response.status}`);
  return response.json();
}

export async function createMoodboard(body: MoodboardCreateInput): Promise<Moodboard> {
  const response = await apiFetch('/api/moodboards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Create moodboard failed: ${response.status}`);
  return response.json();
}

export async function updateMoodboard(id: string, body: MoodboardUpdateInput): Promise<Moodboard> {
  const response = await apiFetch(`/api/moodboards/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Update moodboard failed: ${response.status}`);
  return response.json();
}

export async function analyzeMoodboard(id: string): Promise<Moodboard> {
  const response = await apiFetch(`/api/moodboards/${id}/analyze`, { method: 'POST' });
  if (!response.ok) throw new Error(`Analyze moodboard failed: ${response.status}`);
  return response.json();
}

export async function deleteMoodboard(id: string): Promise<void> {
  const response = await apiFetch(`/api/moodboards/${id}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`Delete moodboard failed: ${response.status}`);
}
