import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * PR #233 review 1, C1: the launcher dot's idle dim (opacity 0.45, set inline
 * from JS) never showed in a browser: the fade-in animation ended at opacity 1
 * and, filling `both`, held that over the inline value (an animation beats a
 * non-!important inline style). jsdom reads only the inline style, so this
 * checks the stylesheet: the dot's fade-in must not fill forwards.
 */
const css = readFileSync(resolve(__dirname, '../src/styles/agentCursorAnywhere.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const blocks = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const rule = (selector: string) => blocks.find((block) => block.selector === selector)?.body ?? '';

describe('the launcher dot\'s fade-in cannot hold opacity over the idle dim', () => {
  it.each(['.agent-launcher-dot', '.agent-launcher-dot__more'])('%s fades in with fill-mode backwards (or none), never forwards or both', (selector) => {
    const animation = /animation:\s*([^;]+);/.exec(rule(selector))?.[1] ?? '';
    expect(animation).toMatch(/agent-item-outline-in/);
    expect(animation).not.toMatch(/\b(both|forwards)\b/);
  });

  it('the dot\'s opacity has no !important rule above its inline value, and the exit still holds its end (it is removed after)', () => {
    expect(css).not.toMatch(/\.agent-launcher-dot[^{]*\{[^}]*opacity:[^;}]*!important/);
    expect(rule('.agent-launcher-dot[data-leaving],\n.agent-launcher-dot__more[data-leaving]')).toMatch(/animation:\s*agent-launcher-dot-out[^;]*both/);
  });
});
