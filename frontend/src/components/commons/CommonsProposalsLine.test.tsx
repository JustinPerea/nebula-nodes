import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: vi.fn() }));

const { CommonsProposalsLine } = await import('./CommonsProposalsLine');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { commonsProposal, coverProposal } = await import('../../test/assetProposalFixtures');

describe('CommonsProposalsLine', () => {
  beforeEach(() => useAssetProposalsStore.getState().clear());

  it('shows nothing while no agent waits on a reference', () => {
    useAssetProposalsStore.getState().open(coverProposal(), 'k');
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    expect(container.textContent).toBe('');
  });

  it('names each reference an agent asks to change, and opens it', () => {
    const store = useAssetProposalsStore.getState();
    store.open(commonsProposal(), 'k1');
    store.open(commonsProposal({ id: 'pa_0000c002', agent: { id: 'codex', name: 'Codex', color: '#E8825A' } }), 'k2');
    store.open(commonsProposal({ id: 'pa_0000c003', target: { kind: 'commons', id: 'ast_2', name: '' },
      change: { edits: [{ correction: { field_path: 'layout.value', op: 'set', value: 'grid', reason: null } }] } }), 'k3');
    const onOpen = vi.fn();
    render(<CommonsProposalsLine onOpen={onOpen} />);
    const lines = screen.getAllByRole('status');
    expect(lines.map((line) => line.textContent)).toEqual([
      'Claude Code and Codex have 2 requests to change a referenceReview',
      'Claude Code asks to change a referenceReview',
    ]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Review' })[1]);
    expect(onOpen).toHaveBeenCalledWith('ast_2');
    act(() => {
      useAssetProposalsStore.getState().open(commonsProposal({ id: 'pa_0000c004', target: { kind: 'commons', id: 'ast_3', name: '' },
        change: { edits: [{ membership: { id: 'mem_3', accept: true } }] } }), 'k4');
      useAssetProposalsStore.getState().open(commonsProposal({ id: 'pa_0000c005', target: { kind: 'commons', id: 'ast_4', name: '' } }), 'k5');
    });
    expect(screen.getAllByRole('status').slice(2).map((line) => line.textContent)).toEqual([
      'Claude Code asks to take a reference out of the inboxReview',
      'Claude Code asks to make 4 changes to a referenceReview',
    ]);
    act(() => useAssetProposalsStore.getState().close({ proposalId: 'pa_0000c003', status: 'withdrawn' }));
    expect(screen.getAllByRole('status')).toHaveLength(3);
  });
});
