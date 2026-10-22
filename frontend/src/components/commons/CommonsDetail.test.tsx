import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ExecutionEvent } from '../../lib/wsClient';
import type { AssetDetail } from '../../lib/commonsTypes';

let handler: ((event: ExecutionEvent) => void) | null = null;
vi.mock('../../lib/wsClient', () => ({
  wsClient: { subscribe: (fn: (event: ExecutionEvent) => void) => { handler = fn; return () => { handler = null; }; } },
}));
vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: vi.fn() }));
const asset = vi.fn();
const reanalyze = vi.fn();
vi.mock('../../lib/commonsApi', () => ({
  commonsApi: { asset: (id: string) => asset(id), blob: () => new Promise(() => {}), reanalyze: (id: string) => reanalyze(id) },
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

// error-copy round 3 (GM - Design, item 4): 'heading "Couldn't analyze this
// reference.", with the reason mapped from last_error's kind ... Keep Retry.
// Put the raw last_error behind a collapsed "Details" toggle.' On 867f254e it
// read "Analysis failed: <raw last_error>".
describe('a reference whose analysis failed', () => {
  const RAW = 'reader crashed: ConnectError [Errno 61] Connection refused';
  const failed = (kind: string | null | undefined) => {
    const base = detail('A loud poster');
    return { ...base, asset: { ...base.asset, analysis_state: 'analysis_failed' as const, last_error: RAW,
      ...(kind === undefined ? {} : { last_error_kind: kind }) } } as AssetDetail;
  };
  beforeEach(() => {
    useAssetProposalsStore.getState().clear();
    asset.mockReset();
    reanalyze.mockReset();
  });

  it.each([
    ['unavailable', "The analysis service didn't respond."],
    ['unreadable', "The analyzer couldn't read this image."],
    ['other', 'Something went wrong during analysis.'],
    [null, 'Something went wrong during analysis.'],
    [undefined, 'Something went wrong during analysis.'],
    ['a-kind-from-a-newer-backend', 'Something went wrong during analysis.'],
  ])('kind %s: the heading over GM\'s reason, Retry, and the raw text only behind Details', async (kind, reason) => {
    asset.mockResolvedValue(failed(kind));
    render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
    const block = await waitFor(() => {
      const shown = document.querySelector('.commons-analysis-failure');
      expect(shown).not.toBeNull();
      return shown as HTMLElement;
    });
    expect(block.querySelector('.failure-lines__heading')?.textContent).toBe("Couldn't analyze this reference.");
    expect(block.querySelector('.failure-lines__reason')?.textContent).toBe(reason);
    expect(screen.queryByText(/Analysis failed/)).toBeNull();
    // Details: a native disclosure, collapsed, holding the raw text as plain text.
    const details = block.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Details');
    expect(details.textContent).toContain(RAW);
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    // Retry kept: it asks for the analysis again.
    reanalyze.mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(reanalyze).toHaveBeenCalledWith('ast_1'));
  });

  it('with no last_error there is no Details toggle', async () => {
    const base = failed('other');
    asset.mockResolvedValue({ ...base, asset: { ...base.asset, last_error: null } });
    render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
    const block = await waitFor(() => {
      const shown = document.querySelector('.commons-analysis-failure');
      expect(shown).not.toBeNull();
      return shown as HTMLElement;
    });
    expect(block.querySelector('details')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });
});
