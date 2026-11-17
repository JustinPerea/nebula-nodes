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

const SRC = join(__dirname, '..', 'src');
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : /\.css$/.test(name) ? [path] : [];
});

/** Left for design: a selector (a substring of the rule's selector list) in a file, and why it may carry a bar. */
const ALLOWED: Array<{ file: string; selector: string; why: string }> = [
  { file: 'styles/asset-proposals.css', selector: '.asset-proposal', why: 'an agent proposal card: carries the proposing agent\'s colour (design)' },
  { file: 'styles/canvasProposals.css', selector: '.proposal-bar', why: 'a canvas proposal bar: carries the proposing agent\'s colour (design)' },
  { file: 'styles/panels.css', selector: '.chat__bubble--assistant', why: 'an agent\'s chat message in the older chat theme: the chat accent colour (design)' },
  { file: 'components/agent-notes/agentNotes.css', selector: '.agent-notes-entry', why: 'an agent note: the author agent\'s colour (design)' },
  { file: 'components/agent-notes/agentNotes.css', selector: '.agent-questions-form__head', why: 'an agent\'s question form header: the author agent\'s colour (design)' },
  { file: 'components/agent-notes/agentNotes.css', selector: '.agent-note-card', why: 'an agent note card about a run: the author agent\'s colour (design)' },
  { file: 'styles/panels.css', selector: '.chat-panel__resize-handle', why: 'the resize handle\'s corner glyph: an L-shaped mark, not a bar' },
  { file: 'styles/personal-agents.css', selector: '.chat__plan', why: 'an agent\'s plan in a chat message: a quote of the agent\'s words (design)' },
  { file: 'styles/commons.css', selector: '.commons-comment', why: 'a comment quoted in the reference detail: someone\'s words (design)' },
  { file: 'styles/moodboard-studio.css', selector: '.moodboard-advanced__toggle::before', why: 'a CSS triangle (the disclosure arrow), not a bar' },
];

interface Hit { file: string; selector: string; decl: string }

/** px width of a border-left value, or Infinity when it can't be read (a var(), calc()): that is a bar until proven otherwise. */
function width(value: string): number {
  const v = value.trim().replace(/!important$/, '').trim();
  if (/^(none|0|initial|unset|inherit)\b/.test(v)) return 0;
  if (/^(thin)\b/.test(v)) return 1;
  if (/^(medium|thick)\b/.test(v)) return 3;
  const px = v.match(/^(-?\d*\.?\d+)px\b/);
  if (px) return Number(px[1]);
  const em = v.match(/^(-?\d*\.?\d+)(?:r?em)\b/);
  if (em) return Number(em[1]) * 16;
  // A colour-only or style-only change (border-left-color, `solid …`) has no width of its own.
  if (/^(solid|dashed|dotted|double|currentcolor|#|rgb|hsl|var\(--[\w-]*(?:color|edge|line)[\w-]*)/i.test(v)) return 1;
  return Infinity;
}

export function findBars(file: string, source: string): Hit[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const hits: Hit[] = [];
  for (const rule of text.matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim().replace(/\s+/g, ' ');
    for (const decl of rule[2].split(';')) {
      const m = decl.match(/^\s*(border-left|border-inline-start|border-left-width|border-inline-start-width)\s*:\s*(.+?)\s*$/s);
      if (m && width(m[2]) > 1) hits.push({ file, selector, decl: decl.trim().replace(/\s+/g, ' ') });
      const s = decl.match(/^\s*box-shadow\s*:\s*(.+)$/s);
      if (s) {
        // `inset <x> <y> ...`: a horizontal offset of 2px or more (a bar on the left), with no vertical one.
        for (const shadow of s[1].split(/,(?![^(]*\))/)) {
          const inset = shadow.trim().match(/^inset\s+(-?\d*\.?\d+)(?:px)?\s+(-?\d*\.?\d+)(?:px)?\b/);
          if (inset && Math.abs(Number(inset[1])) >= 2 && Number(inset[2]) === 0) hits.push({ file, selector, decl: decl.trim().replace(/\s+/g, ' ') });
        }
      }
    }
  }
  return hits;
}

const allowed = (hit: Hit) => ALLOWED.some((entry) => entry.file === hit.file && hit.selector.includes(entry.selector));

describe('design: no accent bar down the left edge', () => {
  it('no stylesheet draws a left border thicker than 1px, or an inset left shadow, except the allow-list', () => {
    const all = files(SRC).flatMap((path) => findBars(relative(SRC, path), readFileSync(path, 'utf8')));
    expect(all.filter((hit) => !allowed(hit)).map((hit) => `${hit.file}: ${hit.selector} { ${hit.decl} }`)).toEqual([]);
  });

  it('every allow-list entry still matches a rule, so a fixed one leaves the list', () => {
    const all = files(SRC).flatMap((path) => findBars(relative(SRC, path), readFileSync(path, 'utf8')));
    const stale = ALLOWED.filter((entry) => !all.some((hit) => hit.file === entry.file && hit.selector.includes(entry.selector)));
    expect(stale.map((entry) => `${entry.file}: ${entry.selector}`)).toEqual([]);
  });

  it('the scan sees the bars it is meant to catch', () => {
    const probe = (css: string) => findBars('x.css', css).length;
    expect(probe('.a { border-left: 2px solid red; }')).toBe(1);
    expect(probe('.a { border-left: var(--w) solid red; }')).toBe(1);
    expect(probe('.a { border-left-width: 3px; }')).toBe(1);
    expect(probe('.a { box-shadow: inset 3px 0 0 var(--c); }')).toBe(1);
    expect(probe('.a { border-left: 1px solid red; }')).toBe(0);
    expect(probe('.a { border-left-color: red; }')).toBe(0);
    expect(probe('.a { box-shadow: inset 0 0 0 1px red; }')).toBe(0);
    expect(probe('.a { border-left: none; }')).toBe(0);
  });
});
