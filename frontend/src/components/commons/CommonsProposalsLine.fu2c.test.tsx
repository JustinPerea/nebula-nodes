// GM, PR #202 r2, item 3: no parentheses on the Commons line, held or
// promoted, and the names through the shared name-list helper (4 or more
// agents become a count).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentNote } from '../../lib/agentNotes';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: vi.fn() }));

const { CommonsProposalsLine } = await import('./CommonsProposalsLine');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { useAgentNotesStore } = await import('../../store/agentNotesStore');
const { commonsProposal } = await import('../../test/assetProposalFixtures');
const { surfaceKey } = await import('../../lib/agentNotes');
const { agentNameList, nodeNameList } = await import('../../lib/errorCopy');
const session = await import('../../lib/personSession');

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const AGENTS = [
  { kind: 'agent' as const, id: 'codex', name: 'Codex', color: '#7AD3FF' },
  { kind: 'agent' as const, id: 'claude-code', name: 'Claude Code', color: '#C3E86B' },
  { kind: 'agent' as const, id: 'cursor', name: 'Cursor', color: '#E8825A' },
  { kind: 'agent' as const, id: 'gemini', name: 'Gemini', color: '#B58CFF' },
];

function update(proposalId: string, assetId: string, author = AGENTS[0], at = T0, changes = 1): AgentNote {
  return {
    id: `n_${proposalId}`, author, source: 'nebula', about: 'proposal', at: new Date(at).toISOString(),
    text: `${author.name} asks to change a reference in the Commons`, parts: [], refs: [], readAt: null, dismissedAt: null,
    actedAt: null, actedWith: null, resolvedAt: null, outcome: null, proposal: { changes },
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId, target: 'commons', targetId: assetId } }],
  };
}

function setUpdates(notes: AgentNote[]): void {
  useAgentNotesStore.setState({ canvasProjectId: 'p1',
    lists: { [surfaceKey({ kind: 'canvas', projectId: 'p1' })]: { notes, unread: notes.length, loaded: true } } });
}

const words = (container: HTMLElement) => [...container.querySelectorAll('.commons-notice__text')].map((t) => t.textContent);

beforeEach(() => {
  useAssetProposalsStore.getState().clear();
  useAssetProposalsStore.setState({ awaitingSync: false });
  useAgentNotesStore.getState().reset();
});
afterEach(() => { cleanup(); session.resetPersonSessionForTests(); });

describe('the shared name-list helper, for agents', () => {
  it.each([
    [['Codex'], 'Codex'],
    [['Codex', 'Claude Code'], 'Codex and Claude Code'],
    [['Codex', 'Claude Code', 'Cursor'], 'Codex, Claude Code and Cursor'],
    [['Codex', 'Claude Code', 'Cursor', 'Gemini'], '4 agents'],
    [['Codex', 'Codex', 'Claude Code'], 'Codex and Claude Code'],
  ])('%j → %s', (names, shown) => {
    expect(agentNameList(names)).toBe(shown);
  });

  it('shares its rule with the node list (up to 3 by name, from 4 a count)', () => {
    expect(nodeNameList(['A', 'B', 'C'])).toBe('“A”, “B” and “C”');
    expect(nodeNameList(['A', 'B', 'C', 'D'])).toBe('4 nodes');
  });
});

