import { providerCheckIsCurrent, PROVIDER_KEY_LABELS, type ProviderHealthState } from '../../../lib/providerReadiness';

export type RowTone = 'ok' | 'warn' | 'busy' | 'idle';

export const KREA_ROW = 'krea-sign-in';
export const NOUS_ROW = 'nous-sign-in';

/*
 * Adding or removing a key moves its row between the Connected and Add lists,
 * which remounts it. The row that lands takes focus so a keyboard user's
 * place isn't dropped.
 */
let focusOnMount: string | null = null;
export function focusRowAfterMove(key: string) { focusOnMount = key; }
export function cancelRowFocus(key: string) { if (focusOnMount === key) focusOnMount = null; }
/** True once, for the row that should take focus as it mounts. */
export function takeRowFocus(key: string): boolean {
  if (focusOnMount !== key) return false;
  focusOnMount = null;
  return true;
}

/** The keys and the Krea sign-in counted as connected, as the Providers tab
 * shows them: a row held where it stood while the person is in it counts in
 * the section it is shown in (GM, PR #203 r21 item 3), so the badge and
 * "Connected · N" agree. */
export function shownConnected(apiKeys: Readonly<Record<string, string>>, kreaSignedIn: boolean,
  held: Readonly<Record<string, boolean>>): number {
  const ids = new Set([...Object.keys(apiKeys).filter((key) => apiKeys[key]?.trim()), ...(kreaSignedIn ? [KREA_ROW] : [])]);
  for (const [id, shown] of Object.entries(held)) {
    if (id === NOUS_ROW) continue;
    if (shown) ids.add(id); else ids.delete(id);
  }
  return ids.size;
}

/** What the last check said about a saved key, in the row's own words. */
export function keyStatus(key: string, health: ProviderHealthState): { tone: RowTone; status: string; statusTone?: 'ok' | 'warn' } {
  if (health.loading) return { tone: 'busy', status: 'Checking… nothing is generated' };
  const entry = health.providers[PROVIDER_KEY_LABELS[key] ?? key];
  if (!providerCheckIsCurrent(entry, health.checkedAt)) {
    return health.error ? { tone: 'warn', status: "Couldn't check", statusTone: 'warn' } : { tone: 'idle', status: 'Saved' };
  }
  switch (entry.status) {
    case 'valid': return { tone: 'ok', status: 'Connected', statusTone: 'ok' };
    case 'configured_unverified': return { tone: 'idle', status: 'Saved' };
    case 'invalid': return { tone: 'warn', status: 'Key rejected', statusTone: 'warn' };
    case 'unauthorized': return { tone: 'warn', status: 'No API access', statusTone: 'warn' };
    case 'insufficient_credits': return { tone: 'warn', status: 'Out of credits', statusTone: 'warn' };
    default: return { tone: 'warn', status: "Couldn't check", statusTone: 'warn' };
  }
}

export type ServiceAccountCheck =
  | { ok: true; email: string; project: string }
  | { ok: false; error: string };

/** Reads a Google service-account key without ever echoing the private key. */
export function readServiceAccount(text: string): ServiceAccountCheck {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, error: "That isn't valid JSON." }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: "That isn't a service-account key." };
  const key = value as Record<string, unknown>;
  if (key.type !== 'service_account') return { ok: false, error: 'This JSON is not a service-account key ("type" should be "service_account").' };
  if (typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) return { ok: false, error: 'The key file has no private key.' };
  if (typeof key.client_email !== 'string' || !key.client_email.includes('@')) return { ok: false, error: 'The key file has no service-account email.' };
  if (typeof key.project_id !== 'string' || !key.project_id) return { ok: false, error: 'The key file has no project ID.' };
  return { ok: true, email: key.client_email, project: key.project_id };
}
