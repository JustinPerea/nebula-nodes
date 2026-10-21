import { apiFetch } from './backend';
import { resolveProjectId } from './currentProject';

export interface Preset {
  id: string;
  name: string;
  category: string;
  prompt: string;
  params: Record<string, unknown>;
  modelId: string | null;
  refImages: string[];
  thumbnail: string;
  /** Edit counter; the backend adds 1 on every update. */
  version: number;
  /** The params version `params` are at. The backend upgrades older presets
   * when it reads them (services/preset_store.py), so this is the current
   * version or newer. */
  paramsVersion?: number;
  scope: 'global' | 'project';
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PresetCreateInput = {
  name: string;
  category: string;
  prompt: string;
  params: Record<string, unknown>;
  modelId: string | null;
  refImages: string[];
  scope: 'global' | 'project';
  projectId?: string;
  thumbnail?: string;
  /** The version `params` were made at (GRAPH_PARAMS_VERSION for the current
   * draft). A body without it is read as version 0 (a bundle older than the
   * marker), so the backend would upgrade a 4,096 the user set on purpose. */
  paramsVersion: number;
};

export async function fetchPresets(scope: 'global' | 'project', projectId?: string): Promise<Preset[]> {
  const params = new URLSearchParams({ scope });
  if (scope === 'project') params.append('projectId', await resolveProjectId(projectId));
  const res = await apiFetch(`/api/presets?${params.toString()}`);
  if (!res.ok) throw new Error(`Fetch presets failed: ${res.status}`);
  return res.json();
}

export async function createPreset(body: PresetCreateInput): Promise<Preset> {
  const resolvedBody = body.scope === 'project'
    ? { ...body, projectId: await resolveProjectId(body.projectId) }
    : body;
  const res = await apiFetch('/api/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(resolvedBody),
  });
  if (!res.ok) {
    // A refusal says why (an image that isn't one of Nebula's files, a
    // project in Recently deleted), so Create can show it as it is.
    const body = await res.json().catch(() => null) as { detail?: unknown } | null;
    throw new Error(typeof body?.detail === 'string' ? body.detail : `Create preset failed: ${res.status}`);
  }
  return res.json();
}

/** Move a Style to Recently deleted (backend services/preset_store.py);
 * `restoreTrashed('style', id)` brings it back with the same id. */
export async function deletePreset(id: string): Promise<void> {
  const res = await apiFetch(`/api/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.ok) return;
  let detail = '';
  try {
    const body = await res.json() as { detail?: unknown };
    if (typeof body?.detail === 'string') detail = body.detail;
  } catch { /* not JSON */ }
  throw new Error(detail || `Delete failed: ${res.status}`);
}
