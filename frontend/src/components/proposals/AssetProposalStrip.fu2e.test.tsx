// PR #202 review 3 (round 5). LOW-1: a held tab's cover and moodboard
// placeholders order by the Update ref's `since` (when each ask was made, as
// the backend now sends for every kind), as the promoted cards order by
// createdAt, so they keep their places on the promote after an Update fell
// back to the agent's older ask. NIT-1: two asks made in the same
// millisecond sort by proposal id held and promoted, on the strip and the
// Commons line. NIT-2: agentNameList counts unique names.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentNote } from '../../lib/agentNotes';
import type { AssetProposalView } from '../../lib/assetProposals';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: vi.fn() }));

const { AssetProposalStrip } = await import('./AssetProposalStrip');
const { CommonsProposalsLine } = await import('../commons/CommonsProposalsLine');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { useAgentNotesStore } = await import('../../store/agentNotesStore');
const { askedOrder, heldCommonsLines, heldProposalsFor } = await import('../../store/heldAssetProposals');
const { coverProposal, commonsProposal } = await import('../../test/assetProposalFixtures');
const { surfaceKey } = await import('../../lib/agentNotes');
const { agentNameList } = await import('../../lib/errorCopy');
const session = await import('../../lib/personSession');

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const CODEX = { kind: 'agent' as const, id: 'codex', name: 'Codex', color: '#7AD3FF' };
const CLAUDE = { kind: 'agent' as const, id: 'claude-code', name: 'Claude Code', color: '#C3E86B' };
type Who = typeof CODEX;
type Target = 'project' | 'moodboard' | 'commons';

function update(proposalId: string, author: Who, at: number, since: number, target: Target, targetId: string): AgentNote {
  return {
    id: `n_${proposalId}`, author, source: 'nebula', about: 'proposal', at: new Date(at).toISOString(),
    text: `${author.name} asks`, parts: [], refs: [], readAt: null, dismissedAt: null, actedAt: null, actedWith: null,
    resolvedAt: null, outcome: null,
    proposal: target === 'project' ? { cover: 'image', since } : target === 'commons' ? { changes: 1, since } : { since },
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId, target, targetId } }],
  };
}

function setUpdates(notes: AgentNote[]): void {
  useAgentNotesStore.setState({ canvasProjectId: 'p1',
    lists: { [surfaceKey({ kind: 'canvas', projectId: 'p1' })]: { notes, unread: notes.length, loaded: true } } });
}

function view(target: Target, targetId: string, id: string, agent: Who, createdAt: number): AssetProposalView {
  const by = { id: agent.id, name: agent.name, color: agent.color };
  if (target === 'commons') {
    return commonsProposal({ id, agent: by, createdAt, target: { kind: 'commons', id: targetId, name: '' },
      change: { edits: [{ membership: { id: 'mem', role: 'avoid' } }] } } as never);
  }
  if (target === 'moodboard') {
    return coverProposal({ id, agent: by, createdAt, kind: 'moodboard', target: { kind: 'moodboard', id: targetId, name: 'Dusk board' },
      change: { sendNotes: true } as never, summary: 'send the notes of “Dusk board” to generators', decideIn: 'moodboard' } as never);
  }
  return coverProposal({ id, agent: by, createdAt });
}

const agents = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.asset-proposal')]
  .map((card) => card.querySelector('.asset-proposal__agent')?.textContent);

beforeEach(() => {
  useAssetProposalsStore.getState().clear();
  useAssetProposalsStore.setState({ awaitingSync: false });
  useAgentNotesStore.getState().reset();
});
afterEach(() => { cleanup(); session.resetPersonSessionForTests(); });

describe('review 3 LOW-1: cover and moodboard placeholders keep their places on the promote', () => {
  it.each([
    ['a project cover', 'project' as const, 'dusk'],
    ['a moodboard', 'moodboard' as const, 'board_1'],
  ])('%s: Codex, Claude Code, Codex again and withdrawn; held and promoted both [Codex, Claude Code]', (_label, target, targetId) => {
    act(() => session.reportPersonRequired());
    // Newest first, as the list comes: Codex's Update fell back to its first ask (since T0) but keeps T0 + 2.
    setUpdates([update('pa_codex', CODEX, T0 + 2, T0, target, targetId), update('pa_claude', CLAUDE, T0 + 1, T0 + 1, target, targetId)]);
    const { container } = render(<AssetProposalStrip kind={target} targetId={targetId} />);
    expect(agents(container)).toEqual(['Codex', 'Claude Code']);
    act(() => session.notePersonPromoted());
    act(() => useAssetProposalsStore.getState().sync([
      { ...view(target, targetId, 'pa_claude', CLAUDE, T0 + 1), acceptKey: 'k2' },
      { ...view(target, targetId, 'pa_codex', CODEX, T0), acceptKey: 'k1' },
    ]));
    expect(container.querySelectorAll('[data-held-proposal]')).toHaveLength(0);
    expect(agents(container)).toEqual(['Codex', 'Claude Code']);
  });
});

