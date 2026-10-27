/**
 * Whether this tab last found Nebula's backend reachable: what the offline
 * banner shows (BackendConnectionStatus, which probes /api/health every few
 * seconds and notes each answer here). An add reads it so it can say GM's
 * offline line before it sends anything (round 13 of PR #114).
 */
export type BackendConnection = 'online' | 'offline';

let connection: BackendConnection = 'online';

export function noteBackendConnection(next: BackendConnection): void {
  connection = next;
}

export function isBackendOffline(): boolean {
  return connection === 'offline';
}
