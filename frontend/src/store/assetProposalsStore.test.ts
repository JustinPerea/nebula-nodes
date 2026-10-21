import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commonsProposal, coverProposal } from '../test/assetProposalFixtures';

const accept = vi.fn();
const reject = vi.fn();
vi.mock('../lib/assetProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/assetProposals')>()),
  acceptAssetProposal: (...args: unknown[]) => accept(...args),
  rejectAssetProposal: (...args: unknown[]) => reject(...args),
}));

const { ASSET_PROPOSAL_EXIT_MS, proposalsFor, targetsOf, useAssetProposalsStore } = await import('./assetProposalsStore');
const { AssetProposalError } = await import('../lib/assetProposals');

describe('assetProposalsStore', () => {
  beforeEach(() => {
    useAssetProposalsStore.getState().clear();
    accept.mockReset();
    reject.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps only open proposals that came with a key, and never an unsafe colour', () => {
    useAssetProposalsStore.getState().sync([
      { ...coverProposal(), acceptKey: 'k1', agent: { id: 'x', name: 'X', color: 'red;background:url(x)' } },
      { ...coverProposal({ id: 'pa_00000002', status: 'accepted' }), acceptKey: 'k2' },
      { ...coverProposal({ id: 'pa_00000003' }), acceptKey: '' },
    ]);
    const { proposals } = useAssetProposalsStore.getState();
    expect(Object.keys(proposals)).toEqual(['pa_00000001']);
    expect(proposals.pa_00000001.view.agent.color).toBe('#5B9DFF');
    expect(proposals.pa_00000001.acceptKey).toBe('k1');
  });

  it('keeps commons proposals for their reference and names the references waiting', () => {
    const store = useAssetProposalsStore.getState();
    store.open(commonsProposal(), 'k1');
    store.open(commonsProposal({ id: 'pa_0000c002', target: { kind: 'commons', id: 'ast_2', name: '' } }), 'k2');
    store.open(coverProposal(), 'k3');
    const state = useAssetProposalsStore.getState();
    expect(proposalsFor(state, 'commons', 'ast_1').map((entry) => entry.view.id)).toEqual(['pa_0000c001']);
    expect(proposalsFor(state, 'commons', 'ast_1')[0].view.before?.[0]).toEqual({ value: 'A loud poster' });
    expect(targetsOf(state, 'commons')).toEqual(['ast_1', 'ast_2']);
    store.close({ proposalId: 'pa_0000c002', status: 'accepted' });
    expect(targetsOf(useAssetProposalsStore.getState(), 'commons')).toEqual(['ast_1']);
  });

  it('lists the proposals for one target only', () => {
    const store = useAssetProposalsStore.getState();
    store.open(coverProposal(), 'k1');
    store.open(coverProposal({ id: 'pa_00000002', target: { kind: 'project', id: 'other', name: 'Other' } }), 'k2');
    store.open(coverProposal({ id: 'pa_00000003', kind: 'moodboard', target: { kind: 'moodboard', id: 'dusk', name: 'Dusk' } }), 'k3');
    expect(proposalsFor(useAssetProposalsStore.getState(), 'project', 'dusk').map((entry) => entry.view.id)).toEqual(['pa_00000001']);
  });

  it('fades a closed proposal out, then forgets it', () => {
    vi.useFakeTimers();
    const store = useAssetProposalsStore.getState();
    store.open(coverProposal(), 'k1');
    store.close({ proposalId: 'pa_00000001', status: 'withdrawn' });
    expect(useAssetProposalsStore.getState().proposals.pa_00000001.closing).toBe('withdrawn');
    vi.advanceTimersByTime(ASSET_PROPOSAL_EXIT_MS + 1);
    expect(useAssetProposalsStore.getState().proposals.pa_00000001).toBeUndefined();
  });

  it('accepts with the key, and says why when the backend refuses', async () => {
    const store = useAssetProposalsStore.getState();
    store.open(coverProposal(), 'k1');
    accept.mockResolvedValueOnce(undefined);
    await useAssetProposalsStore.getState().accept('pa_00000001');
    expect(accept).toHaveBeenCalledWith('pa_00000001', 'k1');
    expect(useAssetProposalsStore.getState().proposals.pa_00000001.closing).toBe('accepted');

    store.open(coverProposal({ id: 'pa_00000002' }), 'k2');
    accept.mockRejectedValueOnce(new AssetProposalError(409, 'This proposal no longer fits: the cover changed'));
    await useAssetProposalsStore.getState().accept('pa_00000002');
    const state = useAssetProposalsStore.getState();
    expect(state.errors.pa_00000002).toContain('no longer fits');
    expect(state.pending.pa_00000002).toBeUndefined();
  });

  it('rejects with the key', async () => {
    useAssetProposalsStore.getState().open(coverProposal(), 'k1');
    reject.mockResolvedValueOnce(undefined);
    await useAssetProposalsStore.getState().reject('pa_00000001');
    expect(reject).toHaveBeenCalledWith('pa_00000001', 'k1', undefined);
    expect(useAssetProposalsStore.getState().proposals.pa_00000001.closing).toBe('rejected');
  });

  it('drops what the backend no longer lists, and expired ones on its own', () => {
    vi.useFakeTimers();
    const store = useAssetProposalsStore.getState();
    store.open(coverProposal(), 'k1');
    store.open(coverProposal({ id: 'pa_00000002', expiresAt: Date.now() - 1 }), 'k2');
    store.open(coverProposal({ id: 'pa_00000003' }), 'k3');
    store.retain(['pa_00000001', 'pa_00000002']);
    store.pruneExpired();
    const { proposals } = useAssetProposalsStore.getState();
    expect(proposals.pa_00000002.closing).toBe('expired');
    expect(proposals.pa_00000003.closing).toBe('invalidated');
    expect(proposals.pa_00000001.closing).toBeUndefined();
  });
});
