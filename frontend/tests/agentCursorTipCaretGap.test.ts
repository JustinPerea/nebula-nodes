import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_CURSOR_ARROW_PATH } from '../src/lib/agentCursorLook';

// GM: the tip caret sits 3 px clear of the arrow's white outline, or the two read as one
// "skip" glyph. Measured from the arrow's own path and stroke, so a new arrow shape or a
// wider outline can't quietly close the gap.
const css = readFileSync(resolve(__dirname, '../src/styles/agentCursor.css'), 'utf8');

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} rule`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf('}', at));
}

function px(block: string, property: string): number {
  const match = new RegExp(`(?:^|\\s)${property}:\\s*([\\d.]+)px`).exec(block);
  expect(match, `${property} in px`).not.toBeNull();
  return Number(match![1]);
}

describe('the tip caret', () => {
  it('starts 3 px clear of the arrow outline', () => {
    const xs = [...AGENT_CURSOR_ARROW_PATH.matchAll(/([\d.]+)\s+([\d.]+)/g)].map((m) => Number(m[1]));
    const stroke = Number(/stroke-width:\s*([\d.]+)/.exec(rule('.agent-cursor__arrow'))![1]);
    const outline = Math.max(...xs) + stroke / 2;
    const left = px(rule('.agent-cursor__tip-caret'), 'left');
    expect(left - outline).toBeGreaterThanOrEqual(3 - 1e-9);
    expect(left - outline).toBeLessThanOrEqual(3.5);
  });
});
