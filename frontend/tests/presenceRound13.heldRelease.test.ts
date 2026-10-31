/**
 * PR #204 round 13 (review 10 held-calls NIT-3): a held run's release (DELETE
 * /api/canvas/approvals/{id}, person-only) keys on personUnconfirmed(), the check accept and
 * reject use: before the socket's first answer it waits too, and goes once on the promote. On
 * 8651112c it keyed on personGateHeld(), so a release in that window went out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ releaseApproval: vi.fn() }));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { subscribe: () => () => {} } }));
vi.mock('../src/store/graphStore', () => ({ useGraphStore: { getState: () => ({ nodes: [], isExecuting: false, runStarting: false }) },
  watchGraphSyncs: () => ({ seen: new Set<string>(), stop: () => {} }) }));
vi.mock('../src/lib/canvasProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/canvasProposals')>()), releaseApproval: api.releaseApproval }));

const { useCanvasProposalsStore } = await import('../src/store/canvasProposalsStore');
const session = await import('../src/lib/personSession');

const hold = (approvalId: string) =>
  useCanvasProposalsStore.setState({ deferredRun: { agentName: 'Codex', nodeIds: ['n7'], approvalId }, deferredQueue: [] } as never);
const released = () => api.releaseApproval.mock.calls.map((call) => call[0]);

beforeEach(() => {
  api.releaseApproval.mockReset().mockResolvedValue(undefined);
  window.sessionStorage.clear();
  session.resetPersonSessionForTests({ unanswered: true }); // a fresh page: the socket hasn't answered
});
afterEach(() => {
  session.notePersonPromoted();
  session.resetPersonSessionForTests();
  useCanvasProposalsStore.setState({ deferredRun: null, deferredQueue: [] } as never);
});

describe('releases wait while the tab is unconfirmed (review 10 NIT-3)', () => {
  it('Dismiss before the first answer sends nothing; the promote releases it once', () => {
    expect(session.personUnconfirmed()).toBe(true);
    hold('ra_a');
    useCanvasProposalsStore.getState().dismissDeferred();
    expect(released()).toEqual([]);
    session.notePersonPromoted();
    expect(released()).toEqual(['ra_a']);
    session.notePersonPromoted();
    expect(released()).toEqual(['ra_a']);
  });

  it('Run with nothing left (its nodes deleted) before the first answer: the release waits too', async () => {
    hold('ra_b'); // n7 is gone (no nodes)
    await useCanvasProposalsStore.getState().runDeferred();
    expect(released()).toEqual([]);
    session.notePersonPromoted();
    expect(released()).toEqual(['ra_b']);
  });
});
