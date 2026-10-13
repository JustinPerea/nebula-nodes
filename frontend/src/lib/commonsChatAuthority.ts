import { personTokenForSocket } from './backend';

const SESSION_MESSAGE = 'no UI session: use a fresh Commons dev link from the backend terminal';

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
  if (!personToken) throw new Error(SESSION_MESSAGE);
  return { brand: brand.trim() || null, personToken };
}
