import { apiFetch, rewriteBackendAssetUrls } from './backend';
import type { Character, Moodboard } from '../types';

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

export async function executeGraph(
  nodes: Array<{ id: string; definitionId: string; params: Record<string, unknown>; outputs: Record<string, unknown> }>,
  edges: Array<{ id: string; source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }>,
  runId?: string,
): Promise<ExecutionStartResult> {
  const response = await apiFetch('/api/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges, runId }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON error responses still fall back to status text. */
    }
    throw new Error(detail || `Execute failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export async function executeNode(
  nodes: Array<{ id: string; definitionId: string; params: Record<string, unknown>; outputs: Record<string, unknown> }>,
  edges: Array<{ id: string; source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }>,
  targetNodeId: string,
  runId?: string,
): Promise<ExecutionStartResult> {
  const response = await apiFetch('/api/execute-node', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges, targetNodeId, runId }),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON error responses still fall back to status text. */
    }
    throw new Error(detail || `Execute node failed: ${response.status} ${response.statusText}`);
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
    throw new Error(detail || `Generate shot failed: ${response.status} ${response.statusText}`);
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
    // user to run `hermes auth`.
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {
      /* Non-JSON error responses still fall back to the status message. */
    }
    throw new Error(detail || `Fetch Nous models failed: ${response.status}`);
  }
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

export async function fetchCLIGraph(): Promise<{ nodes: unknown[]; edges: unknown[]; empty: boolean }> {
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
  if (scope === 'project' && projectId) params.append('projectId', projectId);
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
  if (scope === 'project' && projectId) params.append('projectId', projectId);
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
