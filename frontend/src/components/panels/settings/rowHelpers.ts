import { isKeySet } from '../../../lib/directRoute';
import { PROVIDER_KEYS } from '../../../lib/providerCatalog';
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
/** Ask for the handoff only when the change moves the row: from the section
 * it is shown in now (a held row's, else where its key puts it) to the one
 * ``after`` names. A row that stays where it is never remounts, and a handoff
 * left waiting would take focus from wherever the person is the next time
 * the row mounts, a tab switch say (review 11 of PR #203, copy LOW-1). */
export function focusRowIfItMoves(key: string, shownNow: boolean, after: boolean) {
  if (shownNow !== after) focusRowAfterMove(key); else cancelRowFocus(key);
}
/** A handoff the write didn't use is dropped once the write settles and the
 * panel has drawn: the row that moved took it as it mounted. */
export function settleRowFocus(key: string) {
  requestAnimationFrame(() => requestAnimationFrame(() => cancelRowFocus(key)));
}
/** True once, for the row that should take focus as it mounts. */
export function takeRowFocus(key: string): boolean {
  if (focusOnMount !== key) return false;
  focusOnMount = null;
  return true;
}

/** What decides which rows are connected: the saved keys, Krea's sign-in
 * status and the last Nous check. */
export interface ConnectionState {
  apiKeys: Readonly<Record<string, string>>;
  kreaStatus: string | null | undefined;
  health: Pick<ProviderHealthState, 'providers' | 'checkedAt'>;
}

/** Whether the last check found Nous signed in. */
export function nousConnected(health: Pick<ProviderHealthState, 'providers' | 'checkedAt'>): boolean {
  const entry = health.providers.Nous;
  return providerCheckIsCurrent(entry, health.checkedAt) && Boolean(entry?.configured);
}

/** Each row of the Providers tab by whether it is connected: the one
 * source for the section a row is listed in, the "Connected · N" heading and
 * the tab's badge (review 11 of PR #203, copy NIT-2). A key row when its key
 * is set as the run reads it (isKeySet), Krea's sign-in row unless it is
 * disconnected (signing in and an error are listed with the connected), and
 * Nous when its last check found it signed in. */
export function connectedRows({ apiKeys, kreaStatus, health }: ConnectionState): Record<string, boolean> {
  return {
    ...Object.fromEntries(PROVIDER_KEYS.map((spec) => [spec.key, isKeySet(apiKeys, spec.key)])),
    [KREA_ROW]: !!kreaStatus && kreaStatus !== 'disconnected',
    [NOUS_ROW]: nousConnected(health),
  };
}

/** The rows counted as connected, as the Providers tab shows them: a row
 * held where it stood while the person is in it counts in the section it is
 * shown in (GM, PR #203 r21 item 3), so the badge and "Connected · N" agree. */
export function shownConnected(state: ConnectionState, held: Readonly<Record<string, boolean>>): number {
  const rows = connectedRows(state);
  return Object.keys(rows).filter((id) => (Object.hasOwn(held, id) ? held[id] : rows[id])).length;
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: "That isn't a service account key." };
  const key = value as Record<string, unknown>;
  if (key.type !== 'service_account') return { ok: false, error: 'This JSON is not a service account key ("type" should be "service_account").' };
  if (typeof key.private_key !== 'string' || !key.private_key.includes('PRIVATE KEY')) return { ok: false, error: 'The key file has no private key.' };
  if (typeof key.client_email !== 'string' || !key.client_email.includes('@')) return { ok: false, error: 'The key file has no service account email.' };
  if (typeof key.project_id !== 'string' || !key.project_id) return { ok: false, error: 'The key file has no project ID.' };
  return { ok: true, email: key.client_email, project: key.project_id };
}
