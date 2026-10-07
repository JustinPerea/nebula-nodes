import { apiFetch } from './backend';

/** This endpoint reports configuration only: no store, session, or worker access. */
export async function fetchCommonsEnabled(): Promise<boolean> {
  try {
    const response = await apiFetch('/api/capabilities/commons');
    if (!response.ok) return false;
    const result: unknown = await response.json();
    return typeof result === 'object' && result !== null
      && 'enabled' in result && result.enabled === true;
  } catch { return false; }
}
