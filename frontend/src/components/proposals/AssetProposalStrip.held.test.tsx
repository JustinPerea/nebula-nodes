// PR #200 fix round 23, GM r34 (review 19 NIT-4): while the person gate holds,
// a new asset proposal reaches this tab only as its Update. Its strip shows a
// placeholder built from the Update alone: the agent's name, the real card's
// header, "You can review this when this tab is connected as you.", no
// thumbnails, no buttons. The person's sync after the promote puts the real
// card in its place (no spring-in); an Update resolved first (expired,
// withdrawn) takes the placeholder with it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentNote } from '../../lib/agentNotes';

const net = vi.hoisted(() => ({ accept: vi.fn(), reject: vi.fn(), fetch: vi.fn() }));
vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: net.fetch }));
vi.mock('../../lib/assetProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/assetProposals')>()), acceptAssetProposal: net.accept, rejectAssetProposal: net.reject }));

const { AssetProposalStrip } = await import('./AssetProposalStrip');
const { ProposalsFor } = await import('./ProposalsFor');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { useAgentNotesStore } = await import('../../store/agentNotesStore');
const { heldProposalsFor, HELD_PROPOSAL_LINE } = await import('../../store/heldAssetProposals');
const { coverProposal, commonsProposal } = await import('../../test/assetProposalFixtures');
const { surfaceKey } = await import('../../lib/agentNotes');
const session = await import('../../lib/personSession');

const T0 = Date.parse('2026-10-29T12:00:00.000Z');

function update(proposalId: string, overrides: Partial<AgentNote> = {}, target = 'project', targetId = 'dusk'): AgentNote {
  return {
    id: `n_${proposalId}`, author: { kind: 'agent', id: 'claude-code', name: 'Claude Code', color: '#5B9DFF' },
    source: 'nebula', about: 'proposal', at: new Date(T0).toISOString(), text: 'Claude Code asks to change the cover of Dusk',
    parts: [], refs: [], readAt: null, dismissedAt: null, actedAt: null, actedWith: null, resolvedAt: null, outcome: null,
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId, target, targetId } }], ...overrides,
  };
}

function setUpdates(notes: AgentNote[]): void {
  useAgentNotesStore.setState({ canvasProjectId: 'p1',
    lists: { [surfaceKey({ kind: 'canvas', projectId: 'p1' })]: { notes, unread: notes.length, loaded: true } } });
}

const cards = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.asset-proposal')];

beforeEach(() => {
  useAssetProposalsStore.getState().clear();
  useAssetProposalsStore.setState({ awaitingSync: false });
  useAgentNotesStore.getState().reset();
  net.accept.mockReset(); net.reject.mockReset(); net.fetch.mockReset();
});
afterEach(() => { cleanup(); session.resetPersonSessionForTests(); });

