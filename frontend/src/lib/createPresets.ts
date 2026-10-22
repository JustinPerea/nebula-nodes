import { apiRequest } from './apiRequest';
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
  const res = await apiRequest("Couldn't load the styles.", `/api/presets?${params.toString()}`);
  return res.json();
}

export async function createPreset(body: PresetCreateInput): Promise<Preset> {
  const resolvedBody = body.scope === 'project'
    ? { ...body, projectId: await resolveProjectId(body.projectId) }
    : body;
  // A refusal says why (an image that isn't one of Nebula's files, a
  // project in Recently deleted), so Create can show it after the heading.
  const res = await apiRequest("Couldn't save the style.", '/api/presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(resolvedBody),
  });
  return res.json();
}

/** Move a Style to Recently deleted (backend services/preset_store.py);
 * `restoreTrashed('style', id)` brings it back with the same id. */
export async function deletePreset(id: string): Promise<void> {
  await apiRequest("Couldn't delete the style.", `/api/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
