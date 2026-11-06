import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GM - Design, round 20 (A), verbatim: "Give it a solid dark neutral pill,
 * the same height and radius as the "Codex" name tag, just under the tag.
 * The pill and text fade together. It must stay readable over any title at
 * any zoom."
 */
const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8');
const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
const value = (body: string, property: string) => new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(body)?.[1]?.trim();

describe("the cursor bubble's pill", () => {
  const tag = rule('.agent-cursor__name');
  const pill = rule('.agent-cursor__say');
  it("one line is the name tag's pill: its line height and vertical padding, a radius of half that height", () => {
    expect(value(pill, 'line-height')).toBe(value(tag, 'line-height'));
    expect(value(pill, 'padding')?.split(/\s+/)[0]).toBe(value(tag, 'padding')?.split(/\s+/)[0]);
    const height = Number.parseFloat(value(tag, 'line-height') ?? '') + 2 * Number.parseFloat(value(tag, 'padding') ?? '');
    expect(value(pill, 'border-radius')).toBe(`${height / 2}px`);
  });
  it('GM, PR #203 r39 item 5: it wraps to two lines at its max width before any ellipsis', () => {
    expect(value(pill, 'white-space')).toBe('normal');
    expect(value(pill, '-webkit-line-clamp')).toBe('2');
    expect(value(pill, 'line-clamp')).toBe('2');
    expect(value(pill, 'display')).toBe('-webkit-box');
    expect(value(pill, '-webkit-box-orient')).toBe('vertical');
    expect(value(pill, 'max-width')).toBe('260px');
    // Its own width up to that, never the cursor's narrow box (found live, round 20).
    expect(value(pill, 'width')).toBe('max-content');
  });
  it('a solid dark neutral background: no transparency, no agent colour', () => {
    const background = value(pill, 'background') ?? '';
    expect(background).toMatch(/^(?:#[0-9a-f]{6}|rgb\(\d+ \d+ \d+\))$/i);
    expect(background).not.toMatch(/agent-color|\//);
  });
  it('the pill and its text fade together: the fade is on the pill itself', () => {
    expect(rule('.agent-cursor__say--leaving')).toMatch(/animation:\s*agent-cursor-say-out/);
    expect(css).not.toMatch(/\.agent-cursor__say[^{]*\{[^}]*\bcolor:[^;]*transparent/);
  });
});
