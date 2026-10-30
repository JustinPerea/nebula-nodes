// GM, PR #202 r2, item 4: a held tab shows the PROPOSAL pill on a Commons
// tile from the Update refs it already has (their target id), never from the
// person-only list, so the promote changes nothing on the tile. A withdrawn
// or expired proposal's Update resolves and takes the pill with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { AgentNote } from '../../lib/agentNotes';
import type { SearchRow } from '../../lib/commonsTypes';

vi.mock('./CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('./CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

const row = (id: string): SearchRow => ({
  id, membership_id: `mem_${id}`, collection_id: 'col_1', collection: 'Open refs', summary: `Reference ${id}`,
  role: 'neutral', media: 'image', made_by: 'unknown', analysis_state: 'ready', in_inbox: false, comment_count: 0,
  matched: [], score: 1, blob_key: `${id}.png`, also_in: [],
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function backend(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input instanceof Request ? input.url : input), 'http://localhost').pathname;
  if (path === '/api/commons/status') return Promise.resolve(json({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } }));
  if (path === '/api/commons/search') return Promise.resolve(json({ results: [row('ast_1'), row('ast_2'), row('ast_3')] }));
  if (['/api/commons/collections', '/api/commons/folders', '/api/commons/vocabulary/candidates'].includes(path)) return Promise.resolve(json([]));
  if (path === '/api/commons/review' || path === '/api/commons/evaluation') return Promise.resolve(json(null));
  if (/\/blob|\/image/.test(path)) return new Promise(() => {});
  return Promise.resolve(json({}));
}

sessionStorage.setItem('nebula.person', JSON.stringify({ token: crypto.randomUUID(), backend: 'http://localhost:8000' }));
const { CommonsView } = await import('./CommonsView');
const { useUIStore } = await import('../../store/uiStore');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { useAgentNotesStore } = await import('../../store/agentNotesStore');
const { surfaceKey } = await import('../../lib/agentNotes');
const { commonsProposal } = await import('../../test/assetProposalFixtures');

const CODEX = { kind: 'agent' as const, id: 'codex', name: 'Codex', color: '#7AD3FF' };
const KEY = surfaceKey({ kind: 'canvas', projectId: 'p1' });

function update(proposalId: string, assetId: string, overrides: Partial<AgentNote> = {}): AgentNote {
  return {
    id: `n_${proposalId}`, author: CODEX, source: 'nebula', about: 'proposal', at: '2026-10-29T12:00:00.000Z',
    text: 'Codex asks to change a reference in the Commons', parts: [], refs: [], readAt: null, dismissedAt: null,
    actedAt: null, actedWith: null, resolvedAt: null, outcome: null,
    proposal: { changes: 1 },
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId, target: 'commons', targetId: assetId } }],
    ...overrides,
  } as AgentNote;
}

function setUpdates(notes: AgentNote[]): void {
  useAgentNotesStore.setState({ canvasProjectId: 'p1', lists: { [KEY]: { notes, unread: notes.length, loaded: true } } });
}

const pills = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="option"]')]
  .map((tile) => tile.querySelector('.commons-badge--proposal')?.outerHTML ?? null);

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(backend));
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
  useAssetProposalsStore.getState().clear();
  useAgentNotesStore.getState().reset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useAssetProposalsStore.setState({ awaitingSync: false }); });

describe('GM PR #202 r2: the PROPOSAL pill while the tab is held', () => {
  it('shows from the held Update\'s target, and the promote leaves the tile exactly as it was', async () => {
    useAssetProposalsStore.setState({ awaitingSync: true });
    setUpdates([update('pa_1', 'ast_2')]);
    const view = render(<CommonsView />);
    await waitFor(() => expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(3));
    const held = pills(view.container);
    expect(held.map((pill) => pill !== null)).toEqual([false, true, false]);
    const tileBefore = view.container.querySelectorAll('[role="option"]')[1].outerHTML;
    // The promote: the person's sync brings the same proposal.
    act(() => useAssetProposalsStore.getState().sync([
      { ...commonsProposal({ id: 'pa_1', target: { kind: 'commons', id: 'ast_2', name: '' } }), acceptKey: 'k1' }]));
    expect(useAssetProposalsStore.getState().awaitingSync).toBe(false);
    expect(pills(view.container)).toEqual(held);
    expect(view.container.querySelectorAll('[role="option"]')[1].outerHTML).toBe(tileBefore);
  });

  it('a withdrawn or an expired proposal\'s Update resolves and takes the pill', async () => {
    useAssetProposalsStore.setState({ awaitingSync: true });
    setUpdates([update('pa_1', 'ast_1'), update('pa_2', 'ast_3')]);
    const view = render(<CommonsView />);
    await waitFor(() => expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(3));
    expect(pills(view.container).map((pill) => pill !== null)).toEqual([true, false, true]);
    act(() => setUpdates([
      update('pa_1', 'ast_1', { resolvedAt: '2026-10-29T12:05:00.000Z', outcome: 'Withdrawn by Codex' }),
      update('pa_2', 'ast_3', { resolvedAt: '2026-10-29T12:15:00.000Z', outcome: 'Expired' }),
    ]));
    expect(pills(view.container)).toEqual([null, null, null]);
  });

  it('never from the person-only list while held, and none once nothing is held', async () => {
    // Held, with no Update: nothing, whatever the tab may hold otherwise.
    useAssetProposalsStore.setState({ awaitingSync: true });
    setUpdates([update('pa_9', 'ast_1', { about: 'other' }), update('pa_8', 'ast_2', {
      actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'pa_8', target: 'project', targetId: 'ast_2' } }] })]);
    const view = render(<CommonsView />);
    await waitFor(() => expect(view.container.querySelectorAll('[role="option"]')).toHaveLength(3));
    expect(pills(view.container)).toEqual([null, null, null]);
    cleanup();
    // Not held: an open Update alone puts no pill up (the person's list does).
    useAssetProposalsStore.setState({ awaitingSync: false });
    setUpdates([update('pa_1', 'ast_2')]);
    const after = render(<CommonsView />);
    await waitFor(() => expect(after.container.querySelectorAll('[role="option"]')).toHaveLength(3));
    expect(pills(after.container)).toEqual([null, null, null]);
  });
});
