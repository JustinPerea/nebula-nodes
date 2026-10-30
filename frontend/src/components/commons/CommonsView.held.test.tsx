// GM, PR #202 r1: the Commons view shows its messages box, with the held
// proposals line, while the tab is held and an Update asks about a reference,
// so the promote adds only Review and nothing below moves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import type { AgentNote } from '../../lib/agentNotes';

vi.mock('./CommonsDetail', () => ({ CommonsDetail: () => null }));
vi.mock('./CommonsMedia', () => ({ CommonsMedia: () => null }));
vi.mock('../agent-notes/UpdatesSlot', () => ({ UpdatesSlot: () => null }));

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function backend(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input instanceof Request ? input.url : input), 'http://localhost').pathname;
  if (path === '/api/commons/status') return Promise.resolve(json({ worker: { running: false, state: 'idle' }, queue: {}, meter: { remaining: 1 } }));
  if (path === '/api/commons/search') return Promise.resolve(json({ results: [] }));
  if (['/api/commons/collections', '/api/commons/folders', '/api/commons/vocabulary/candidates'].includes(path)) return Promise.resolve(json([]));
  if (path === '/api/commons/review' || path === '/api/commons/evaluation') return Promise.resolve(json(null));
  return Promise.resolve(json({}));
}

sessionStorage.setItem('nebula.person', JSON.stringify({ token: crypto.randomUUID(), backend: 'http://localhost:8000' }));
const { CommonsView } = await import('./CommonsView');
const { useUIStore } = await import('../../store/uiStore');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { useAgentNotesStore } = await import('../../store/agentNotesStore');
const { surfaceKey } = await import('../../lib/agentNotes');

const CODEX = { kind: 'agent' as const, id: 'codex', name: 'Codex', color: '#7AD3FF' };

function update(proposalId: string, assetId: string): AgentNote {
  return {
    id: `n_${proposalId}`, author: CODEX, source: 'nebula', about: 'proposal', at: '2026-10-29T12:00:00.000Z',
    text: 'Codex asks to make 3 changes to a reference in the Commons', parts: [], refs: [], readAt: null, dismissedAt: null,
    actedAt: null, actedWith: null, resolvedAt: null, outcome: null,
    proposal: { id: proposalId, kind: 'commons', targetId: assetId, changes: 3 },
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId, target: 'commons', targetId: assetId } }],
  } as AgentNote;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(backend));
  useUIStore.setState({ viewMode: 'commons', commonsEnabled: true, commonsReturnView: 'canvas' });
  useAssetProposalsStore.getState().clear();
  useAgentNotesStore.getState().reset();
  useAgentNotesStore.setState({ canvasProjectId: 'p1',
    lists: { [surfaceKey({ kind: 'canvas', projectId: 'p1' })]: { notes: [update('pa_1', 'asset-1')], unread: 1, loaded: true } } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); useAssetProposalsStore.setState({ awaitingSync: false }); });

describe('GM PR #202 r1: the Commons view while the tab is held', () => {
  it('shows the messages box with the held line, and none once nothing is held', async () => {
    useAssetProposalsStore.setState({ awaitingSync: true });
    const view = render(<CommonsView />);
    await waitFor(() => expect(view.container.querySelector('.commons-messages [data-held-commons="pa_1"]')).not.toBeNull());
    expect(view.container.querySelector('.commons-messages .commons-notice__text')?.textContent)
      .toBe('Codex asks to make 3 changes to a reference');
    expect(view.container.querySelector('.commons-messages button')).toBeNull();
    cleanup();
    useAssetProposalsStore.setState({ awaitingSync: false });
    const after = render(<CommonsView />);
    await waitFor(() => expect(after.container.querySelector('.commons-view, .commons')).not.toBeNull());
    expect(after.container.querySelector('.commons-messages')?.outerHTML ?? null).toBeNull();
    expect(after.container.querySelector('.commons-notice--proposal')).toBeNull();
  });
});
