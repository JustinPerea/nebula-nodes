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
