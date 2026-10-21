import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => `http://127.0.0.1:8060${url}`, apiFetch: vi.fn() }));

const { AssetProposalStrip } = await import('./AssetProposalStrip');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { commonsProposal, coverProposal } = await import('../../test/assetProposalFixtures');

describe('AssetProposalStrip', () => {
  beforeEach(() => useAssetProposalsStore.getState().clear());

  it('shows nothing without a proposal for its target', () => {
    useAssetProposalsStore.getState().open(coverProposal({ target: { kind: 'project', id: 'other', name: 'Other' } }), 'k');
    const { container } = render(<AssetProposalStrip kind="project" targetId="dusk" />);
    expect(container.textContent).toBe('');
  });

  it('shows the agent, its note and the cover it proposes, and decides with the store', () => {
    useAssetProposalsStore.getState().open(coverProposal(), 'k1');
    const accept = vi.fn().mockResolvedValue(undefined);
    const reject = vi.fn().mockResolvedValue(undefined);
    useAssetProposalsStore.setState({ accept, reject });
    render(<AssetProposalStrip kind="project" targetId="dusk" />);
    const strip = screen.getByRole('group', { name: 'Claude Code proposes a new cover' });
    expect(strip.textContent).toContain('The new grade reads better');
    const pictures = strip.querySelectorAll('img');
    expect([...pictures].map((img) => img.getAttribute('src'))).toEqual([
      'http://127.0.0.1:8060/api/outputs/a.png', 'http://127.0.0.1:8060/api/outputs/c.png']);
    expect(strip.textContent).toContain('You pinned');
    fireEvent.click(screen.getByRole('button', { name: 'Use this cover' }));
    expect(accept).toHaveBeenCalledWith('pa_00000001');
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(reject).toHaveBeenCalledWith('pa_00000001');
  });

  it('asks about a board in its own words', () => {
    useAssetProposalsStore.getState().open(coverProposal({
      kind: 'moodboard', target: { kind: 'moodboard', id: 'mb1', name: 'Dusk board' },
      change: { sendNotes: { from: false, to: true } }, summary: 'send the notes of board "Dusk board" to generators',
      decideIn: 'moodboard-studio',
    }), 'k1');
    render(<AssetProposalStrip kind="moodboard" targetId="mb1" />);
    const strip = screen.getByRole('group', { name: 'Claude Code asks to send these notes to generators' });
    expect(strip.querySelector('img')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send them' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep them here' })).toBeTruthy();
  });

  it('lists a commons proposal\'s edits, each as it is now and as proposed, with the names the Commons knows', () => {
    useAssetProposalsStore.getState().open(commonsProposal(), 'k1');
    const accept = vi.fn().mockResolvedValue(undefined);
    useAssetProposalsStore.setState({ accept });
    render(<AssetProposalStrip kind="commons" targetId="ast_1" names={{ mem_1: 'Open refs' }} />);
    const strip = screen.getByRole('group', { name: 'Claude Code proposes 4 changes to this reference' });
    const rows = [...strip.querySelectorAll('li')].map((row) => row.textContent);
    expect(rows).toEqual([
      'SummaryA loud poster→A quiet grid posterWhy: the type is small',
      'Keywords+ brutalist',
      'Region “headline”confirm it',
      'In Open refsrole neutral → avoid · why “too loud for us”',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Apply all' }));
    expect(accept).toHaveBeenCalledWith('pa_0000c001');
    expect(screen.getByRole('button', { name: 'Don\'t' })).toBeTruthy();
  });

  it('reads a commons proposal without its before (another tab\'s list) and with one edit', () => {
    useAssetProposalsStore.getState().open(commonsProposal({
      before: undefined,
      change: { edits: [{ region: { box: [0.5, 0.5, 0.25, 0.25], label: 'logo' } }] },
    }), 'k1');
    render(<AssetProposalStrip kind="commons" targetId="ast_1" />);
    const strip = screen.getByRole('group', { name: 'Claude Code proposes a change to this reference' });
    expect(strip.querySelector('li')?.textContent).toBe('New region“logo”');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
  });

  it('says why a decision failed', () => {
    useAssetProposalsStore.getState().open(coverProposal(), 'k1');
    useAssetProposalsStore.setState({ errors: { pa_00000001: 'This proposal no longer fits: the cover changed' } });
    render(<AssetProposalStrip kind="project" targetId="dusk" />);
    expect(screen.getByRole('alert').textContent).toContain('no longer fits');
  });

  it('counts the time left from when a proposal arrives, not from when the strip mounted', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
      // Moodboard Studio mounts the strip with the board, before any proposal.
      render(<AssetProposalStrip kind="project" targetId="dusk" />);
      vi.setSystemTime(new Date('2026-10-20T12:10:00Z'));
      act(() => {
        useAssetProposalsStore.getState().open(coverProposal({ expiresAt: Date.now() + 15 * 60_000 }), 'k1');
      });
      expect(screen.getByRole('group').textContent).toContain('15 min left');
    } finally {
      vi.useRealTimers();
    }
  });
});
