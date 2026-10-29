// PR #200 follow-up 2: the held placeholder (GM r34) after review 20 and GM's
// rulings on it.
// - NIT-6 (GM): the dot, the name and the header sit in the same place on the
//   placeholder and on the real card, so the swap on promote moves nothing.
// - GM-Q1 (GM): a cover's Update says which kind, so the placeholder can say
//   "proposes the automatic cover" as the real card does. Only the kind.
// - NIT-3: the Commons count comes from the Update's ref, never its text (an
//   agent's name is part of the text).
// - NIT-4: a focused placeholder hands focus to the real card that replaces it.
// - Review 20's untested branch: a malformed author colour gets the fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useLayoutEffect, useRef } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import type { AgentNote } from '../../lib/agentNotes';

const net = vi.hoisted(() => ({ accept: vi.fn(), reject: vi.fn(), fetch: vi.fn() }));
vi.mock('../../lib/backend', () => ({ backendAssetUrlSync: (url: string) => url, apiFetch: net.fetch }));
vi.mock('../../lib/assetProposals', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/assetProposals')>()), acceptAssetProposal: net.accept, rejectAssetProposal: net.reject }));

const { AssetProposalStrip } = await import('./AssetProposalStrip');
const { useAssetProposalsStore } = await import('../../store/assetProposalsStore');
const { useAgentNotesStore } = await import('../../store/agentNotesStore');
const { heldProposalsFor } = await import('../../store/heldAssetProposals');
const { coverProposal, commonsProposal } = await import('../../test/assetProposalFixtures');
const { sanitizeNote, surfaceKey } = await import('../../lib/agentNotes');
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

beforeEach(() => {
  useAssetProposalsStore.getState().clear();
  useAssetProposalsStore.setState({ awaitingSync: false });
  useAgentNotesStore.getState().reset();
});
afterEach(() => { cleanup(); session.resetPersonSessionForTests(); });

// -- NIT-6: the content starts at the same place on both cards ------------------------

function px(value: string | undefined): number {
  const match = /^(-?\d+(?:\.\d+)?)px$/.exec((value ?? '').trim());
  if (!match) throw new Error(`not a px length: ${value}`);
  return Number(match[1]);
}

/** One rule's declarations, by exact selector, from the stylesheet with its comments removed. */
function declarations(css: string, selector: string): Record<string, string> {
  const rule = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].find((match) => match[1].trim() === selector);
  if (!rule) throw new Error(`no rule ${selector}`);
  return Object.fromEntries(rule[2].split(';').map((part) => part.split(':')).filter((pair) => pair.length >= 2)
    .map(([name, ...value]) => [name.trim(), value.join(':').trim()]));
}

/** The four sides of a CSS padding shorthand. */
function sides(shorthand: string): { top: number; right: number; bottom: number; left: number } {
  const [top, right = top, bottom = top, left = right] = shorthand.split(/\s+/).map(px);
  return { top, right, bottom, left };
}

describe('review 20 NIT-6 (GM): the swap on promote moves nothing inside the box', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/styles/asset-proposals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const base = declarations(css, '.asset-proposal');
  const held = declarations(css, '.asset-proposal--held');
  const padding = sides(base.padding);
  const edge = px(base.border.split(/\s+/)[0]);
  const realLeftEdge = px(base['border-left'].split(/\s+/)[0]);

  it('the content starts 15px in on both: a 3px edge + 12px, and a 1px edge + 14px', () => {
    const real = realLeftEdge + padding.left;
    const placeholder = px(held['border-left-width']) + px(held['padding-left'] ?? `${padding.left}px`);
    expect(real).toBe(15);
    expect(placeholder).toBe(real);
  });

  it('the top and the right side are the same on both (the placeholder sets neither)', () => {
    for (const name of Object.keys(held)) {
      expect(name).not.toMatch(/^(padding(-top|-right)?|border(-top|-right)?(-width)?|border-width|gap|margin|font|line-height)$/);
    }
    // 1px edge + 10px padding on top, on both.
    expect(edge + padding.top).toBe(11);
  });
});

