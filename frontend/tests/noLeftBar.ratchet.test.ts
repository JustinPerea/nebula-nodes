/**
 * Design: no accent bar down the left edge of a callout, note, quote, card or the current item of
 * a list (a thick `border-left`, or an inset shadow that paints one). A notice, warning, failure
 * line or status line is a fill: neutral for a neutral line, the warning tint for a warning line.
 * A 1px divider or a tree's guide line is fine.
 *
 * This scans every stylesheet under src for a `border-left` (or `border-inline-start`) thicker
 * than 1px, and for an inset shadow with a horizontal offset (a bar painted inside the box). A
 * match must be on ALLOWED, each with what it is. A new bar fails here; the fix is a fill, or a
 * decision from design to add it to the list.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collectVars, declIsBar, type Vars } from './helpers/leftBarReader';

const SRC = join(__dirname, '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.css$/.test(name) ? [path] : [];
});

/** Kept by design: a bar that carries who or what (an agent's colour, a quoted comment), not an accent. Allowed by its file, the rule's exact selector list and the declaration, and why it may carry one. */
type Allowed = { file: string; selector: string; decl: string; why: string };
const ALLOWED: Allowed[] = [
  { file: 'components/agent-notes/agentNotes.css', selector: '.agent-notes-entry', decl: 'box-shadow: inset 4px 0 0 color-mix(in srgb, var(--an-author) 70%, transparent)',
    why: 'an agent note: the author agent\'s colour (design keeps it: it carries who or what, not an accent)' },
  { file: 'components/agent-notes/agentNotes.css', selector: '.agent-notes-entry[data-state=\'done\']', decl: 'box-shadow: inset 4px 0 0 color-mix(in srgb, var(--an-author) 30%, transparent)',
    why: 'an agent note: the author agent\'s colour (design keeps it: it carries who or what, not an accent)' },
  { file: 'components/agent-notes/agentNotes.css', selector: '.agent-questions-form__head', decl: 'box-shadow: inset 4px 0 0 color-mix(in srgb, var(--an-author) 70%, transparent)',
    why: 'an agent\'s question form header: the author agent\'s colour (design keeps it: it carries who or what, not an accent)' },
  { file: 'components/agent-notes/agentNotes.css', selector: '.agent-note-card[data-about=\'run\']', decl: 'box-shadow: var(--an-shadow), inset 4px 0 0 color-mix(in srgb, var(--an-author) 70%, transparent)',
    why: 'an agent note card about a run: the author agent\'s colour (design keeps it: it carries who or what, not an accent)' },
  { file: 'styles/asset-proposals.css', selector: '.asset-proposal', decl: 'border-left: 3px solid var(--agent-color)',
    why: 'an agent proposal card: carries the proposing agent\'s colour (design keeps it: it carries who or what, not an accent)' },
  { file: 'styles/canvasProposals.css', selector: '.proposal-bar', decl: 'border-left: 3px solid var(--agent-color)',
    why: 'a canvas proposal bar: carries the proposing agent\'s colour (design keeps it: it carries who or what, not an accent)' },
  { file: 'styles/commons.css', selector: 'body.app-slava-restraint .commons-comment', decl: 'border-left: 2px solid var(--sr-edge-strong)',
    why: 'a comment quoted in the reference detail: someone\'s words (design keeps it: it carries who or what, not an accent)' },
  { file: 'styles/moodboard-studio.css', selector: 'body.app-slava-restraint .moodboard-advanced__toggle::before', decl: 'border-left: 4px solid currentColor',
    why: 'a CSS triangle (the disclosure arrow), not a bar' },
  { file: 'styles/panels.css', selector: '.chat-panel__resize-handle--tl::before', decl: 'border-left-width: 2px',
    why: 'the resize handle\'s corner glyph: an L-shaped mark, not a bar' },
  { file: 'styles/panels.css', selector: '.chat-panel__resize-handle--bl::before', decl: 'border-left-width: 2px',
    why: 'the resize handle\'s corner glyph: an L-shaped mark, not a bar' },
  { file: 'styles/panels.css', selector: '.chat-panel__resize-handle--corner::before', decl: 'border-left: 2px solid',
    why: 'the resize handle\'s corner glyph: an L-shaped mark, not a bar' },
  { file: 'styles/panels.css', selector: 'body:not(.app-slava-restraint) .chat__bubble--assistant', decl: 'border-left: 3px solid var(--chat-accent)',
    why: 'an agent\'s chat message in the older chat theme: the chat accent colour (design keeps it: it carries who or what, not an accent)' },
  { file: 'styles/personal-agents.css', selector: '.chat__plan', decl: 'border-left: 2px solid var(--sr-edge-strong, #444)',
    why: 'an agent\'s plan in a chat message: a quote of the agent\'s words (design keeps it: it carries who or what, not an accent)' },
];

interface Hit { file: string; selector: string; decl: string }

export function findBars(file: string, source: string, vars?: Vars): Hit[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const hits: Hit[] = [];
  for (const rule of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, ' ');
    for (const decl of rule[2].split(';')) {
      const m = decl.match(/^\s*([\w-]+)\s*:\s*(.+?)\s*$/s);
      if (m && declIsBar(m[1], m[2], vars)) hits.push({ file, selector, decl: decl.trim().replace(/\s+/g, ' ') });
    }
  }
  return hits;
}

