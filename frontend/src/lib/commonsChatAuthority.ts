import { personTokenForSocket } from './backend';
import { commonsSessionCopy } from './errorCopy';
import { inDesktopShell } from './personSession';

export interface ChatAuthority {
  personToken?: string;
  brand?: string | null;
}

/** What a chat send carries: the person token for this socket's backend (the
 * backend starts no turn without it) and, with Commons on, the brand. Commons
 * turns need the token up front; other turns go out without it and the
 * backend answers person_required, which the panel shows. */
export async function chatAuthority(socketUrl: string, commonsEnabled: boolean, brand: string): Promise<ChatAuthority> {
  const personToken = await personTokenForSocket(socketUrl);
  if (!commonsEnabled) return personToken ? { personToken } : {};
  // No person session (GM, error-copy round 2): the chat panel shows this
  // line under its own send; the same words as the Commons' own 401.
  if (!personToken) throw new Error(commonsSessionCopy(inDesktopShell()));
  return { brand: brand.trim() || null, personToken };
}
