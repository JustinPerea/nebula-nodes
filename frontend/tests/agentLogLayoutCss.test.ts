import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Review (2026-10-20): with the Agent log shown by default (Q38), the
// collapsed log sat on the minimap's bottom 40 px, and at 1280 px wide on
// the right end of the proposal bar (its Accept button). jsdom has no
// layout, so these pin the reservation rules; the live check measures them.
const layouts = readFileSync(join(__dirname, '../src/styles/layouts.css'), 'utf8');

function rule(selector: string): string {
  const start = layouts.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return layouts.slice(start, layouts.indexOf('}', start));
}

describe('the right column keeps clear of the Agent log', () => {
  it('lifts the minimap above the log while the log holds its spot', () => {
    const body = rule('body.agent-log-reserved .canvas-navigation.react-flow__panel');
    expect(body).toMatch(/bottom:[^;]*var\(--agent-log-h\)/);
  });

  it('keeps the proposal bar out of the log\'s column', () => {
    const body = rule('body.agent-log-reserved .proposal-bar');
    expect(body).toMatch(/--col-right-w/);
    expect(body).toMatch(/translate:/);
  });
});
