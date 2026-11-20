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

describe('CommonsDetail quoted comments', () => {
  it('writes a comment\'s date out, with the year only when it is not the current one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 20, 9, 30));
    try {
      const withComments = detail('A poster');
      withComments.memberships[0].comments = [
        { id: 'c1', actor: 'human:justin', text: 'Keep it', created_at: '2026-11-20T08:00:00Z', source_date: null, region: null },
        { id: 'c2', actor: 'human:justin', text: 'Older', created_at: '2026-01-01T08:00:00Z', source_date: '2025-11-20T10:00:00Z', region: null },
      ];
      asset.mockResolvedValue(withComments);
      const { container } = render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
      await screen.findByText('Keep it');
      const dates = [...container.querySelectorAll('.commons-comment .commons-meta')].map((node) => node.textContent);
      expect(dates).toEqual(['November 20', 'November 20, 2025']);
    } finally {
      vi.useRealTimers();
    }
  });
});

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

// error-copy round 3 (design, item 4): one because line ("Nebula couldn’t analyze this
// reference because ..."), with the reason mapped from last_error's kind ... Try again.
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
    ['unavailable', 'Nebula couldn’t analyze this reference because the analysis service didn’t respond. Try again.', true],
    // The analyzer's refusal would get the same answer again: the line ends at its reason, with no button.
    ['unreadable', 'Nebula couldn’t analyze this reference because the analyzer couldn’t read this image.', false],
    ['other', 'Nebula couldn’t analyze this reference because something went wrong during analysis. Try again.', true],
    [null, 'Nebula couldn’t analyze this reference because something went wrong during analysis. Try again.', true],
    [undefined, 'Nebula couldn’t analyze this reference because something went wrong during analysis. Try again.', true],
    ['a-kind-from-a-newer-backend', 'Nebula couldn’t analyze this reference because something went wrong during analysis. Try again.', true],
  ])('kind %s: one because line, Try again where trying again helps, and the raw text only behind Details', async (kind, line, retries) => {
    asset.mockResolvedValue(failed(kind));
    render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
    const block = await waitFor(() => {
      const shown = document.querySelector('.commons-analysis-failure');
      expect(shown).not.toBeNull();
      return shown as HTMLElement;
    });
    expect(block.querySelector('.failure-lines__heading')).toBeNull();
    expect(block.querySelector('.failure-lines__reason')?.textContent).toBe(line);
    expect(screen.queryByText(/Analysis failed/)).toBeNull();
    // Details: a native disclosure, collapsed, holding the raw text as plain text.
    const details = block.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe('Details');
    expect(details.textContent).toContain(RAW);
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    if (!retries) {
      expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
      return;
    }
    // Try again asks for the analysis again.
    reanalyze.mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(reanalyze).toHaveBeenCalledWith('ast_1'));
  });

  it('says a too-transparent reference in the muted colour, as no error (GM r5 on #208)', async () => {
    asset.mockResolvedValue(failed('transparent'));
    render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
    const line = await screen.findByText('This image is too transparent to analyze.');
    expect(line.className).toBe('commons-notice commons-notice--muted');
    expect(document.querySelector('.commons-notice--error')).toBeNull();
    expect(screen.queryByText(/couldn’t analyze this reference/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  // GM r6 on #208, items 2 and 3: nothing broke, so the badge is the neutral,
  // muted one saying "Not analyzed" (not a red "failed"), and there is no
  // Re-analyze (it can't change a property of the image).
  it('a too-transparent reference wears the muted "Not analyzed" badge and has no Re-analyze', async () => {
    asset.mockResolvedValue(failed('transparent'));
    render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
    await screen.findByText('This image is too transparent to analyze.');
    const badge = document.querySelector('.commons-detail__bar .commons-badge')!;
    expect(badge.className).toBe('commons-badge commons-badge--not-analyzed');
    expect(badge.textContent).toBe('Not analyzed');
    expect(document.querySelector('.commons-badge--analysis_failed')).toBeNull();
    expect(screen.queryByText(/failed/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Re-analyze' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete and purge' })).toBeTruthy();
  });

  it.each(['unavailable', 'other', null])('any other failure (kind %s) keeps the failed badge and Re-analyze', async (kind) => {
    asset.mockResolvedValue(failed(kind));
    render(<CommonsDetail assetId="ast_1" onClose={() => {}} onChanged={() => {}} onDeleted={() => {}} />);
    const button = await screen.findByRole('button', { name: 'Re-analyze' });
    const badge = document.querySelector('.commons-detail__bar .commons-badge')!;
    expect(badge.className).toBe('commons-badge commons-badge--analysis_failed');
    expect(badge.textContent).toBe('failed');
    reanalyze.mockResolvedValue({ queued: true });
    fireEvent.click(button);
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
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
