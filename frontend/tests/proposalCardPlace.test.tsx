import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GM - Design, PR #216 r1 (the proposal card, round 2).
 * - The Agent log: only one clearance ever applies. Beside a docked log the
 *   card keeps the notice region's clearance while that leaves it 400 px;
 *   below, it sits above the log at the full width (up to 600), its bottom
 *   over the log's top edge. The log never moves for it.
 * - "Show all" at 420: the card's height is capped at the region's room;
 *   past it the note area scrolls, and the header, plan line and footer stay.
 * jsdom lays nothing out: these read the rules, ProposalBar.test.tsx the
 * marking, and the live check measures them (docs/notes).
 */
const CSS = readFileSync(join(__dirname, '../src/styles/canvasProposals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const BAR = readFileSync(join(__dirname, '../src/components/canvas/ProposalBar.tsx'), 'utf8');

function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(CSS);
  if (!match) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(match[1].split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const colon = part.indexOf(':');
    return [part.slice(0, colon).trim(), part.slice(colon + 1).replace(/\s+/g, ' ').trim()];
  }));
}

describe('the card and the Agent log', () => {
  it('above the log: full width up to 600, lifted over its top edge, back to the window centre', () => {
    const above = rule(".proposal-bar[data-above-log='true']");
    expect(above['--proposal-bar-lift']).toBe('max(0px, var(--agent-log-top, 0px) - var(--notice-region-bottom, 32px))');
    expect(above.width).toBe('min(var(--proposal-bar-max-w), calc(100vw - 2 * var(--page-gutter, 16px)))');
    expect(above.translate).toBe(
      'calc((max(var(--page-gutter, 16px), var(--agent-log-clearance, 0px)) - var(--page-gutter, 16px)) / 2) calc(-1 * var(--proposal-bar-lift))');
    expect(BAR).toMatch(/const BESIDE_LOG_MIN_W = 400;/);
  });

  it('caps the card at the region\'s room, and only the note area gives way', () => {
    const card = rule('.proposal-bar');
    expect(card['max-height']).toBe(
      'calc(100dvh - var(--notice-region-bottom, 32px) - var(--proposal-bar-lift) - var(--proposal-bar-top-line, 72px))');
    expect(rule('.proposal-bar__body')['min-height']).toBe('0');
    expect(rule('.proposal-bar__body > *')['flex-shrink']).toBe('0');
    const area = rule('.proposal-bar__note-area');
    expect(area.flex).toBe('0 1 auto');
    expect(area['min-height']).toBe('0');
    expect(area['overflow-y']).toBe('auto');
    expect(rule('.proposal-bar__footer')['flex-shrink']).toBe('0');
  });
});
