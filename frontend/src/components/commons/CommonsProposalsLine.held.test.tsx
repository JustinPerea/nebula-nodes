// GM, PR #202 r1: while this tab isn't connected as the person, the Commons
// proposals line shows from the Updates the tab already has, without Review,
// so the promote adds Review and nothing above the detail moves. The count
// and kind come only from the Update's ref; one line per reference, one proposal per Update; the agent's
// dot in its colour; a withdrawn or expired Update takes its line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentNote } from '../../lib/agentNotes';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: vi.fn() }));

const { CommonsProposalsLine } = await import('./CommonsProposalsLine');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { useAgentNotesStore } = await import('../../store/agentNotesStore');
const { heldCommonsLines, commonsAsks } = await import('../../store/heldAssetProposals');
const { commonsProposal } = await import('../../test/assetProposalFixtures');
const { sanitizeNote, surfaceKey } = await import('../../lib/agentNotes');
const session = await import('../../lib/personSession');

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const CODEX = { kind: 'agent' as const, id: 'codex', name: 'Codex', color: '#7AD3FF' };
const CLAUDE = { kind: 'agent' as const, id: 'claude-code', name: 'Claude Code', color: '#E8825A' };

function update(proposalId: string, assetId: string, overrides: Partial<AgentNote> = {}): AgentNote {
  return {
    id: `n_${proposalId}`, author: CODEX, source: 'nebula', about: 'proposal', at: new Date(T0).toISOString(),
    text: 'Codex asks to change a reference in the Commons', parts: [], refs: [], readAt: null, dismissedAt: null,
    actedAt: null, actedWith: null, resolvedAt: null, outcome: null,
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId, target: 'commons', targetId: assetId } }],
    ...overrides,
  };
}

function setUpdates(notes: AgentNote[]): void {
  useAgentNotesStore.setState({ canvasProjectId: 'p1',
    lists: { [surfaceKey({ kind: 'canvas', projectId: 'p1' })]: { notes, unread: notes.length, loaded: true } } });
}

const lines = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.commons-notice--proposal')];
const words = (line: HTMLElement) => line.querySelector('.commons-notice__text')?.textContent;

beforeEach(() => {
  useAssetProposalsStore.getState().clear();
  useAssetProposalsStore.setState({ awaitingSync: false });
  useAgentNotesStore.getState().reset();
});
afterEach(() => { cleanup(); session.resetPersonSessionForTests(); });

