// PR #200 fix round 22, GM r33 item 2: while the person gate holds, the held
// run's Dismiss hides it in this tab only and sends nothing; once the server
// promotes the tab, each approval dismissed meanwhile is released (DELETE
// /api/canvas/approvals/{id}, person-only, which only frees the locked
// nodes), once. A Dismiss on a connected tab releases at once, as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ releaseApproval: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/store/graphStore', () => ({ useGraphStore: { getState: () => ({ nodes: [], isExecuting: false }) },
  watchGraphSyncs: () => ({ seen: new Set<string>(), stop: () => {} }) }));
vi.mock('../src/lib/canvasProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/canvasProposals')>()), releaseApproval: api.releaseApproval }));

const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const session = await import('../src/lib/personSession');

const hold = (approvalId: string | null, more: Array<{ agentName: string; nodeIds: string[]; approvalId: string | null }> = []) =>
  useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n7'], approvalId }, deferredQueue: more } as never);

beforeEach(() => { api.releaseApproval.mockReset(); api.releaseApproval.mockResolvedValue(undefined); });
afterEach(() => { session.resetPersonSessionForTests(); useCanvasProposalsStore.setState({ deferredRun: null, deferredQueue: [] } as never); });

describe('GM r33 item 2: the held run\'s Dismiss while the gate holds', () => {
  it('held: hides it here and sends nothing; promote: the release once; a second promote: nothing more', () => {
    session.reportPersonRequired();
    hold('ra_a', [{ agentName: 'Codex', nodeIds: ['n8'], approvalId: 'ra_b' }]);
    useCanvasProposalsStore.getState().dismissDeferred();
    expect(useCanvasProposalsStore.getState().deferredRun?.approvalId).toBe('ra_b');
    useCanvasProposalsStore.getState().dismissDeferred();
    expect(useCanvasProposalsStore.getState().deferredRun).toBeNull();
    expect(api.releaseApproval).not.toHaveBeenCalled();
    session.notePersonPromoted();
    expect(api.releaseApproval.mock.calls.map((call) => call[0]).sort()).toEqual(['ra_a', 'ra_b']);
    session.notePersonPromoted();
    expect(api.releaseApproval).toHaveBeenCalledTimes(2);
  });

  it('a connected tab releases at once; one with no approval sends nothing', () => {
    hold('ra_c');
    useCanvasProposalsStore.getState().dismissDeferred();
    expect(api.releaseApproval).toHaveBeenCalledWith('ra_c');
    session.reportPersonRequired();
    hold(null);
    useCanvasProposalsStore.getState().dismissDeferred();
    session.notePersonPromoted();
    expect(api.releaseApproval).toHaveBeenCalledTimes(1);
  });
});
