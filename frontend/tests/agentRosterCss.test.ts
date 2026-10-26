import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GM - Design's review of the Agents panel (PR #193): the chevron points up
 * while the panel is open and down while it is closed, every moment of the
 * change and on hover too; the Needs-you badge is a filled light pill with a
 * dark number in the corner's ink tokens, never an agent's colour, and the
 * chip carries the same badge.
 */
const roster = readFileSync(join(__dirname, '../src/components/agent-notes/agentRoster.css'), 'utf8');
const notes = readFileSync(join(__dirname, '../src/components/agent-notes/agentNotes.css'), 'utf8');

function rule(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
}

function transformOf(block: string): string {
  return /transform:\s*([^;]+);/.exec(block)?.[1].trim() ?? '';
}

describe('the chevron', () => {
  it('turns by flipping, never by rotating through a side', () => {
    const closed = transformOf(rule(roster, '.agent-roster__chevron'));
    const open = transformOf(rule(roster, ".agent-roster__toggle[aria-expanded='true'] .agent-roster__chevron"));
    const rotate = (t: string) => /rotate\(([^)]+)\)/.exec(t)?.[1];
    // Same rotation both ways (the border corner points down); open is the vertical mirror.
    expect(rotate(closed)).toBe('45deg');
    expect(rotate(open)).toBe('45deg');
    expect(closed).toMatch(/scaleY\(1\)/);
    expect(open).toMatch(/scaleY\(-1\)/);
    // Mirror applied after the rotation (in the parent's frame): scaleY sits left of rotate.
    expect(open.indexOf('scaleY')).toBeLessThan(open.indexOf('rotate'));
  });

  it('hover changes no direction', () => {
    for (const match of roster.matchAll(/([^{}]*:hover[^{}]*)\{([^}]*)\}/g)) {
      if (match[1].includes('chevron')) expect(match[2]).not.toMatch(/transform|rotate/);
    }
  });
});

describe('the Needs-you badge', () => {
  it('is a filled light pill with a dark number, in the ink tokens', () => {
    const badge = rule(notes, '.agent-notes-needs-badge');
    expect(badge).toMatch(/background:\s*var\(--an-ink-bold\)/);
    expect(badge).toMatch(/color:\s*var\(--an-on-dot\)/);
    expect(badge).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(badge).toMatch(/border-radius:\s*999px/);
  });

  it("never takes an agent's colour", () => {
    expect(roster).not.toMatch(/--ar-attention/);
    expect(roster).not.toMatch(/agent-roster__badge--attention/);
  });
});
