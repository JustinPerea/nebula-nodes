// PR #200 fix round 22, GM r33 item 1 (review 18 LOW-2): the asset proposal
// strip's Accept and Reject are held exactly like the canvas's proposal bar
// while the person gate holds, with the same titles, clear on the server's
// promote and come back on its demote. A refusal by the gate stops saying so
// once the tab is promoted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blocked, lockLine } from '../../../tests/helpers/personLock';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RequestFailedError } from '../../lib/errorCopy';

const net = vi.hoisted(() => ({ accept: vi.fn(), reject: vi.fn() }));
vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: vi.fn() }));
vi.mock('../../lib/assetProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/assetProposals')>()), acceptAssetProposal: net.accept, rejectAssetProposal: net.reject }));

const { AssetProposalStrip } = await import('./AssetProposalStrip');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { coverProposal } = await import('../../test/assetProposalFixtures');
const session = await import('../../lib/personSession');

const ACCEPT = 'You can review this when this tab is connected as you.'; // one line for both (GM r17 item 2)
const REJECT = 'You can review this when this tab is connected as you.'; // one line for both (GM r17 item 2)
const accept = () => screen.getByRole('button', { name: 'Use this cover' }) as HTMLButtonElement;
const reject = () => screen.getByRole('button', { name: 'Keep mine' }) as HTMLButtonElement;

beforeEach(() => { useAssetProposalsStore.getState().clear(); net.accept.mockReset(); net.reject.mockReset(); });
afterEach(() => { cleanup(); session.resetPersonSessionForTests(); });

describe('GM r33 item 1: the asset strip holds with the person gate', () => {
  it('held: both disabled with the bar\'s titles, nothing sent; promoted: live; demoted: held again', async () => {
    useAssetProposalsStore.getState().open(coverProposal(), 'k1');
    render(<AssetProposalStrip kind="project" targetId="dusk" />);
    expect(blocked(accept())).toBe(false);
    expect(accept().title).toBe('');
    act(() => session.reportPersonRequired());
    expect(blocked(accept())).toBe(true);
    expect(lockLine(accept())).toBe(ACCEPT);
    expect(blocked(reject())).toBe(true);
    expect(lockLine(reject())).toBe(REJECT);
    await act(async () => { fireEvent.click(accept()); fireEvent.click(reject()); });
    expect(net.accept).not.toHaveBeenCalled();
    expect(net.reject).not.toHaveBeenCalled();
    act(() => session.notePersonPromoted());
    expect(blocked(accept())).toBe(false);
    expect(blocked(reject())).toBe(false);
    act(() => session.reportPersonRequired());
    expect(lockLine(accept())).toBe(ACCEPT);
  });

  it('a gate refusal\'s error goes on promote; another error stays', async () => {
    useAssetProposalsStore.getState().open(coverProposal(), 'k1');
    net.accept.mockRejectedValue(new RequestFailedError("Couldn't accept the proposal.", 403, { detail: 'x', code: 'person_required' }));
    await useAssetProposalsStore.getState().accept('pa_00000001');
    expect(useAssetProposalsStore.getState().errors.pa_00000001).toContain('isn’t connected as you');
    useAssetProposalsStore.setState((state) => ({ errors: { ...state.errors, other: 'Something else.' } }));
    session.notePersonPromoted();
    expect(useAssetProposalsStore.getState().errors.pa_00000001).toBeUndefined();
    expect(useAssetProposalsStore.getState().errors.other).toBe('Something else.');
  });
});
