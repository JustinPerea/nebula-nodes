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
  version: number;
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
  if (!res.ok) throw new Error(`Create preset failed: ${res.status}`);
  return res.json();
}

export async function deletePreset(id: string): Promise<void> {
  const res = await apiFetch(`/api/presets/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Delete preset failed: ${res.status}`);
}
