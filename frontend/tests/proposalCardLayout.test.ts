import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatChipEstimate } from '../src/lib/pricing';

/**
 * GM - Design, 2026-11-01 (the canvas proposal card redesign, brand dogfood
 * item 24). The card was a row: the text column beside three unshrinkable
 * buttons, so a ~385 px card left the text 75-100 px. It is one column now,
 * and "at any card width W from 320 to 600, the note's box is at least
 * W - 36 px wide". jsdom lays nothing out, so this reads the rules that make
 * that true (the live check measures it in a browser, docs/notes).
 */

const CSS = readFileSync(join(__dirname, '../src/styles/canvasProposals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const BAR = readFileSync(join(__dirname, '../src/components/canvas/ProposalBar.tsx'), 'utf8');

function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(match[1].split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon).trim(), part.slice(colon + 1).trim()];
  }));
}

const px = (value: string) => Number(/^(\d+(?:\.\d+)?)px/.exec(value)?.[1] ?? NaN);

describe('the proposal card is one column', () => {
  it('stacks body and footer, so no button row takes width from the note', () => {
    const card = rule('.proposal-bar');
    expect(card.display).toBe('flex');
    expect(card['flex-direction']).toBe('column');
    expect(card.padding).toBe('0');
    expect(rule('.proposal-bar__body')['flex-direction']).toBe('column');
    // The buttons live in the footer, a sibling of the body, never beside the note.
    const body = BAR.slice(BAR.indexOf('className="proposal-bar__body"'), BAR.indexOf('className="proposal-bar__footer"'));
    expect(body).toContain('className="proposal-bar__note"');
    expect(body).not.toContain('proposal-bar__button');
    expect(BAR).not.toContain('proposal-bar__main');
  });

  it('gives the note W - 36 px at every card width from 320 to 600', () => {
    const card = rule('.proposal-bar');
    const border = px(card.border.split(' ')[0]);
    const edge = px(card['border-left'].split(' ')[0]);
    const [, horizontal] = rule('.proposal-bar__body').padding.split(' ').map(px);
    const note = rule('.proposal-bar__note');
    expect(note.margin).toBe('0');
    expect(note['max-width']).toBeUndefined();
    const area = rule('.proposal-bar__note-area');
    expect(area['margin-top']).toBe('8px');
    for (let width = 320; width <= 600; width += 10) {
      const noteWidth = width - border - edge - 2 * horizontal;
      expect(noteWidth).toBeGreaterThanOrEqual(width - 36);
    }
  });

  it('keeps the name to one line and the header to 20 px', () => {
    expect(rule('.proposal-bar__head').height).toBe('20px');
    expect(rule('.proposal-bar__head')['white-space']).toBe('nowrap');
    const agent = rule('.proposal-bar__agent');
    expect(agent['text-overflow']).toBe('ellipsis');
    expect(agent['min-width']).toBe('0');
    expect(agent.color).not.toContain('--agent-color');
  });

  it('makes Accept the primary button, never the agent colour', () => {
    const primary = rule('.proposal-bar__button--primary');
    expect(primary.background).toBe('var(--sr-ink, rgb(255 255 255 / 0.92))');
    expect(primary.color).toBe('var(--sr-canvas, #000)');
    expect(CSS).not.toMatch(/\.proposal-bar__button--primary[^{]*\{[^}]*--agent-color/);
  });

  it('shows Show as its icon alone below 400 px of card width', () => {
    expect(rule('.proposal-bar').container).toBe('proposal-card / inline-size');
    expect(CSS).toMatch(/@container proposal-card \(width < 396px\)\s*\{\s*\.proposal-bar__show-label\s*\{\s*display: none;/);
    expect(BAR).toMatch(/proposal-bar__button--show"\s+aria-label="Show"/);
  });
});

/** The plan line's price is the backend's twin of the run chip (services/
 * money.chip_label); both sides read this table. */
const CHIPS = JSON.parse(readFileSync(join(__dirname, '../../contracts/fixtures/money/chips.json'), 'utf8')) as {
  chip: { low: number; high: number | null; open: boolean; text: string }[];
};

describe('the run chip reads as the backend writes it', () => {
  it.each(CHIPS.chip)('$low to $high (open $open) reads $text', ({ low, high, open, text }) => {
    expect(formatChipEstimate(low, high ?? Number.NaN, open)).toBe(text);
  });
});
