// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { appRules, resolvedStyle } from './helpers/cssCascade';

// Design: a search field that sits bare inside a visible box (a shell) never draws
// its own ring or native box. The shell takes the focus ring, so the ring follows
// the shell's shape. A field that is itself the box is not listed here.
const SHELLS: Array<{ shell: string; name: string }> = [
  { shell: 'model-picker__search', name: 'model picker' },
  { shell: 'preset-library__search', name: 'styles (presets)' },
  { shell: 'settings-search', name: 'settings' },
  { shell: 'project-home__search', name: 'project home' },
];

function build(shell: string): { shellEl: HTMLElement; input: HTMLInputElement } {
  document.body.className = 'app-slava-restraint';
  document.body.innerHTML = `<div class="model-picker"><div class="${shell}"><input type="text" /></div></div>`;
  return { shellEl: document.querySelector(`.${shell}`) as HTMLElement, input: document.querySelector('input') as HTMLInputElement };
}

describe('search shells carry the focus ring', () => {
  for (const { shell, name } of SHELLS) {
    it(`${name}: the input draws no ring and the shell does`, () => {
      const { input } = build(shell);
      const own = resolvedStyle(input)[':focus-visible|outline'];
      expect(own === undefined || /^(none|0)\b/.test(own), `${name} input ring: ${own}`).toBe(true);
      // The base rule clears the outline too, so a click or a later rule can't paint a native box.
      expect(resolvedStyle(input)['|outline'], `${name} input outline at rest`).toMatch(/^none\b/);
      const rules = appRules().filter((r) => r.base.includes(`.${shell}`) && r.decls.some((d) => d.prop === 'outline'));
      const ring = rules.filter((r) => /:has\(\s*input:focus-visible\s*\)|:focus-within/.test(r.selector)
        && r.decls.some((d) => d.prop === 'outline' && d.value.includes('--sr-focus-outline')));
      expect(ring.length, `${name} shell has no ring rule`).toBeGreaterThan(0);
    });
  }
});
