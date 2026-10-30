// PR #202 review 1 NIT-1 and NIT-2, and GM's ruling on its Q1: the cases the
// review's surviving mutations needed.
// - NIT-2: a ref's `changes` is 1 to 999; 0 reads as absent ("a change").
// - A Commons Update with no count reads "a change", never "0 changes".
// - Focus with two real cards goes to the one whose placeholder had it.
// - No other padding on the placeholder can undo its 14px left.
// - GM, Q1: an Update that falls back to the agent's older ask changes in
//   place: the corner's count and its arrival cards don't move for the swap.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentNote } from '../../lib/agentNotes';

vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: vi.fn() }));

const { AssetProposalStrip } = await import('./AssetProposalStrip');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { useAgentNotesStore } = await import('../../store/agentNotesStore');
const { heldProposalsFor, heldCommonsLines } = await import('../../store/heldAssetProposals');
const { coverProposal } = await import('../../test/assetProposalFixtures');
const { sanitizeNote, surfaceKey } = await import('../../lib/agentNotes');
const session = await import('../../lib/personSession');

const T0 = Date.parse('2026-10-29T12:00:00.000Z');
const CODEX = { kind: 'agent' as const, id: 'codex', name: 'Codex', color: '#7AD3FF' };
const CLAUDE = { kind: 'agent' as const, id: 'claude-code', name: 'Claude Code', color: '#C3E86B' };
const CANVAS = surfaceKey({ kind: 'canvas', projectId: 'p1' });

function update(proposalId: string, overrides: Partial<AgentNote> = {}, target = 'project', targetId = 'dusk'): AgentNote {
  return {
    id: `n_${proposalId}`, author: CLAUDE, source: 'nebula', about: 'proposal', at: new Date(T0).toISOString(),
    text: 'Claude Code asks to change the cover of Dusk', parts: [], refs: [], readAt: null, dismissedAt: null,
    actedAt: null, actedWith: null, resolvedAt: null, outcome: null,
    actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId, target, targetId } }], ...overrides,
  };
}

function setUpdates(notes: AgentNote[]): void {
  useAgentNotesStore.setState({ canvasProjectId: 'p1', lists: { [CANVAS]: { notes, unread: notes.length, loaded: true } } });
}

beforeEach(() => {
  useAssetProposalsStore.getState().clear();
  useAssetProposalsStore.setState({ awaitingSync: false });
  useAgentNotesStore.getState().reset();
});
afterEach(() => { cleanup(); session.resetPersonSessionForTests(); });

describe('review 1 NIT-2: a ref\'s count is 1 to 999', () => {
  const ref = (changes: unknown) => sanitizeNote({ ...update('pa'), proposal: { id: 'pa', kind: 'commons', targetId: 'ast_1', changes } })?.proposal;

  it.each([[1, 1], [8, 8], [999, 999]])('keeps %s', (changes, kept) => {
    expect(ref(changes)).toEqual({ changes: kept });
  });

  it.each([[0], [-1], [1000], [1e9], [2.5], ['3'], [true], [null]])('drops %s', (changes) => {
    expect(ref(changes)).toEqual({});
  });
});

describe('review 1 NIT-1: a Commons Update with no count reads "a change", never "0 changes"', () => {
  it.each([[null], [{}], [{ changes: 0 }]])('ref %j', (proposal) => {
    const note = update('pa_n', { proposal: proposal as AgentNote['proposal'] }, 'commons', 'ast_1');
    expect(heldProposalsFor([note], {}, true, 'commons', 'ast_1')[0].header).toBe('proposes a change to this reference');
    expect(heldCommonsLines([note], {}, true)[0].asks).toBe('change a reference');
    const sanitized = sanitizeNote(note)!;
    expect(heldProposalsFor([sanitized], {}, true, 'commons', 'ast_1')[0].header).toBe('proposes a change to this reference');
  });
});

describe('review 1 NIT-1: focus with two real cards', () => {
  it('the placeholder that had focus hands it to its own real card, not the first one', () => {
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_a', { author: CODEX }), update('pa_b', { at: new Date(T0 + 1).toISOString() })]);
    const { container } = render(<AssetProposalStrip kind="project" targetId="dusk" />);
    const second = container.querySelector<HTMLElement>('[data-held-proposal="pa_b"]');
    expect(container.querySelector('[data-held-proposal="pa_a"]')).not.toBeNull();
    act(() => second!.focus());
    expect(document.activeElement).toBe(second);
    act(() => session.notePersonPromoted());
    act(() => useAssetProposalsStore.getState().sync([
      { ...coverProposal({ id: 'pa_a', agent: { id: 'codex', name: 'Codex', color: '#7AD3FF' }, createdAt: T0 }), acceptKey: 'k1' },
      { ...coverProposal({ id: 'pa_b', createdAt: T0 + 1 }), acceptKey: 'k2' },
    ]));
    expect(container.querySelectorAll('[data-proposal-id]')).toHaveLength(2);
    expect(document.activeElement).toBe(container.querySelector('[data-proposal-id="pa_b"]'));
  });
});

describe('review 1 NIT-1: nothing else sets the placeholder\'s horizontal padding', () => {
  it('in every stylesheet, a rule naming .asset-proposal--held sets only its padding-left, in its own rule', () => {
    const dir = resolve(process.cwd(), 'src/styles');
    const found: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.css'))) {
      const css = readFileSync(resolve(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        if (!/\.asset-proposal--held(?![\w-])/.test(selector)) continue;
        for (const declaration of body.split(';')) {
          const name = declaration.split(':')[0].trim().toLowerCase();
          if (!/^padding(?:$|-)/.test(name)) continue;
          found.push(`${file}: ${selector.trim()} { ${name} }`);
        }
      }
    }
    expect(found).toEqual(['asset-proposals.css: .asset-proposal--held { padding-left }']);
  });
});

describe('GM, PR #202 review 1 Q1: an Update falling back to the older ask changes in place', () => {
  it('the text and the ref change; the corner\'s count and its arrival cards stay as they were', () => {
    const newer = update('pa_new', { author: CODEX, text: 'Codex asks to change a reference in the Commons', proposal: { changes: 1 } },
      'commons', 'ast_1');
    const apply = useAgentNotesStore.getState().apply;
    act(() => apply({ type: 'agentNotes', surface: 'canvas', op: 'added', projectId: 'p1', note: newer, unread: 1 } as never));
    const before = useAgentNotesStore.getState();
    expect(before.lists[CANVAS].unread).toBe(1);
    const arrivalsBefore = before.arrivals.length;
    // _follow_asset_updates: op "changed", the whole note, no unread (the read state didn't change).
    const fallback = { ...newer, text: 'Codex asks to make 3 changes to a reference in the Commons', proposal: { changes: 3 },
      actions: [{ label: 'Review', op: { kind: 'proposal.review', proposalId: 'pa_old', target: 'commons', targetId: 'ast_1' } }] };
    act(() => apply({ type: 'agentNotes', surface: 'canvas', op: 'changed', projectId: 'p1', ids: [newer.id], note: fallback } as never));
    const after = useAgentNotesStore.getState();
    expect(after.lists[CANVAS].notes.map((note) => [note.id, note.text, note.proposal])).toEqual([
      [newer.id, 'Codex asks to make 3 changes to a reference in the Commons', { changes: 3 }]]);
    expect(after.lists[CANVAS].unread).toBe(1);
    expect(after.arrivals.length).toBeLessThanOrEqual(arrivalsBefore);
    expect(after.arrivals.filter((arrival) => arrival.id !== newer.id)).toEqual([]);
  });
});
