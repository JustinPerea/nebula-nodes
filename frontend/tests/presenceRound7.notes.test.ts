/**
 * PR #204 round 7:
 * - GM r9 (3): an old stored Update's Accept and Reject are no longer offered; one Review of the
 *   same canvas proposal takes their place, so every row decides through the one full view.
 * - Review 5 LOW-5: the proposal stores send no decision while this tab isn't connected as the
 *   person, whatever button asked.
 * - Review 5 LOW-8: after Not now the header's unread count is the server's, never the tab's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notesApi = vi.hoisted(() => ({ dismissAgentNote: vi.fn() }));
vi.mock('../src/lib/agentNotes', async (original) => ({
  ...await original<typeof import('../src/lib/agentNotes')>(), dismissAgentNote: notesApi.dismissAgentNote,
}));
const proposalApi = vi.hoisted(() => ({ acceptProposal: vi.fn(), rejectProposal: vi.fn() }));
vi.mock('../src/lib/canvasProposals', async (original) => ({
  ...await original<typeof import('../src/lib/canvasProposals')>(),
  acceptProposal: proposalApi.acceptProposal, rejectProposal: proposalApi.rejectProposal,
}));
const assetApi = vi.hoisted(() => ({ acceptAssetProposal: vi.fn(), rejectAssetProposal: vi.fn() }));
vi.mock('../src/lib/assetProposals', async (original) => ({
  ...await original<typeof import('../src/lib/assetProposals')>(),
  acceptAssetProposal: assetApi.acceptAssetProposal, rejectAssetProposal: assetApi.rejectAssetProposal,
}));
vi.mock('../src/lib/wsClient', () => ({ wsClient: { connect: vi.fn(), subscribe: vi.fn(() => () => {}), subscribeFirst: vi.fn(() => () => {}), disconnect: vi.fn() } }));

import { sanitizeNote, surfaceKey, type AgentNote } from '../src/lib/agentNotes';
import { useAgentNotesStore } from '../src/store/agentNotesStore';
import { useCanvasProposalsStore } from '../src/store/canvasProposalsStore';
import { useAssetProposalsStore } from '../src/store/assetProposalsStore';
import { notePersonPromoted, reportPersonRequired, resetPersonSessionForTests } from '../src/lib/personSession';

const author = { kind: 'agent', id: 'claude', name: 'Claude', color: '#d97757' };
const stored = (actions: unknown[]) => sanitizeNote({ id: 'u1', author, text: 'Made a change.', at: '2026-10-30T10:00:00Z', actions });

describe('GM r9 (3): an old Update\'s Accept and Reject become one Review', () => {
  it('Accept and Reject of one proposal: one Review of it, marked legacy', () => {
    const note = stored([
      { label: 'Accept', op: { kind: 'proposal.accept', proposalId: 'p1' } },
      { label: 'Reject', op: { kind: 'proposal.reject', proposalId: 'p1' } },
    ])!;
    expect(note.actions).toEqual([{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'p1', target: 'canvas', legacy: true } }]);
  });

  it('an Accept beside another action: Review in its place, the other kept', () => {
    const note = stored([
      { label: 'Show on canvas', op: { kind: 'canvas.show', refs: ['n1'] } },
      { label: 'Accept', op: { kind: 'proposal.accept', proposalId: 'p2' } },
    ])!;
    expect(note.actions.map((action) => [action.label, action.op.kind])).toEqual([['Show on canvas', 'canvas.show'], ['Review', 'proposal.review']]);
  });

  it('a stored Accept with no proposal id offers nothing', () => {
    expect(stored([{ label: 'Accept', op: { kind: 'proposal.accept' } }])!.actions).toEqual([]);
  });
});

describe('review 5 LOW-5: no decision is sent while this tab isn\'t connected as the person', () => {
  beforeEach(() => resetPersonSessionForTests());
  afterEach(() => { notePersonPromoted(); vi.clearAllMocks(); });

  it('the canvas proposal store: accept and reject send nothing and mark nothing while held', async () => {
    useCanvasProposalsStore.setState({ proposals: { p1: { acceptKey: 'k1' } as never }, pending: {}, errors: {} });
    reportPersonRequired();
    await useCanvasProposalsStore.getState().accept('p1');
    await useCanvasProposalsStore.getState().reject('p1');
    expect(proposalApi.acceptProposal).not.toHaveBeenCalled();
    expect(proposalApi.rejectProposal).not.toHaveBeenCalled();
    expect(useCanvasProposalsStore.getState().pending).toEqual({});
  });

  it('the asset proposal store: a decision sends nothing and marks nothing while held', async () => {
    useAssetProposalsStore.setState({ proposals: { a1: { acceptKey: 'k2' } as never }, pending: {}, errors: {} });
    reportPersonRequired();
    await useAssetProposalsStore.getState().accept('a1');
    await useAssetProposalsStore.getState().reject('a1');
    expect(assetApi.acceptAssetProposal).not.toHaveBeenCalled();
    expect(assetApi.rejectAssetProposal).not.toHaveBeenCalled();
    expect(useAssetProposalsStore.getState().pending).toEqual({});
  });

  it('connected as the person: the decision goes', async () => {
    useAssetProposalsStore.setState({ proposals: { a1: { acceptKey: 'k2' } as never }, pending: {}, errors: {} });
    assetApi.rejectAssetProposal.mockResolvedValueOnce({});
    await useAssetProposalsStore.getState().reject('a1');
    expect(assetApi.rejectAssetProposal).toHaveBeenCalledTimes(1);
  });
});

describe('review 5 LOW-8: after Not now the header\'s count is the server\'s', () => {
  const key = surfaceKey({ kind: 'canvas', projectId: 'alpha' });
  const unreadNote = (id: string): AgentNote => sanitizeNote({ id, author, text: 'Did a thing.', at: '2026-10-30T10:00:00Z' })!;
  beforeEach(() => {
    resetPersonSessionForTests();
    useAgentNotesStore.setState({ canvasProjectId: 'alpha', error: null, arrivals: [],
      lists: { [key]: { notes: [unreadNote('u1'), unreadNote('u2')], unread: 7, loaded: true } } });
  });

  it('while the answer is out the count stays; the answer\'s count replaces it', async () => {
    let answer!: (value: unknown) => void;
    notesApi.dismissAgentNote.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    const done = useAgentNotesStore.getState().dismiss({ kind: 'canvas' }, 'u1');
    expect(useAgentNotesStore.getState().lists[key].unread).toBe(7);
    expect(useAgentNotesStore.getState().lists[key].notes[0].dismissedAt).not.toBeNull();
    answer({ unread: 6 });
    await done;
    expect(useAgentNotesStore.getState().lists[key].unread).toBe(6);
  });

  it('refused: the note comes back and the count is still the server\'s last', async () => {
    notesApi.dismissAgentNote.mockRejectedValueOnce(new Error('No.'));
    reportPersonRequired();
    await useAgentNotesStore.getState().dismiss({ kind: 'canvas' }, 'u1');
    const list = useAgentNotesStore.getState().lists[key];
    expect(list.unread).toBe(7);
    expect(list.notes[0].dismissedAt).toBeNull();
  });
});
