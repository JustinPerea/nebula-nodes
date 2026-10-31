import { personTokenForSocket } from './backend';
import { commonsNotConnectedCopy, FailureNotice, PERSON_REQUIRED_CODE } from './errorCopy';
import { personPromotions } from './personSession';

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
  // No person session: this tab isn't connected as the person (GM r12 (2), #204 round 9). The
  // chat panel shows the because line under its own send, and it clears on the promote.
  if (!personToken) {
    throw new FailureNotice('', commonsNotConnectedCopy("Couldn’t send the message."),
      { code: PERSON_REQUIRED_CODE, sentAt: personPromotions() });
  }
  return { brand: brand.trim() || null, personToken };
}
