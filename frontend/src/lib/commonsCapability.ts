import { apiFetch } from './backend';

/** What the backend said about the Commons: `unknown` when it gave no readable answer. */
export type CommonsCapability = 'on' | 'off' | 'unknown';

/** This endpoint reports configuration only: no store, session, or worker access. */
export async function fetchCommonsCapability(): Promise<CommonsCapability> {
  try {
    const response = await apiFetch('/api/capabilities/commons');
    if (!response.ok) return 'unknown';
    const result: unknown = await response.json();
    if (typeof result !== 'object' || result === null || !('enabled' in result)) return 'unknown';
    return result.enabled === true ? 'on' : result.enabled === false ? 'off' : 'unknown';
  } catch { return 'unknown'; }
}

/** Whether the backend opted in; anything but an explicit yes is no. */
export async function fetchCommonsEnabled(): Promise<boolean> {
  return (await fetchCommonsCapability()) === 'on';
}
