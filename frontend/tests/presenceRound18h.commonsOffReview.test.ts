/**
 * PR #204 round 18h (GM r37, r38 1): Review on a Commons proposal while the Commons is off says
 * why and how, with no parens: "Commons is turned off because Nebula started without it.
 * Restart Nebula with NEBULA_COMMONS_ENABLED=1 to review this proposal." Both ways a tab learns
 * it is off: it loaded with the capability off, or its Commons calls heard it since (a restart
 * without it; the live check found that tab used to open the Commons' off view instead).
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { reviewAssetProposal } from '../src/lib/assetProposalReview';
import { noteCommonsAnswered, noteCommonsOff } from '../src/lib/commonsOff';
import { useUIStore } from '../src/store/uiStore';

const LINE = 'Commons is turned off because Nebula started without it. Restart Nebula with NEBULA_COMMONS_ENABLED=1 to review this proposal.';
const op = { kind: 'proposal.review', proposalId: 'p1', target: 'commons', targetId: 'a1' };
const initial = useUIStore.getState();
beforeEach(() => { useUIStore.setState(initial, true); noteCommonsAnswered(); });
afterEach(() => { noteCommonsAnswered(); });

it('a tab that loaded with the Commons off', async () => {
  useUIStore.setState({ commonsEnabled: false });
  await expect(reviewAssetProposal(op)).rejects.toThrow(LINE);
});

it('a tab whose Commons calls heard it is off since', async () => {
  useUIStore.setState({ commonsEnabled: true });
  noteCommonsOff();
  await expect(reviewAssetProposal(op)).rejects.toThrow(LINE);
  expect(useUIStore.getState().viewMode).not.toBe('commons');
});
