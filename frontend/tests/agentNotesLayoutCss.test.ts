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

// GM review of Q107 a (2026-10-21): at 1280 wide the Commons toolbar wrapped
// to two rows (86 px instead of main's 49) once the chip took its room: "treat
// the two-row wrap at 1280 as a defect". Below about 1360 px the chip shrinks
// to its author dots and the count, and the header reserves that compact
// width; above it, the full chip and its width. One token carries the width
// the slot and the header padding reserve. jsdom has no layout or media
// queries, so these pin the rules and resolve the token by hand; the live
// check measures them.
const notesCss = readFileSync(join(__dirname, '../src/components/agent-notes/agentNotes.css'), 'utf8');
const COMPACT = '(max-width: 1359px)';

/** The whole `@media <query> { ... }` block, braces balanced. */
function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media ${query} {`);
  expect(start, `missing @media ${query}`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = css.indexOf('{', start); i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && --depth === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unbalanced @media ${query}`);
}

function ruleIn(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

function declared(body: string, name: string): string | null {
  const match = body.match(new RegExp(`${name}:\\s*([^;]+);`));
  return match ? match[1].trim() : null;
}

/** The px width `--agent-notes-chip-w` resolves to at a window width. */
function reservedAt(viewport: number): number {
  const root = ruleIn(layouts, ':root');
  const max = Number(COMPACT.match(/max-width:\s*(\d+)px/)![1]);
  const value = viewport <= max
    ? declared(ruleIn(mediaBlock(layouts, COMPACT), ':root'), '--agent-notes-chip-w')
    : declared(root, '--agent-notes-chip-w');
  const name = value?.match(/^var\((--[\w-]+)\)$/)?.[1];
  const px = declared(root, name ?? '--none');
  expect(px, `--agent-notes-chip-w at ${viewport}px`).toMatch(/^\d+px$/);
  return parseFloat(px!);
}

describe('the compact Updates chip below about 1360 px (GM review of Q107 a)', () => {
  it('names the chip\'s full and compact widths as tokens, the full one by default', () => {
    const root = ruleIn(layouts, ':root');
    // Measured live (2026-10-21, p157: the count as plain figures after a 4 px
    // gap): the dots 38 + gap 8 + "Updates" 52 + gap 8 + the count 4 + 7, plus padding and border.
    expect(declared(root, '--agent-notes-chip-w-full')).toBe('134px');
    // Without the word: dots 38 + gap 8 + count 4 + 7 + padding 15 + border 2.
    expect(declared(root, '--agent-notes-chip-w-compact')).toBe('74px');
    expect(declared(root, '--agent-notes-chip-w')).toBe('var(--agent-notes-chip-w-full)');
  });

  it('reserves the compact width below the breakpoint and the full width above it', () => {
    expect(reservedAt(1280)).toBe(74);
    expect(reservedAt(1359)).toBe(74);
    expect(reservedAt(1366)).toBe(134);
    expect(reservedAt(1440)).toBe(134);
    expect(reservedAt(1920)).toBe(134);
    // Both the slot and the header's right padding read that one token.
    expect(rule('body.agent-notes-shown .agent-notes-slot')).toMatch(/width:\s*var\(--agent-notes-chip-w\)/);
    expect(headerRule('body.app-slava-restraint.agent-notes-shown .workspace-header.workspace-header--updates-slot'))
      .toMatch(/padding-right:\s*calc\(var\(--workspace-header-pad-x\) \+ var\(--agent-notes-chip-w\) \+ var\(--workspace-header-gap-x\)\)/);
  });

  it('drops the word "Updates" at the same breakpoint, keeping the dots, the count and the hit target', () => {
    const compact = mediaBlock(notesCss, COMPACT);
    expect(ruleIn(compact, '.agent-notes-chip__label')).toMatch(/display:\s*none/);
    // Nothing else of the chip changes there: dots, count, height and padding stay.
    expect(compact).not.toMatch(/agent-notes-chip__dots|agent-notes-chip__count|agent-notes-dot/);
    expect(compact).not.toMatch(/\.agent-notes-chip\s*[,{][^}]*(height|padding)/);
    expect(ruleIn(notesCss, '.agent-notes-chip')).toMatch(/height:\s*var\(--agent-notes-chip-h, 40px\)/);
  });
});

// GM review of p157 (the 1280 shots): "the '1' is a lime circle the same size
// and colour as the 'C' author dot. At a glance the chip reads as three
// people, not two people and one unread. Give the count its own form ... It
// should not share the author-dot palette. ... A 1px ring in the chip's
// background colour around each dot would separate them."
describe('the chip\'s count and dots read apart (GM review of p157)', () => {
  it('gives the count its own form: no author colour, no dot-sized circle, a clear gap after the dots', () => {
    const count = ruleIn(notesCss, '.agent-notes-chip__count');
    // Not the author-dot palette: neither the newest author's colour nor a dot's.
    expect(count).not.toMatch(/--an-newest|--an-dot|--an-on-dot/);
    // Not a filled circle: no fill, no round corners.
    expect(count).not.toMatch(/border-radius/);
    expect(count).not.toMatch(/background(-color)?:\s*(?!transparent|none)/);
    // Its colour is the chip's own ink, and it keeps the mono figures.
    expect(declared(count, 'color')).toBe('var(--an-ink-bold)');
    expect(count).toMatch(/font-variant-numeric:\s*tabular-nums/);
    // A clear gap after the dots, beyond the chip's own 8 px item gap.
    expect(parseFloat(declared(count, 'margin-left') ?? '0')).toBeGreaterThanOrEqual(4);
    // Nothing for "unread" puts it back on a circle or the author's colour.
    const muted = ruleIn(notesCss, ".agent-notes-chip__count[data-muted='true']");
    expect(muted).not.toMatch(/--an-newest|--an-dot|border-radius|box-shadow/);
  });

  it('rings each dot in the chip with 1 px of the chip\'s background, so overlapping dots separate', () => {
    const dots = ruleIn(notesCss, '.agent-notes-chip__dots .agent-notes-dot');
    expect(dots).toMatch(/box-shadow:\s*0 0 0 1px var\(--an-raised\)/);
    // The ring is on every dot, not only the second.
    expect(notesCss).not.toContain('.agent-notes-chip__dots .agent-notes-dot + .agent-notes-dot {\n  margin-left: -6px;\n  box-shadow');
    // A dimmed dot stays opaque, so the dot under it doesn't show through it and its ring.
    expect(ruleIn(notesCss, ".agent-notes-dot[data-lit='false']")).not.toMatch(/opacity/);
  });
});

// The Commons toolbar still wrapped at 1280 with the compact chip (it needs
// 1346 px then, main's 1245): its two least-used sections fold into a More
// menu while the chip shows, below the width where the full chip still fits
// it (1406 px measured, so below 1440).
const commonsCss = readFileSync(join(__dirname, '../src/styles/commons.css'), 'utf8');
const COMMONS_FOLD = '(max-width: 1439px)';

describe('the Commons toolbar keeps one row with the chip (GM review of Q107 a)', () => {
  it('hides the More button unless the toolbar folds', () => {
    expect(ruleIn(commonsCss, 'body.app-slava-restraint .commons-tabs__more')).toMatch(/display:\s*none/);
  });

  it('folds Blind labeling and Settings into More while the chip shows, below 1440', () => {
    const fold = mediaBlock(commonsCss, COMMONS_FOLD);
    expect(ruleIn(fold, 'body.app-slava-restraint.agent-notes-shown .commons-tab--overflow:not(.commons-tab--active)')).toMatch(/display:\s*none/);
    expect(ruleIn(fold, 'body.app-slava-restraint.agent-notes-shown .commons-tabs__more')).toMatch(/display:\s*inline-flex/);
  });

  // Review of the fold: display:none on the open folded tab took it out of the
  // accessibility tree, so the tablist had no selected tab. It stays in the
  // tree, hidden on screen (and out of the Tab order, CommonsView).
  it('keeps the open folded tab in the accessibility tree, hidden only on screen', () => {
    const fold = mediaBlock(commonsCss, COMMONS_FOLD);
    expect(fold).not.toContain('body.app-slava-restraint.agent-notes-shown .commons-tab--overflow {');
    const open = ruleIn(fold, 'body.app-slava-restraint.agent-notes-shown .commons-tab--overflow.commons-tab--active');
    expect(open).not.toMatch(/display:\s*none|visibility:\s*hidden/);
    expect(open).toMatch(/position:\s*absolute/);
    expect(open).toMatch(/width:\s*1px/);
    expect(open).toMatch(/height:\s*1px/);
    expect(open).toMatch(/overflow:\s*hidden/);
    expect(open).toMatch(/clip-path:\s*inset\(50%\)/);
  });
});

// Review of the fold: More's menu drew its two items the same, so a sighted
// person could not see which folded section was open. A checked radio item
// carries a visible mark; the Move menu (no `checked`) stays plain.
const assetMoveCss = readFileSync(join(__dirname, '../src/styles/asset-move.css'), 'utf8');

describe('the toolbar menu marks its checked item', () => {
  it('draws a check before a checked radio item and leaves room for it', () => {
    expect(ruleIn(assetMoveCss, '.asset-move__item[role="menuitemradio"]')).toMatch(/padding-left:\s*24px/);
    expect(ruleIn(assetMoveCss, '.asset-move__item[role="menuitemradio"]')).toMatch(/position:\s*relative/);
    const mark = ruleIn(assetMoveCss, '.asset-move__item[aria-checked="true"]::before');
    expect(mark).toMatch(/content:\s*"\u2713"/);
    expect(mark).toMatch(/position:\s*absolute/);
    expect(ruleIn(assetMoveCss, '.asset-move__item[aria-checked="true"]')).toMatch(/font-weight:\s*600/);
  });
});