describe('review 3 NIT-1: asks made in the same millisecond sort by proposal id, held and promoted', () => {
  it('the shared order: time, then id', () => {
    expect(askedOrder({ at: 1, id: 'pa_b' }, { at: 2, id: 'pa_a' })).toBeLessThan(0);
    expect(askedOrder({ at: 2, id: 'pa_a' }, { at: 2, id: 'pa_b' })).toBeLessThan(0);
    expect(askedOrder({ at: 2, id: 'pa_b' }, { at: 2, id: 'pa_a' })).toBeGreaterThan(0);
    expect(askedOrder({ at: 2, id: 'pa_a' }, { at: 2, id: 'pa_a' })).toBe(0);
  });

  it('the held helpers themselves: time, then id, whatever order the Updates come in', () => {
    const notes = [update('pa_c', CODEX, T0 + 2, T0 + 1, 'project', 'dusk'), update('pa_b', CODEX, T0 + 1, T0, 'project', 'dusk'),
      update('pa_a', CLAUDE, T0, T0, 'project', 'dusk')];
    expect(heldProposalsFor(notes, {}, true, 'project', 'dusk').map((held) => held.proposalId)).toEqual(['pa_a', 'pa_b', 'pa_c']);
    const lines = [update('pa_c', CODEX, T0 + 2, T0 + 1, 'commons', 'ast_C'), update('pa_b', CODEX, T0 + 1, T0, 'commons', 'ast_B'),
      update('pa_a', CLAUDE, T0, T0, 'commons', 'ast_A')];
    expect(heldCommonsLines(lines, {}, true).map((line) => line.proposalId)).toEqual(['pa_a', 'pa_b', 'pa_c']);
  });

  it('the strip: the same since and createdAt, whatever order the Updates and the sync come in', () => {
    act(() => session.reportPersonRequired());
    // pa_a is Claude Code's; the list is newest first, so Codex's (pa_b) comes first.
    setUpdates([update('pa_b', CODEX, T0 + 1, T0, 'project', 'dusk'), update('pa_a', CLAUDE, T0, T0, 'project', 'dusk')]);
    const { container } = render(<AssetProposalStrip kind="project" targetId="dusk" />);
    expect(agents(container)).toEqual(['Claude Code', 'Codex']);
    act(() => session.notePersonPromoted());
    act(() => useAssetProposalsStore.getState().sync([
      { ...view('project', 'dusk', 'pa_b', CODEX, T0), acceptKey: 'k2' },
      { ...view('project', 'dusk', 'pa_a', CLAUDE, T0), acceptKey: 'k1' },
    ]));
    expect(container.querySelectorAll('[data-held-proposal]')).toHaveLength(0);
    expect(agents(container)).toEqual(['Claude Code', 'Codex']);
  });

  it('the Commons line: two references asked the same millisecond keep their order held and promoted', () => {
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_b', CODEX, T0 + 1, T0, 'commons', 'ast_B'), update('pa_a', CLAUDE, T0, T0, 'commons', 'ast_A')]);
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    const lines = () => [...container.querySelectorAll<HTMLElement>('.commons-notice--proposal')].map((line) => line.dataset.commonsAsset);
    expect(lines()).toEqual(['ast_A', 'ast_B']);
    act(() => session.notePersonPromoted());
    act(() => useAssetProposalsStore.getState().sync([
      { ...view('commons', 'ast_B', 'pa_b', CODEX, T0), acceptKey: 'k2' },
      { ...view('commons', 'ast_A', 'pa_a', CLAUDE, T0), acceptKey: 'k1' },
    ]));
    expect(container.querySelectorAll('[data-held-commons]')).toHaveLength(0);
    expect(lines()).toEqual(['ast_A', 'ast_B']);
  });
});

describe('review 3 NIT-2: agentNameList counts unique names', () => {
  it.each([
    [['A', 'A', 'B', 'B', 'C'], 'A, B and C'],
    [['A', 'A', 'A', 'A'], 'A'],
    [['A', 'B', 'B', 'C', 'D'], '4 agents'],
  ])('%j → %s', (names, shown) => {
    expect(agentNameList(names)).toBe(shown);
  });
});