describe('GM r34: a placeholder for a proposal this held tab knows only from its Update', () => {
  it('held: the placeholder shows the agent, the real header and the one line; no thumbnails, no buttons, nothing sent', () => {
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_new')]);
    const { container } = render(<ProposalsFor kind="project" targetId="dusk" />);
    return vi.waitFor(() => {
      const [card] = cards(container);
      expect(card).toBeDefined();
      expect(card.dataset.heldProposal).toBe('pa_new');
      expect(card.className).toContain('asset-proposal--held');
      expect(card.querySelector('.asset-proposal__agent')?.textContent).toBe('Claude Code');
      expect(card.querySelector('.asset-proposal__asks')?.textContent).toBe('proposes a new cover');
      expect(card.querySelector('.asset-proposal__held-line')?.textContent).toBe('You can review this when this tab is connected as you.');
      expect(card.getAttribute('role')).toBe('group');
      expect(card.querySelectorAll('button, img, a, input, [tabindex="0"]')).toHaveLength(0);
      expect(card.querySelector('.asset-proposal__covers')).toBeNull();
      card.click();
      expect(net.fetch).not.toHaveBeenCalled();
      expect(net.accept).not.toHaveBeenCalled();
      expect(net.reject).not.toHaveBeenCalled();
    });
  });

  it('promote, then the person\'s sync: the real card takes the placeholder\'s place, without springing in', () => {
    useAssetProposalsStore.getState().open(coverProposal({ id: 'pa_old', createdAt: T0 - 60_000, note: 'old' }), 'k0');
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_new'), update('pa_later', { at: new Date(T0 + 60_000).toISOString() })]);
    const { container } = render(<AssetProposalStrip kind="project" targetId="dusk" />);
    const order = () => cards(container).map((card) => card.dataset.heldProposal ?? `real:${card.querySelector('.asset-proposal__note')?.textContent}`);
    expect(order()).toEqual(['real:old', 'pa_new', 'pa_later']);
    // The canvas's proposalSync promotes first; the asset sync is the next frame: the placeholders hold until it.
    act(() => session.notePersonPromoted());
    expect(order()).toEqual(['real:old', 'pa_new', 'pa_later']);
    act(() => useAssetProposalsStore.getState().sync([
      { ...coverProposal({ id: 'pa_old', createdAt: T0 - 60_000, note: 'old' }), acceptKey: 'k0' },
      { ...coverProposal({ id: 'pa_new', createdAt: T0, note: 'new' }), acceptKey: 'k1' },
      { ...coverProposal({ id: 'pa_later', createdAt: T0 + 60_000, note: 'later' }), acceptKey: 'k2' },
    ]));
    expect(order()).toEqual(['real:old', 'real:new', 'real:later']);
    const [old, replaced, later] = cards(container);
    expect(old.className).not.toContain('asset-proposal--in-place');
    expect(replaced.className).toContain('asset-proposal--in-place');
    expect(later.className).toContain('asset-proposal--in-place');
    expect(container.querySelector('.asset-proposal--held')).toBeNull();
  });

  it('withdrawn or expired before the promote: its Update resolves and the placeholder goes with it', () => {
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_a'), update('pa_b', { at: new Date(T0 + 1).toISOString() })]);
    const { container } = render(<AssetProposalStrip kind="project" targetId="dusk" />);
    expect(cards(container).map((card) => card.dataset.heldProposal)).toEqual(['pa_a', 'pa_b']);
    act(() => setUpdates([update('pa_a', { resolvedAt: new Date(T0 + 5).toISOString(), outcome: 'Withdrawn by Claude Code' }),
      update('pa_b', { at: new Date(T0 + 1).toISOString() })]));
    expect(cards(container).map((card) => card.dataset.heldProposal)).toEqual(['pa_b']);
    act(() => setUpdates([update('pa_a', { resolvedAt: new Date(T0 + 5).toISOString(), outcome: 'Withdrawn by Claude Code' }),
      update('pa_b', { at: new Date(T0 + 1).toISOString(), resolvedAt: new Date(T0 + 9).toISOString(), outcome: 'Expired' })]));
    expect(cards(container)).toHaveLength(0);
  });

  it('only while held or waiting for the person\'s sync; never for another target, a resolved Update or a card already here', () => {
    const notes = [update('pa_1'), update('pa_2', {}, 'project', 'other'), update('pa_3', { resolvedAt: 'x' }),
      update('pa_4'), update('pa_5', { about: 'other' }), update('pa_6', {}, 'moodboard', 'dusk')];
    const proposals = { pa_4: { view: coverProposal({ id: 'pa_4' }), acceptKey: 'k' } };
    expect(heldProposalsFor(notes, proposals, false, 'project', 'dusk')).toEqual([]);
    expect(heldProposalsFor(notes, proposals, true, 'project', 'dusk').map((item) => item.proposalId)).toEqual(['pa_1']);
    expect(heldProposalsFor(notes, proposals, true, 'moodboard', 'dusk')).toEqual([
      { proposalId: 'pa_6', agentName: 'Claude Code', agentColor: '#5B9DFF', header: 'asks to send these notes to generators', at: T0 }]);
  });

  it('a Commons ask uses the real card\'s header, counted from the Update', () => {
    const one = update('pa_c1', { text: 'Claude Code asks to change a reference in the Commons' }, 'commons', 'ast_1');
    const four = update('pa_c4', { text: 'Claude Code asks to make 4 changes to a reference in the Commons' }, 'commons', 'ast_1');
    expect(heldProposalsFor([one, four], {}, true, 'commons', 'ast_1').map((item) => item.header))
      .toEqual(['proposes a change to this reference', 'proposes 4 changes to this reference']);
    expect(HELD_PROPOSAL_LINE).toBe('You can review this when this tab is connected as you.');
  });

  it('the gate holding is what starts the wait; the person\'s sync ends it', () => {
    expect(useAssetProposalsStore.getState().awaitingSync).toBe(false);
    session.reportPersonRequired();
    expect(useAssetProposalsStore.getState().awaitingSync).toBe(true);
    session.notePersonPromoted();
    expect(useAssetProposalsStore.getState().awaitingSync).toBe(true);
    useAssetProposalsStore.getState().sync([]);
    expect(useAssetProposalsStore.getState().awaitingSync).toBe(false);
  });

  it('Review on the Update brings the placeholder into view and focuses it', () => {
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_new')]);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    useAssetProposalsStore.setState({ review: { kind: 'project', targetId: 'dusk', at: Date.now() } });
    const { container } = render(<AssetProposalStrip kind="project" targetId="dusk" />);
    expect(scroll).toHaveBeenCalled();
    expect(document.activeElement).toBe(container.querySelector('[data-held-proposal="pa_new"]'));
  });

  // GM r35 (fix round 24): the dot and the name keep the asking agent's identity colour, from the same
  // identity the real card's view carries (the Update's author is the proposal's agent).
  it.each([['Codex', '#4F8CFF'], ['Claude Code', '#E8825A'], ['Argon', '#7C5CFF']])(
    'the placeholder\'s dot and name get the same colour as the real card\'s for %s', (name, color) => {
      act(() => session.reportPersonRequired());
      const agent = { id: name.toLowerCase().replace(/ /g, '-'), name, color };
      setUpdates([update('pa_held', { author: { kind: 'agent', ...agent } })]);
      useAssetProposalsStore.getState().open(coverProposal({ id: 'pa_real', agent, createdAt: T0 - 1 }), 'k');
      const { container } = render(<AssetProposalStrip kind="project" targetId="dusk" />);
      const placeholder = container.querySelector<HTMLElement>('[data-held-proposal="pa_held"]')!;
      const real = container.querySelector<HTMLElement>('.asset-proposal:not(.asset-proposal--held)')!;
      expect(placeholder.style.getPropertyValue('--agent-color')).toBe(color);
      expect(real.style.getPropertyValue('--agent-color')).toBe(color);
      expect(placeholder.querySelector('.asset-proposal__agent')?.textContent).toBe(name);
      expect(placeholder.querySelector('.asset-proposal__dot')).not.toBeNull();
    });

  it('the stylesheet draws the placeholder\'s dot and name from --agent-color, and only its edge neutral', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve(process.cwd(), 'src/styles/asset-proposals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const held = [...css.matchAll(/([^{}]*asset-proposal--held[^{}]*)\{([^}]*)\}/g)];
    expect(held.map((rule) => rule[1].trim())).toEqual(['.asset-proposal--held']);
    expect(held[0][2]).not.toMatch(/--agent-color|background/);
    expect(held[0][2]).toMatch(/border-left-color:\s*var\(--sr-edge-strong/);
    expect(css).toMatch(/\.asset-proposal__dot \{[^}]*background: var\(--agent-color\)/);
    expect(css).toMatch(/\.asset-proposal__agent \{[^}]*color: var\(--agent-color\)/);
  });

  // GM r35: the placeholder's Commons header matches the real card's for every N.
  it.each([
    [1, 'Claude Code asks to change a reference in the Commons', 'proposes a change to this reference'],
    [2, 'Claude Code asks to make 2 changes to a reference in the Commons', 'proposes 2 changes to this reference'],
  ])('a Commons ask with %i change(s): the placeholder\'s header is the real card\'s', (count, text, header) => {
    const edits = [
      { correction: { field_path: 'summary.value', op: 'set', value: 'A quiet grid poster', reason: null } },
      { correction: { field_path: 'keywords', op: 'add', value: 'brutalist', reason: null } },
    ].slice(0, count);
    useAssetProposalsStore.getState().open(commonsProposal({ id: 'pa_c', change: { edits }, before: edits.map(() => ({ value: 'x' })) } as never), 'k');
    const { container } = render(<AssetProposalStrip kind="commons" targetId="ast_1" />);
    const realHeader = container.querySelector('.asset-proposal__asks')?.textContent;
    expect(realHeader).toBe(header);
    const [held] = heldProposalsFor([update('pa_h', { text }, 'commons', 'ast_1')], {}, true, 'commons', 'ast_1');
    expect(held.header).toBe(realHeader);
  });
});