describe('GM PR #202 r2: no parentheses on the Commons line', () => {
  it('held, then promoted: the same words, never "(N proposals)"', () => {
    act(() => session.reportPersonRequired());
    setUpdates([
      update('pa_1', 'ast_1', AGENTS[0], T0),
      update('pa_2', 'ast_1', AGENTS[1], T0 + 1),
      update('pa_3', 'ast_2', AGENTS[0], T0 + 2),
      update('pa_4', 'ast_2', AGENTS[0], T0 + 3),
      update('pa_5', 'ast_3', AGENTS[0], T0 + 4, 3),
    ]);
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    const held = words(container);
    expect(held).toEqual([
      'Codex and Claude Code have 2 requests to change a reference',
      'Codex has 2 requests to change a reference',
      'Codex asks to make 3 changes to a reference',
    ]);
    act(() => session.notePersonPromoted());
    const as = (id: string, asset: string, agent: (typeof AGENTS)[number], at: number) => ({
      ...commonsProposal({ id, agent: { id: agent.id, name: agent.name, color: agent.color }, createdAt: at,
        target: { kind: 'commons', id: asset, name: '' }, change: { edits: [{ membership: { id: 'mem', role: 'avoid' } }] } } as never),
      acceptKey: `k_${id}` });
    act(() => useAssetProposalsStore.getState().sync([
      as('pa_1', 'ast_1', AGENTS[0], T0), as('pa_2', 'ast_1', AGENTS[1], T0 + 1), as('pa_3', 'ast_2', AGENTS[0], T0 + 2),
      as('pa_4', 'ast_2', AGENTS[0], T0 + 3),
      { ...commonsProposal({ id: 'pa_5', agent: { id: 'codex', name: 'Codex', color: '#7AD3FF' }, createdAt: T0 + 4,
        target: { kind: 'commons', id: 'ast_3', name: '' }, change: { edits: [
          { membership: { id: 'm', role: 'avoid' } }, { region: { label: 'a', box: [0, 0, 1, 1] } }, { region: { label: 'b', box: [0, 0, 1, 1] } }] } } as never),
      acceptKey: 'k5' },
    ]));
    expect(words(container)).toEqual(held);
    expect(container.textContent).not.toMatch(/[()]/);
  });

  it('three agents by name; four or more as a count, with a dot each', () => {
    act(() => session.reportPersonRequired());
    setUpdates(AGENTS.slice(0, 3).map((agent, i) => update(`pa_t${i}`, 'ast_1', agent, T0 + i))
      .concat(AGENTS.map((agent, i) => update(`pa_f${i}`, 'ast_2', agent, T0 + 10 + i))));
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    expect(words(container)).toEqual([
      'Codex, Claude Code and Cursor have 3 requests to change a reference',
      '4 agents have 4 requests to change a reference',
    ]);
    expect([...container.querySelectorAll('.commons-notice--proposal')].map((line) => line.querySelectorAll('.commons-notice__dot').length))
      .toEqual([3, 4]);
  });
});