describe('GM PR #202 r1: the Commons proposals line while the tab is held', () => {
  it('says what the promoted line says, from the ref, with the agent\'s dot and no Review; the promote adds only Review', () => {
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_3', 'ast_1', { proposal: { changes: 3 } })]);
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    const [held] = lines(container);
    expect(words(held)).toBe('Codex asks to make 3 changes to a reference');
    expect(held.textContent).toBe('Codex asks to make 3 changes to a reference');
    expect(held.querySelectorAll('button')).toHaveLength(0);
    expect(held.dataset.heldCommons).toBe('pa_3');
    const dot = held.querySelector<HTMLElement>('.commons-notice__dot');
    expect(dot?.style.getPropertyValue('--agent-color')).toBe('#7AD3FF');

    act(() => session.notePersonPromoted());
    expect(lines(container)).toHaveLength(1);
    const edits = [
      { membership: { id: 'mem_1', role: 'avoid', why: 'too loud' } },
      { region: { label: 'headline', box: [0.1, 0.1, 0.3, 0.2] } },
      { region: { label: 'logo', box: [0.6, 0.7, 0.2, 0.2] } },
    ];
    act(() => useAssetProposalsStore.getState().sync([{ ...commonsProposal({ id: 'pa_3', agent: { id: 'codex', name: 'Codex', color: '#7AD3FF' },
      change: { edits } } as never), acceptKey: 'k' }]));
    const [real] = lines(container);
    expect(real.dataset.heldCommons).toBeUndefined();
    expect(words(real)).toBe(words(held));
    expect(real.querySelector('.commons-notice__dot')?.getAttribute('style')).toBe(dot?.getAttribute('style'));
    expect(real.textContent).toBe('Codex asks to make 3 changes to a referenceReview');
  });

  it.each([
    [{ changes: 1 }, 'change a reference'],
    [{ changes: 1, inbox: true as const }, 'take a reference out of the inbox'],
    [{ changes: 4 }, 'make 4 changes to a reference'],
    [null, 'change a reference'],
  ])('ref %j asks to %s, the promoted line\'s words', (ref, asks) => {
    expect(commonsAsks(ref)).toBe(asks);
  });

  it('the count never comes from the text: an agent named like a count changes nothing', () => {
    const name = 'Mallory asks to make 9 changes';
    const [line] = heldCommonsLines([update('pa_m', 'ast_1', { author: { ...CODEX, name }, text: `${name} asks to change a reference in the Commons`,
      proposal: { changes: 1 } })], {}, true);
    expect(line.asks).toBe('change a reference');
  });

  it('several proposals and several agents: per reference, as the promoted line counts them (one per Update), each agent\'s dot', () => {
    act(() => session.reportPersonRequired());
    setUpdates([
      update('pa_b', 'ast_1', { author: CLAUDE, at: new Date(T0 + 2).toISOString(), proposal: { changes: 1 } }),
      update('pa_a', 'ast_1', { proposal: { changes: 2 } }),
      update('pa_c', 'ast_2', { at: new Date(T0 + 5).toISOString(), proposal: { changes: 1, inbox: true } }),
    ]);
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    expect(lines(container).map(words)).toEqual([
      'Codex and Claude Code have 2 requests to change a reference',
      'Codex asks to take a reference out of the inbox',
    ]);
    expect(lines(container).map((line) => [...line.querySelectorAll<HTMLElement>('.commons-notice__dot')].map((dot) => dot.style.getPropertyValue('--agent-color'))))
      .toEqual([['#7AD3FF', '#E8825A'], ['#7AD3FF']]);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    // The promote: the person's sync brings the same three proposals; the words stay, Review is added.
    const before = lines(container).map(words);
    act(() => session.notePersonPromoted());
    const codex = { id: 'codex', name: 'Codex', color: '#7AD3FF' };
    act(() => useAssetProposalsStore.getState().sync([
      { ...commonsProposal({ id: 'pa_a', agent: codex, createdAt: T0 - 5 }), acceptKey: 'k1' },
      { ...commonsProposal({ id: 'pa_b', agent: { id: 'claude-code', name: 'Claude Code', color: '#E8825A' }, createdAt: T0 + 1,
        change: { edits: [{ membership: { id: 'mem_1', role: 'avoid' } }] } } as never), acceptKey: 'k2' },
      { ...commonsProposal({ id: 'pa_c', agent: codex, createdAt: T0 + 4, target: { kind: 'commons', id: 'ast_2', name: '' },
        change: { edits: [{ membership: { id: 'mem_2', accept: true } }] } } as never), acceptKey: 'k3' },
    ]));
    expect(lines(container).map(words)).toEqual(before);
    expect(container.querySelectorAll('button')).toHaveLength(2);
  });

  it('one agent asking twice about a reference: its line counts both proposals, as the promoted line does', () => {
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_a', 'ast_1', { proposal: { changes: 1 } }), update('pa_b', 'ast_1', { at: new Date(T0 + 1).toISOString(), proposal: { changes: 1 } })]);
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    expect(lines(container).map(words)).toEqual(['Codex has 2 requests to change a reference']);
    expect(lines(container)[0].querySelectorAll('.commons-notice__dot')).toHaveLength(1);
  });

  it('the inbox word reaches the line only from a ref that says inbox: true', () => {
    const withRef = (proposal: unknown) => sanitizeNote({ ...update('pa_a', 'ast_1'), proposal })?.proposal ?? null;
    expect(withRef({ id: 'pa_a', kind: 'commons', targetId: 'ast_1', changes: 1, inbox: true })?.inbox).toBe(true);
    for (const inbox of ['yes', 1, false, null]) {
      expect(withRef({ id: 'pa_a', kind: 'commons', targetId: 'ast_1', changes: 1, inbox })).not.toHaveProperty('inbox');
    }
    expect(commonsAsks(withRef({ id: 'pa_a', kind: 'commons', targetId: 'ast_1', changes: 1, inbox: true }))).toBe('take a reference out of the inbox');
    expect(commonsAsks(withRef({ id: 'pa_a', kind: 'commons', targetId: 'ast_1', changes: 1, inbox: 'yes' }))).toBe('change a reference');
  });

  it('a held Update joins a line the tab already knows: one line, its count, and Review stays', () => {
    useAssetProposalsStore.getState().open(commonsProposal({ id: 'pa_k', createdAt: T0 - 10 }), 'k');
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_h', 'ast_1', { proposal: { changes: 1 } })]);
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    expect(lines(container).map(words)).toEqual(['Claude Code and Codex have 2 requests to change a reference']);
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('a withdrawn or an expired proposal\'s Update resolves, and its held line goes', () => {
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_a', 'ast_1', { proposal: { changes: 2 } }), update('pa_b', 'ast_2', { at: new Date(T0 + 1).toISOString() })]);
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    expect(lines(container)).toHaveLength(2);
    act(() => setUpdates([update('pa_a', 'ast_1', { proposal: { changes: 2 }, resolvedAt: new Date(T0 + 9).toISOString(), outcome: 'Withdrawn by Codex' }),
      update('pa_b', 'ast_2', { at: new Date(T0 + 1).toISOString() })]));
    expect(lines(container).map((line) => line.dataset.heldCommons)).toEqual(['pa_b']);
    expect(lines(container)).toHaveLength(1);
    act(() => setUpdates([update('pa_a', 'ast_1', { proposal: { changes: 2 }, resolvedAt: new Date(T0 + 9).toISOString(), outcome: 'Withdrawn by Codex' }),
      update('pa_b', 'ast_2', { at: new Date(T0 + 1).toISOString(), resolvedAt: new Date(T0 + 10).toISOString(), outcome: 'Expired' })]));
    expect(lines(container)).toHaveLength(0);
  });

  it('only while held or waiting for the person\'s sync; never for a proposal already here or another kind', () => {
    const notes = [update('pa_1', 'ast_1'), update('pa_2', 'ast_1'),
      { ...update('pa_3', 'dusk'), actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'pa_3', target: 'project', targetId: 'dusk' } }] }];
    const proposals = { pa_2: { view: commonsProposal({ id: 'pa_2' }), acceptKey: 'k' } };
    expect(heldCommonsLines(notes, proposals, false)).toEqual([]);
    expect(heldCommonsLines(notes, proposals, true).map((line) => line.proposalId)).toEqual(['pa_1']);
  });

  it('a promoted line names its agents with a dot each, as the held one does', () => {
    const store = useAssetProposalsStore.getState();
    store.open(commonsProposal({ id: 'pa_x', agent: { id: 'claude-code', name: 'Claude Code', color: '#E8825A' } }), 'k1');
    store.open(commonsProposal({ id: 'pa_y', agent: { id: 'codex', name: 'Codex', color: 'red' } }), 'k2');
    const { container } = render(<CommonsProposalsLine onOpen={() => {}} />);
    const [line] = lines(container);
    expect([...line.querySelectorAll<HTMLElement>('.commons-notice__dot')].map((dot) => dot.style.getPropertyValue('--agent-color')))
      .toEqual(['#E8825A', '#5B9DFF']);
  });
});
