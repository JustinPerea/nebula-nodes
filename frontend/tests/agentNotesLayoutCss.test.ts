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

describe('the Updates corner off the canvas (Q107 a)', () => {
  it('reserves a header slot only while the chip shows', () => {
    expect(rule('.agent-notes-slot')).toMatch(/display:\s*none/);
    const shown = rule('body.agent-notes-shown .agent-notes-slot');
    expect(shown).toMatch(/width:\s*var\(--agent-notes-chip-w\)/);
  });

  // Review: a chat left open on the canvas stays mounted in the studios and
  // docked from the top gutter, under the chip's slot and the card's drop.
  it('starts a studio\'s docked chat below the line the corner drops from', () => {
    const body = rule('body.agent-notes-shown:not(.agent-notes-reserved) .workspace-overlays--studio .chat-panel');
    expect(body).toMatch(/--chat-dock-top:\s*var\(--agent-notes-drop-top,[^;]*var\(--agent-notes-chip-h\)/);
  });

  it('sits above the full-screen studios (their layer), below modals', () => {
    const body = rule('body.agent-notes-shown:not(.agent-notes-reserved) .agent-notes-chip,\nbody.agent-notes-shown:not(.agent-notes-reserved) .agent-note-card,\nbody.agent-notes-shown:not(.agent-notes-reserved) .agent-notes-panel');
    expect(body).toMatch(/z-index:\s*var\(--sr-layer-workspace-overlay, 55\)/);
  });
});

// Live check 2026-10-21 at 1280x800: the Commons toolbar filled its row, so
// the slot (a flex item) wrapped onto a second line and the chip landed over
// "Worker stopped / Start"; in Cinema, Remotion and the Video editor (no
// actions) the slot sat right after the title. The workspace header keeps the
// corner in its own right padding instead: its contents wrap inside the rest,
// and the slot is pinned to the top-right of the first row.
const header = readFileSync(join(__dirname, '../src/styles/workspace-header.css'), 'utf8');
function headerRule(selector: string): string {
  const start = header.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return header.slice(start, header.indexOf('}', start));
}

describe('the workspace header keeps the Updates corner (Q107 a)', () => {
  const reserved = 'body.app-slava-restraint.agent-notes-shown .workspace-header.workspace-header--updates-slot';

  it('names its gutter and column gap as tokens', () => {
    const base = headerRule('body.app-slava-restraint .workspace-header.workspace-header');
    expect(base).toMatch(/--workspace-header-pad-x:\s*14px/);
    expect(base).toMatch(/--workspace-header-gap-x:\s*16px/);
    expect(base).toMatch(/gap:\s*8px var\(--workspace-header-gap-x\)/);
    expect(base).toMatch(/padding:\s*8px var\(--workspace-header-pad-x\)/);
  });

  it('reserves the chip width in its right padding while the chip shows', () => {
    const body = headerRule(reserved);
    expect(body).toMatch(/position:\s*relative/);
    expect(body).toMatch(/padding-right:\s*calc\(var\(--workspace-header-pad-x\) \+ var\(--agent-notes-chip-w\) \+ var\(--workspace-header-gap-x\)\)/);
  });

  it('pins the slot to the first row, so it never wraps under the controls', () => {
    const body = headerRule(`${reserved} > .agent-notes-slot`);
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/top:\s*8px/);
    expect(body).toMatch(/right:\s*var\(--workspace-header-pad-x\)/);
  });
});
