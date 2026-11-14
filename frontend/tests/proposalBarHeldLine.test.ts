import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GM - Design, PR #212 round 6, ruling 3. On a tab that isn't connected as you
 * the proposal bar shows the person lock's line under its buttons. Measured
 * settled (the bar's rects held for 8 samples): the line's `flex-basis: 100%`
 * (personLock.css, a row wrapper's rule) took the card's column height, so the
 * scrolling note was squeezed to 14 px and drawn under the footer, and the line
 * sat at the bar's left edge, outside the 16 px content inset. jsdom runs no
 * layout, so the rules that decide both are read back from the stylesheet.
 */
const styles = (file: string) => readFileSync(join(__dirname, '../src/styles', file), 'utf8');
const css = styles('canvasProposals.css');
const rule = (selector: string): string => {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
};
const sides = (padding: string): { left: number; right: number } => {
  const [top, right = top, , left = right] = padding.trim().split(/\s+/).map((v) => Number.parseFloat(v));
  void top;
  return { left, right };
};
const padding = (body: string): string => /padding:\s*([^;]+);/.exec(body)![1];

describe('the proposal bar\'s person lock line', () => {
  const held = rule('.proposal-bar > .proposal-bar__held-line');

  it('takes its content height in the card\'s column, never the row wrapper\'s 100% basis', () => {
    expect(styles('personLock.css')).toMatch(/flex-basis:\s*100%/);   // the shared rule is a row wrapper's
    expect(held).toMatch(/flex:\s*0 0 auto/);                           // so the bar must override it,
    expect(held).toMatch(/margin:\s*-4px 0 0/);                         // and with one class more than it: the shared rule loads later
  });

  it('sits inside the content inset: the same 16 px a side as the header, the note and the footer', () => {
    const inset = sides(padding(held));
    expect(inset).toEqual({ left: 16, right: 16 });
    for (const part of ['.proposal-bar__head', '.proposal-bar__footer', '.proposal-bar__body']) {
      expect(sides(padding(rule(part))), part).toEqual(inset);
    }
    // No margin pushes it back out to the card's edge.
    expect(held).not.toMatch(/margin(-left|-right)?:\s*-\d+px\s+-?\d+px\s+-?\d+px\s+-/);
    expect(held).not.toMatch(/margin-(left|right)/);
  });

  it('closes the card with the footer\'s own bottom spacing', () => {
    expect(Number.parseFloat(padding(held).trim().split(/\s+/)[2])).toBe(12);
    expect(padding(rule('.proposal-bar__footer')).trim().split(/\s+/)[2]).toBe('12px');
  });
});
