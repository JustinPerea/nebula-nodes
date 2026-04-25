const API_BASE = '/api';

export async function executeGraph(
  nodes: Array<{ id: string; definitionId: string; params: Record<string, unknown>; outputs: Record<string, unknown> }>,
  edges: Array<{ id: string; source: string; sourceHandle: string | null | undefined; target: string; targetHandle: string | null | undefined }>,
): Promise<{ status: string; errorCount?: number }> {
  const response = await fetch(`${API_BASE}/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges }),
  });
  if (!response.ok) throw new Error(`Execute failed: ${response.status} ${response.statusText}`);
  return response.json();
}

export async function executeNode(
  nodes: Array<{ id: string; definitionId: string; params: Record<string, unknown>; outputs: Record<string, unknown> }>,
  edges: Array<{ id: string; source: string; sourceHandle: string | null | undefined; target: string; targetHandle: string | null | undefined }>,
  targetNodeId: string,
): Promise<{ status: string; nodeCount?: number; errorCount?: number }> {
  const response = await fetch(`${API_BASE}/execute-node`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodes, edges, targetNodeId }),
  });
  if (!response.ok) throw new Error(`Execute node failed: ${response.status} ${response.statusText}`);
  return response.json();
}

export async function getSettings(): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE}/settings`);
  if (!response.ok) throw new Error(`Get settings failed: ${response.status}`);
  return response.json();
}

export async function updateSettings(settings: Record<string, unknown>): Promise<{ status: string }> {
  const response = await fetch(`${API_BASE}/settings`, {
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
  const response = await fetch(`${API_BASE}/openrouter/models`);
  if (!response.ok) throw new Error(`Fetch OpenRouter models failed: ${response.status}`);
  return response.json();
}

// Nous Portal models share the OpenRouter shape after the backend slims them.
// Reuse the type alias instead of duplicating the interface.
export type NousModel = OpenRouterModel;

export async function fetchNousModels(): Promise<{ models: NousModel[]; count: number }> {
  const response = await fetch(`${API_BASE}/nous/models`);
  if (!response.ok) {
    // Surface the backend's auth message verbatim — usually instructs the
    // user to run `hermes auth`.
    let detail = '';
    try { detail = (await response.json()).detail ?? ''; } catch {}
    throw new Error(detail || `Fetch Nous models failed: ${response.status}`);
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
  const response = await fetch(`${API_BASE}/graph/export`);
  if (!response.ok) throw new Error(`Fetch CLI graph failed: ${response.status}`);
  return response.json();
}

export async function fetchReplicateSchema(owner: string, name: string): Promise<ReplicateSchema> {
  const response = await fetch(`${API_BASE}/replicate/schema/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  if (!response.ok) throw new Error(`Fetch Replicate schema failed: ${response.status}`);
  return response.json();
}
