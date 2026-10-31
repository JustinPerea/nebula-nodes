import { isBecauseLine } from '../lib/notConnectedLine';
import { useBackendOffline } from '../lib/useBackendOffline';

/**
 * PR #204 round 14 (GM r23 3): offline comes first. A not-connected line (a because line) is
 * hidden while Nebula is offline, since the offline notice says what is wrong and connecting the
 * tab wouldn't be enough; any other failure's line stays. Back online it shows again if it still
 * applies. The one rule for every because line on screen: every Commons line (here or through
 * CommonsErrorLine), Settings' held views, and the action lines listed in the round 14 notes. A
 * lock's own line gets the same rule inside usePersonLock.
 */
export function useOfflineFirstBecause<T extends string | null | undefined>(line: T): T | null {
  const offline = useBackendOffline();
  return offline && line && isBecauseLine(line) ? null : line;
}
