import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// PR9a live check (2026-10-20): at 1440x900 the docked chat reached 16 px
// from the top, so the Updates chip moved left of it and onto the header
// pill. The chip holds the top-right corner instead, and the docked chat
// starts below it. jsdom has no layout, so this pins the rules; the live
// check measures them.
const layouts = readFileSync(join(__dirname, '../src/styles/layouts.css'), 'utf8');

function rule(selector: string): string {
  const start = layouts.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return layouts.slice(start, layouts.indexOf('}', start));
}

describe('the Updates chip keeps the top-right corner', () => {
  it('sizes the docked chat from a top it can move', () => {
    const body = rule('.chat-panel');
    expect(body).toMatch(/--chat-dock-top:\s*var\(--page-gutter\)/);
    expect(body).toMatch(/height:[\s\S]*100vh - var\(--chat-dock-top\) - var\(--chat-panel-bottom\)/);
  });

  it('starts the docked chat below the chip while the chip is there', () => {
    const body = rule('body.agent-notes-reserved .chat-panel');
    expect(body).toMatch(/--chat-dock-top:[^;]*var\(--agent-notes-chip-top\)[^;]*var\(--agent-notes-chip-h\)/);
  });
});