// PR #202 review 2 LOW-A: a held line orders as the promoted one does, by when
// each ask was made (the ref's `since`, the proposal's createdAt), not by the
// Update's time, which a fallback to an older ask leaves on the newer one.
describe('review 2 LOW-A: the same order held and promoted', () => {
  const withSince = (note: AgentNote, since: number): AgentNote => ({ ...note, proposal: { ...note.proposal, since } });
  const known = (id: string, asset: string, agent: (typeof AGENTS)[number], at: number) => ({
    ...commonsProposal({ id, agent: { id: agent.id, name: agent.name, color: agent.color }, createdAt: at,
      target: { kind: 'commons', id: asset, name: '' }, change: { edits: [{ membership: { id: 'mem', role: 'avoid' } }] } } as never),
    acceptKey: `k_${id}` });
  const order = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.commons-notice--proposal')]
    .map((line) => [line.dataset.commonsAsset, line.querySelector('.commons-notice__text')?.textContent]);

  it('(b) lines: Codex on A, Claude Code on B, Codex on A again and withdrawn; held and promoted both [A, B]', () => {
    act(() => session.reportPersonRequired());
    // The Codex Update fell back to its first ask (since T0) but keeps the second ask's time (T0 + 2).
    setUpdates([
      withSince(update('pa_a1', 'ast_A', AGENTS[0], T0 + 2), T0),
      withSince(update('pa_b', 'ast_B', AGENTS[1], T0 + 1), T0 + 1),
    ]);
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    const held = order(container);
    expect(held.map(([asset]) => asset)).toEqual(['ast_A', 'ast_B']);
    act(() => session.notePersonPromoted());
    act(() => useAssetProposalsStore.getState().sync([known('pa_a1', 'ast_A', AGENTS[0], T0), known('pa_b', 'ast_B', AGENTS[1], T0 + 1)]));
    expect(order(container)).toEqual(held);
  });

  it('(c) names: the same steps on one reference; held and promoted both "Codex and Claude Code"', () => {
    act(() => session.reportPersonRequired());
    setUpdates([
      withSince(update('pa_a1', 'ast_A', AGENTS[0], T0 + 2), T0),
      withSince(update('pa_b', 'ast_A', AGENTS[1], T0 + 1), T0 + 1),
    ]);
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    const held = order(container);
    expect(held).toEqual([['ast_A', 'Codex and Claude Code have 2 requests to change a reference']]);
    expect([...container.querySelectorAll<HTMLElement>('.commons-notice__dot')].map((dot) => dot.style.getPropertyValue('--agent-color')))
      .toEqual(['#7AD3FF', '#C3E86B']);
    act(() => session.notePersonPromoted());
    act(() => useAssetProposalsStore.getState().sync([known('pa_a1', 'ast_A', AGENTS[0], T0), known('pa_b', 'ast_A', AGENTS[1], T0 + 1)]));
    expect(order(container)).toEqual(held);
  });

  it('promoted: lines and names follow createdAt, whatever order the list arrives in', () => {
    act(() => useAssetProposalsStore.getState().sync([
      known('pa_late', 'ast_B', AGENTS[1], T0 + 9), known('pa_mid', 'ast_A', AGENTS[1], T0 + 5), known('pa_first', 'ast_A', AGENTS[0], T0),
    ]));
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    expect(order(container)).toEqual([
      ['ast_A', 'Codex and Claude Code have 2 requests to change a reference'],
      ['ast_B', 'Claude Code asks to change a reference'],
    ]);
  });

  it('a ref keeps only a whole, non-negative since', async () => {
    const { sanitizeNote } = await import('../../lib/agentNotes');
    const since = (value: unknown) => sanitizeNote({ ...update('pa', 'ast_1'), proposal: { id: 'pa', kind: 'commons', targetId: 'ast_1', since: value } })?.proposal;
    expect(since(0)).toEqual({ since: 0 });
    expect(since(1761739200000)).toEqual({ since: 1761739200000 });
    for (const junk of [-1, 1.5, '1761739200000', true, null, 2 ** 53]) expect(since(junk)).toEqual({});
  });
});

describe('review 2 NIT-B: a promoted line\'s dot checks the agent colour', () => {
  it('a malformed colour gets the fallback, as on the held line and the card', () => {
    // Straight into the store, past its own clean(): the line checks the colour itself too.
    const view = commonsProposal({ id: 'pa_r', agent: { id: 'x', name: 'Mallory', color: 'red' } });
    useAssetProposalsStore.setState({ proposals: { pa_r: { view, acceptKey: 'k' } as never } });
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    expect(container.querySelector<HTMLElement>('.commons-notice__dot')!.style.getPropertyValue('--agent-color')).toBe('#5B9DFF');
  });
});

describe('review 2 NIT-B: "changed" keeps the read state the server sends', () => {
  it('a read Update stays read when it changes in place, and the count stays', () => {
    const key = surfaceKey({ kind: 'canvas', projectId: 'p1' });
    const read = { ...update('pa_1', 'ast_1'), readAt: '2026-10-29T12:01:00.000Z' };
    const apply = useAgentNotesStore.getState().apply;
    act(() => apply({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: read, unread: 0 } as never));
    const changed = { ...read, text: 'Codex asks to make 3 changes to a reference in the Commons', proposal: { changes: 3 } };
    act(() => apply({ type: 'agentNotes', surface: 'canvas', op: 'changed', projectId: 'p1', ids: [read.id], note: changed } as never));
    const list = useAgentNotesStore.getState().lists[key];
    expect(list.notes[0].readAt).toBe('2026-10-29T12:01:00.000Z');
    expect(list.unread).toBe(0);
  });
});
