import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExecutionEvent } from '../lib/wsClient';

let handler: ((event: ExecutionEvent) => void) | null = null;
vi.mock('../lib/wsClient', () => ({ wsClient: { subscribe: (fn: (event: ExecutionEvent) => void) => { handler = fn; return () => {}; } } }));
const list = vi.fn();
vi.mock('../lib/assetProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/assetProposals')>()),
  listAssetProposals: () => list(),
}));

await import('./assetProposalsSocket');
const { useAssetProposalsStore } = await import('./assetProposalsStore');
const { coverProposal } = await import('../test/assetProposalFixtures');

const send = (event: unknown) => handler?.(event as ExecutionEvent);

describe('asset proposals over the socket', () => {
  beforeEach(() => {
    useAssetProposalsStore.getState().clear();
    list.mockReset();
  });

  it('opens, syncs and closes from browser messages', () => {
    send({ type: 'assetProposalOpened', proposal: coverProposal(), acceptKey: 'k1' });
    expect(useAssetProposalsStore.getState().proposals.pa_00000001.acceptKey).toBe('k1');
    send({ type: 'assetProposalClosed', proposalId: 'pa_00000001', status: 'rejected', kind: 'project', targetId: 'dusk' });
    expect(useAssetProposalsStore.getState().proposals.pa_00000001.closing).toBe('rejected');
    send({ type: 'assetProposalSync', proposals: [{ ...coverProposal({ id: 'pa_00000009' }), acceptKey: 'k9' }] });
    expect(Object.keys(useAssetProposalsStore.getState().proposals)).toEqual(['pa_00000009']);
  });

  it('asks the backend again when a target it waits on changes', async () => {
    list.mockResolvedValue([]);
    send({ type: 'projectsChanged', change: 'saved', projectId: 'other' });
    expect(list).not.toHaveBeenCalled(); // nothing open: nothing to check
    send({ type: 'assetProposalOpened', proposal: coverProposal(), acceptKey: 'k1' });
    send({ type: 'projectsChanged', change: 'cover', projectId: 'dusk' });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useAssetProposalsStore.getState().proposals.pa_00000001.closing).toBe('invalidated'));
  });

  it('keeps a proposal that opened while the list was on its way', async () => {
    let answer: (views: unknown[]) => void = () => {};
    list.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    send({ type: 'assetProposalOpened', proposal: coverProposal(), acceptKey: 'k1' });
    send({ type: 'projectsChanged', change: 'cover', projectId: 'dusk' });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    // Proposed after the backend answered the list, but heard before the answer arrived.
    send({ type: 'assetProposalOpened', proposal: coverProposal({ id: 'pa_00000002' }), acceptKey: 'k2' });
    answer([]);
    await vi.waitFor(() => expect(useAssetProposalsStore.getState().proposals.pa_00000001.closing).toBe('invalidated'));
    expect(useAssetProposalsStore.getState().proposals.pa_00000002.closing).toBeUndefined();
  });
});