// -- GM-Q1: the cover's kind ------------------------------------------------------------

describe('GM-Q1: a cover\'s placeholder says which kind, from the Update\'s ref', () => {
  it.each([
    [{ cover: 'automatic' as const }, 'proposes the automatic cover'],
    [{ cover: 'image' as const }, 'proposes a new cover'],
    [null, 'proposes a new cover'],
    [{}, 'proposes a new cover'],
  ])('ref %j: %s', (ref, header) => {
    const [item] = heldProposalsFor([update('pa_1', { proposal: ref })], {}, true, 'project', 'dusk');
    expect(item.header).toBe(header);
  });

  it('matches the real card for a proposal back to the automatic cover, as rendered', () => {
    act(() => session.reportPersonRequired());
    useAssetProposalsStore.getState().open(coverProposal({ id: 'pa_real', createdAt: T0 - 1,
      change: { cover: { from: '/api/outputs/a.png', to: null, fromBy: { kind: 'person', name: 'You' } } } }), 'k');
    setUpdates([update('pa_held', { proposal: { cover: 'automatic' } })]);
    const { container } = render(<AssetProposalStrip kind="project" targetId="dusk" />);
    const real = container.querySelector('[data-proposal-id="pa_real"] .asset-proposal__asks')?.textContent;
    const placeholder = container.querySelector('[data-held-proposal="pa_held"] .asset-proposal__asks')?.textContent;
    expect(real).toBe('proposes the automatic cover');
    expect(placeholder).toBe(real);
  });

  it('the text never decides it: an Update whose text names "the automatic cover" but whose ref says image', () => {
    const [item] = heldProposalsFor([update('pa_1', { text: 'the automatic cover asks to change the cover of Dusk',
      author: { kind: 'agent', id: 'x', name: 'the automatic cover', color: '#5B9DFF' }, proposal: { cover: 'image' } })],
    {}, true, 'project', 'dusk');
    expect(item.header).toBe('proposes a new cover');
  });

  it('sanitizeNote keeps only a known kind and a whole count; nothing else from the ref reaches the tab', () => {
    const raw = (proposal: unknown) => ({ id: 'n1', author: { kind: 'agent', id: 'c', name: 'C', color: '#5B9DFF' },
      text: 't', about: 'proposal', proposal });
    expect(sanitizeNote(raw({ id: 'pa', kind: 'project', targetId: 'dusk', cover: 'automatic' }))?.proposal).toEqual({ cover: 'automatic' });
    expect(sanitizeNote(raw({ cover: '/api/outputs/c.png', changes: '3', url: '/api/outputs/c.png' }))?.proposal).toEqual({});
    expect(sanitizeNote(raw({ changes: 2.5 }))?.proposal).toEqual({});
    expect(sanitizeNote(raw({ changes: 3 }))?.proposal).toEqual({ changes: 3 });
    expect(sanitizeNote({ ...raw({ cover: 'image' }), about: 'other' })?.proposal).toBeNull();
  });
});

// -- NIT-3: the Commons count from the ref --------------------------------------------

describe('review 20 NIT-3: the Commons count comes from the ref, never the text', () => {
  it('an agent named to look like a count can\'t change the header', () => {
    const name = 'Mallory asks to make 9 changes';
    const spoof = update('pa_s', { author: { kind: 'agent', id: 'm', name, color: '#5B9DFF' },
      text: `${name} asks to change a reference in the Commons`, proposal: { changes: 1 } }, 'commons', 'ast_1');
    expect(heldProposalsFor([spoof], {}, true, 'commons', 'ast_1')[0].header).toBe('proposes a change to this reference');
  });

  it('the count in the ref is what shows, whatever the text says', () => {
    const three = update('pa_3', { text: 'Claude Code asks to change a reference in the Commons', proposal: { changes: 3 } }, 'commons', 'ast_1');
    expect(heldProposalsFor([three], {}, true, 'commons', 'ast_1')[0].header).toBe('proposes 3 changes to this reference');
  });

  it('matches the real card at 4 edits, as rendered', () => {
    useAssetProposalsStore.getState().open(commonsProposal({ id: 'pa_c' }), 'k');
    const { container } = render(<AssetProposalStrip kind="commons" targetId="ast_1" />);
    const real = container.querySelector('.asset-proposal__asks')?.textContent;
    expect(real).toBe('proposes 4 changes to this reference');
    const [held] = heldProposalsFor([update('pa_h', { proposal: { changes: 4 } }, 'commons', 'ast_1')], {}, true, 'commons', 'ast_1');
    expect(held.header).toBe(real);
  });
});

