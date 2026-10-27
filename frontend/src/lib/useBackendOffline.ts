import { useSyncExternalStore } from 'react';
import { isBackendOffline, subscribeBackendConnection } from './backendConnection';

/** Whether Nebula is offline, for read-only cues (round 14 of PR #114). */
export function useBackendOffline(): boolean {
  return useSyncExternalStore(subscribeBackendConnection, isBackendOffline, isBackendOffline);
}
