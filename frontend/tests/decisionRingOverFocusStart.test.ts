import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// jsdom can't compute the cascade for :focus-visible, so this asserts the selector
// relationship in the real stylesheet: the rule that strips the ring from a
// focus-start element (lib/noticeLeave) must not match an element that also carries
// the keyboard decision mark (ProposalBar), whose ring rule is lower in specificity
// than that !important rule. Before the fix both marks on the canvas meant no ring.
const css = readFileSync(join(__dirname, '../src/styles/slava-restraint.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function ruleSelectors(needle: string): string[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => m[1].includes(needle))
    .flatMap((m) => m[1].split(',').map((s) => s.trim()));
}

// The element-matching part: drop the :focus-visible / :focus state, which jsdom can't set.
const structural = (sel: string) => sel.replace(/^body\.app-slava-restraint\s+/, '').replace(/:focus(-visible)?/g, '');

describe('the keyboard decision ring wins over the focus-start rule', () => {
  const stripRules = ruleSelectors('[data-focus-start]');

  it('has a focus-start rule that strips the ring', () => {
    expect(stripRules.length).toBeGreaterThan(0);
  });

  it('does not match an element carrying both marks', () => {
    document.body.innerHTML = '<div class="canvas-wrapper" data-focus-start data-focus-decided></div>';
    const el = document.querySelector('.canvas-wrapper')!;
    for (const sel of stripRules) expect(el.matches(structural(sel)), sel).toBe(false);
  });

  it('still matches a focus-start element with no decision mark', () => {
    document.body.innerHTML = '<div class="canvas-wrapper" data-focus-start></div>';
    const el = document.querySelector('.canvas-wrapper')!;
    expect(stripRules.some((sel) => el.matches(structural(sel)))).toBe(true);
  });
});
