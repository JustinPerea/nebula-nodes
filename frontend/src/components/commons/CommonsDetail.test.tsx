import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ExecutionEvent } from '../../lib/wsClient';
import type { AssetDetail } from '../../lib/commonsTypes';

let handler: ((event: ExecutionEvent) => void) | null = null;
vi.mock('../../lib/wsClient', () => ({
  wsClient: { subscribe: (fn: (event: ExecutionEvent) => void) => { handler = fn; return () => { handler = null; }; } },
}));
vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: vi.fn() }));
const asset = vi.fn();
vi.mock('../../lib/commonsApi', () => ({
  commonsApi: { asset: (id: string) => asset(id), blob: () => new Promise(() => {}) },
}));

const { CommonsDetail } = await import('./CommonsDetail');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { commonsProposal } = await import('../../test/assetProposalFixtures');

function detail(summary: string): AssetDetail {
  return {
    asset: { id: 'ast_1', media: 'image', width: 24, height: 24, made_by: 'unknown', analysis_state: 'ready',
      last_error: null, measurements: null },
    effective: { fields: { summary: { value: summary } }, sources: {}, corrected_paths: [], analysis: null },
    corrections: [], regions: [{ id: 'reg_1', box: [0.1, 0.1, 0.3, 0.2], label: 'headline', note: null,
      status: 'proposed', actor: 'model:x' }],
    memberships: [{ id: 'mem_1', collection: 'col_1', collection_name: 'Open refs', brand: null, role: 'neutral',
      why: 'loud poster', actor: 'human:justin', in_inbox: 0, sightings: [], comments: [] }],
    borrowings: [], blob_url: '/api/commons/blobs/x.png',
  };
}

describe('CommonsDetail and agents\' proposals', () => {
  beforeEach(() => {
    useAssetProposalsStore.getState().clear();
    asset.mockReset();
  });

  it('shows the proposals for its reference, named from the detail, and reloads once one is accepted', async () => {
    asset.mockResolvedValueOnce(detail('A loud poster')).mockResolvedValue(detail('A quiet grid poster'));
    useAssetProposalsStore.getState().open(commonsProposal(), 'k1');
    useAssetProposalsStore.getState().open(commonsProposal({ id: 'pa_0000c009', target: { kind: 'commons', id: 'ast_9', name: '' } }), 'k9');
    const onChanged = vi.fn();
    render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={onChanged} onDeleted={() => {}} />);
    const strips = await screen.findAllByRole('group', { name: /proposes 4 changes to this reference/ });
    expect(strips).toHaveLength(1);
    expect(strips[0].textContent).toContain('In Open refs');
    expect(asset).toHaveBeenCalledTimes(1);

    // Another reference's decision changes nothing here.
    act(() => handler?.({ type: 'assetProposalClosed', proposalId: 'pa_0000c009', status: 'accepted', kind: 'commons',
      targetId: 'ast_9' } as ExecutionEvent));
    expect(asset).toHaveBeenCalledTimes(1);
    act(() => handler?.({ type: 'assetProposalClosed', proposalId: 'pa_0000c001', status: 'accepted', kind: 'commons',
      targetId: 'ast_1' } as ExecutionEvent));
    await waitFor(() => expect(asset).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect((await screen.findByDisplayValue('A quiet grid poster'))).toBeTruthy();
  });
});