const sheets = () => files(SRC).map((path) => ({ file: relative(SRC, path), source: readFileSync(path, 'utf8') }));
const scanTree = () => {
  const all = sheets();
  const vars = collectVars(all.map((sheet) => sheet.source));
  return all.flatMap((sheet) => findBars(sheet.file, sheet.source, vars));
};
/** An allowed bar is exact: the file, the rule's whole selector list and the declaration. */
const same = (entry: Allowed, hit: Hit) => entry.file === hit.file && entry.selector === hit.selector && entry.decl === hit.decl;
const allowed = (hit: Hit) => ALLOWED.some((entry) => same(entry, hit));

describe('design: no accent bar down the left edge', () => {
  it('no stylesheet draws a left border thicker than 1px, or an inset left shadow, except the allow-list', () => {
    expect(scanTree().filter((hit) => !allowed(hit)).map((hit) => `${hit.file}: ${hit.selector} { ${hit.decl} }`)).toEqual([]);
  });

  it('every allow-list entry still matches a rule and declaration, so a fixed or changed one leaves the list', () => {
    const all = scanTree();
    const stale = ALLOWED.filter((entry) => !all.some((hit) => same(entry, hit)));
    expect(stale.map((entry) => `${entry.file}: ${entry.selector} { ${entry.decl} }`)).toEqual([]);
  });

  it('an allowed entry is exact: another rule in the file, or another bar in the rule, is not allowed', () => {
    const entry = ALLOWED[0];
    const hit: Hit = { file: entry.file, selector: entry.selector, decl: entry.decl };
    expect(allowed(hit)).toBe(true);
    expect(allowed({ ...hit, selector: `${entry.selector}__error` })).toBe(false);
    expect(allowed({ ...hit, selector: `${entry.selector}, .other` })).toBe(false);
    expect(allowed({ ...hit, decl: 'border-left: 3px solid red' })).toBe(false);
    expect(allowed({ ...hit, decl: 'box-shadow: inset 3px 0 0 red' })).toBe(false);
  });

  it('the scan sees the bars it is meant to catch', () => {
    const probe = (css: string, vars?: Vars) => findBars('x.css', css, vars).length;
    const caught = [
      '.a { border-left: 2px solid red; }',
      '.a { border-left: var(--w) solid red; }',
      '.a { border-left-width: 3px; }',
      '.a { box-shadow: inset 3px 0 0 var(--c); }',
      '.a { border-left: var(--commons-line-rail) solid currentColor; }',
      '.a { border-left: var(--line-width) solid red; }',
      '.a { border-left-width: var(--sr-edge-w); }',
      '.a { border-left-width: var(--x); }',
      '.a { border-left: 0.25rem solid red; }',
      '.a { border-left: solid 2px red; }',
      '.a { border-left: thick solid; }',
      '.a { border-left: solid var(--edge); }',
      '.a { border-left: calc(1px + 1px) solid red; }',
      '.a { border-inline-start: 2px solid red; }',
      '.a { border-inline-start-width: 4px; }',
      '.a { border-style: solid; border-width: 0 0 0 4px; }',
      '.a { border-width: 0 4px; }',
      '.a { border-width: 0 0 0 var(--x); }',
      '.a { box-shadow: 3px 0 0 red inset; }',
      '.a { box-shadow: 0 0 0 1px red, 3px 0 0 red inset; }',
      '.a { box-shadow: -3px 0 0 0 rgb(1 2 3 / 0.5) inset; }',
    ];
    for (const css of caught) expect(probe(css), css).toBe(1);
    const missed = [
      '.a { border-left: 1px solid red; }',
      '.a { border-left: 1px solid var(--edge); }',
      '.a { border-left: 0 solid; }',
      '.a { border-left: 0.0625rem solid red; }',
      '.a { border-left: none; }',
      '.a { border-left-color: red; }',
      '.a { border-left-color: var(--x); }',
      '.a { border-left-width: 1px; }',
      '.a { border-width: 1px; }',
      '.a { border-width: 4px; }',
      '.a { border-width: 0 0 1px; }',
      '.a { border-width: 1px 0 0 0; }',
      '.a { box-shadow: 0 3px 0 red inset; }',
      '.a { box-shadow: inset 0 0 0 1px red; }',
      '.a { box-shadow: 3px 0 0 red; }',
      '.a { box-shadow: var(--x); }',
    ];
    for (const css of missed) expect(probe(css), css).toBe(0);
  });

  it('a box-shadow that names a custom property is a bar only when that property is an inset left shadow', () => {
    const css = '.a { box-shadow: var(--bar); } .b { box-shadow: var(--ring), 0 0 4px red; }';
    expect(findBars('x.css', css, collectVars(['.r { --bar: inset 3px 0 0 red; }', ':root { --ring: 0 0 0 1px red; }'])).map((hit) => hit.selector)).toEqual(['.a']);
    expect(findBars('x.css', css, collectVars([':root { --bar: 0 3px 0 red inset; --ring: inset 4px 0 0 red; }'])).map((hit) => hit.selector)).toEqual(['.b']);
  });
});
