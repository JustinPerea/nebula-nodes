/**
 * PR #204 round 13, GM r21 1: in the Commons' line row (components/commons/CommonsPageLines),
 * Add's lock line starts where the because line's words start, not at its rail, and at the same
 * x when it stands alone. The x comes from one measure: the line's rail and padding are tokens,
 * and the lock line's inset is their sum, so the two can't drift apart. The live check measures
 * both left edges in a real browser at 1280 and 1440, with the because line and alone.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '../src/styles/commons.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  expect(match, selector).not.toBeNull();
  const body = match![1];
  return Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
    const at = d.indexOf(':');
    return [d.slice(0, at).trim(), d.slice(at + 1).trim()];
  }));
}

describe('Add\'s lock line lines up with the because line\'s words (GM r21 1)', () => {
  it('the line\'s rail and padding are the shared tokens, and the words\' inset is their sum', () => {
    const tokens = rule('body.app-slava-restraint');
    expect(tokens['--commons-line-text-x']).toBe('calc(var(--commons-line-rail) + var(--commons-line-pad-x))');
    const line = rule('body.app-slava-restraint .commons-notice');
    expect(line['border-left']).toBe('var(--commons-line-rail) solid currentColor');
    expect(line.padding).toBe('6px var(--commons-line-pad-x)');
  });

  it('the lock line in the row starts at that inset, with or without the because line', () => {
    const lock = rule('body.app-slava-restraint .commons-messages__lock-line');
    expect(lock['padding-left']).toBe('var(--commons-line-text-x)');
    expect(lock.margin).toBe('0');
    // Nothing else moves it sideways: no other rule for it sets a left offset.
    const others = [...css.matchAll(/([^{}]*\.commons-messages__lock-line[^{}]*)\{([^}]*)\}/g)]
      .filter(([, , body]) => /(?:^|;|\s)(?:padding|padding-left|margin|margin-left|left|inset|text-indent)\s*:/.test(body))
      .map(([, selector]) => selector.trim());
    expect(others).toEqual(['body.app-slava-restraint .commons-messages__lock-line']);
  });
});
