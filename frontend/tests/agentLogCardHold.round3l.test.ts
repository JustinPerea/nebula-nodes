import { afterEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../src/store/uiStore';

/**
 * PR #216 round 3l, review 4 logic NIT-1 (review 3's F8, uiStore
 * setAgentLogOpen): a collapse made while the card holds the log folded is
 * the person's (or an agent's) own, so the card's hold lets go of it and the
 * card's leave never reopens it; an opening over the fold is refused for the
 * card.
 */
afterEach(() => {
  useUIStore.setState({ agentLogOpen: false, agentLogCardHold: 'none', agentLogEnabled: true } as never);
});

describe('setAgentLogOpen over the card\'s fold', () => {
  it('a collapse while the card holds it folded: the hold becomes none, and the card leaving keeps it closed', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: false, agentLogCardHold: 'card' } as never);
    useUIStore.getState().setAgentLogOpen(false);
    expect(useUIStore.getState().agentLogCardHold).toBe('none');
    useUIStore.getState().holdAgentLogForCard(false, false);
    expect(useUIStore.getState().agentLogOpen).toBe(false);
  });

  it('an opening over the fold: refused for the card, until the card goes', () => {
    useUIStore.setState({ agentLogEnabled: true, agentLogOpen: false, agentLogCardHold: 'card' } as never);
    useUIStore.getState().setAgentLogOpen(true);
    expect(useUIStore.getState()).toMatchObject({ agentLogOpen: true, agentLogCardHold: 'refused' });
    useUIStore.getState().holdAgentLogForCard(true, true);
    expect(useUIStore.getState().agentLogOpen).toBe(true);
    useUIStore.getState().holdAgentLogForCard(false, false);
    expect(useUIStore.getState().agentLogCardHold).toBe('none');
  });
});
