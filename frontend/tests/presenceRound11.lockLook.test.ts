/**
 * PR #204 round 11 (review 9 MEDIUM-1, GM r19 item 1): a person lock's control takes the one
 * disabled look through the helper (data-person-lock), not a class list: styles/disabled-buttons.css
 * holds one rule per kind of element (lib/lockPlacement LOCK_LOOK_SELECTORS), each with no hover or
 * press, a select or input keeping its value in --disabled-label, a switch the 0.06 edge and a
 * --disabled-label knob. lockPlacementProblems fails a locked element no rule covers; the live
 * check computes the look in Chrome.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCK_LOOK_SELECTORS, lockPlacementProblems } from '../src/lib/lockPlacement';

const css = readFileSync(join(__dirname, '../src/styles/disabled-buttons.css'), 'utf8');
const rule = (selector: string) => {
  const at = css.indexOf(`${selector},\n${selector}:is(:hover, :active, :focus)`);
  return at < 0 ? null : css.slice(at, css.indexOf('}', at));
};

describe('a locked control looks locked (PR #204 round 11)', () => {
  it('each lock look rule is in the sheet, held through hover, press and focus', () => {
    for (const selector of LOCK_LOOK_SELECTORS) expect(rule(selector), selector).not.toBeNull();
  });

  it('buttons: the shared grey label and edge, no fill, no press, the default cursor', () => {
    const body = rule(LOCK_LOOK_SELECTORS[0])!;
    for (const want of ['color: var(--disabled-label', 'border-color: var(--sr-disabled-edge', 'background: transparent', 'transform: none', 'cursor: default']) {
      expect(body).toContain(want);
    }
  });

  it('a select or input keeps its value, in --disabled-label; a switch takes the 0.06 edge and a grey knob', () => {
    const field = rule(LOCK_LOOK_SELECTORS[1])!;
    expect(field).toContain('color: var(--disabled-label');
    expect(field).not.toMatch(/color:\s*transparent|visibility|opacity:\s*0[;\s]/);
    expect(rule(LOCK_LOOK_SELECTORS[2])).toContain('var(--sr-disabled-edge, rgba(255, 255, 255, 0.06))');
    expect(css).toContain("input[type='checkbox'][data-person-lock]:not([data-held-pending])::before {\n  background: var(--disabled-label");
    // On stays readable: a checked lock keeps a fill, never the accent.
    expect(css).toMatch(/input\[type='checkbox'\]\[data-person-lock\]:not\(\[data-held-pending\]\):checked \{\n {2}background: var\(--sr-disabled-fill/);
  });

  it('a locked element no rule covers fails the shared check', () => {
    document.body.innerHTML = `<p id="l" class="person-lock-line" data-lock-place="control">x</p>
      <div role="slider" data-person-lock="change this" aria-describedby="l"></div>`;
    expect(lockPlacementProblems(document).join('\n')).toMatch(/no lock look covers a <div>/);
    document.body.innerHTML = '';
  });
});