// -- NIT-4: focus follows the swap ----------------------------------------------------

describe('review 20 NIT-4: a focused placeholder hands focus to its real card', () => {
  function heldStrip() {
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_new')]);
    return render(<><button type="button" data-testid="elsewhere">x</button><AssetProposalStrip kind="project" targetId="dusk" /></>);
  }
  function promoteAndSync() {
    act(() => session.notePersonPromoted());
    act(() => useAssetProposalsStore.getState().sync([{ ...coverProposal({ id: 'pa_new', createdAt: T0 }), acceptKey: 'k1' }]));
  }

  it('Review focused the placeholder: after the promote the real card has focus, not the page', () => {
    Element.prototype.scrollIntoView = vi.fn();
    useAssetProposalsStore.setState({ review: { kind: 'project', targetId: 'dusk', at: Date.now() } });
    const { container } = heldStrip();
    expect(document.activeElement).toBe(container.querySelector('[data-held-proposal="pa_new"]'));
    promoteAndSync();
    expect(container.querySelector('[data-held-proposal]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[data-proposal-id="pa_new"]'));
  });

  it('focus elsewhere stays where it is', () => {
    const { container, getByTestId } = heldStrip();
    getByTestId('elsewhere').focus();
    promoteAndSync();
    expect(document.activeElement).toBe(getByTestId('elsewhere'));
    expect(container.querySelector('[data-proposal-id="pa_new"]')).not.toBeNull();
  });

  it('focus that something else took in the same commit is left there', () => {
    // A control that takes focus when the person's sync lands, laid out before the strip.
    function TakesFocus() {
      const count = useAssetProposalsStore((state) => Object.keys(state.proposals).length);
      const input = useRef<HTMLInputElement>(null);
      useLayoutEffect(() => { if (count > 0) input.current?.focus(); }, [count]);
      return <input ref={input} data-testid="taker" />;
    }
    Element.prototype.scrollIntoView = vi.fn();
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_new')]);
    useAssetProposalsStore.setState({ review: { kind: 'project', targetId: 'dusk', at: Date.now() } });
    const { container, getByTestId } = render(<><TakesFocus /><AssetProposalStrip kind="project" targetId="dusk" /></>);
    expect(document.activeElement).toBe(container.querySelector('[data-held-proposal="pa_new"]'));
    promoteAndSync();
    expect(document.activeElement).toBe(getByTestId('taker'));
  });

  it('a placeholder that never had focus gives none', () => {
    const { container } = heldStrip();
    promoteAndSync();
    expect(container.querySelector('[data-proposal-id="pa_new"]')).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

// -- review 20's untested branch: a malformed author colour -----------------------------

describe('review 20: the placeholder checks the Update author\'s colour as the real card does', () => {
  it.each(['red', '#fff', 'url(x)', '#5b9dffzz', ''])('author.color %j gets the #5B9DFF fallback', (color) => {
    act(() => session.reportPersonRequired());
    setUpdates([update('pa_bad', { author: { kind: 'agent', id: 'x', name: 'X', color } })]);
    expect(heldProposalsFor([update('pa_bad', { author: { kind: 'agent', id: 'x', name: 'X', color } })], {}, true, 'project', 'dusk')[0].agentColor)
      .toBe('#5B9DFF');
    const { container } = render(<AssetProposalStrip kind="project" targetId="dusk" />);
    const card = container.querySelector<HTMLElement>('[data-held-proposal="pa_bad"]')!;
    expect(card.style.getPropertyValue('--agent-color')).toBe('#5B9DFF');
  });
});
