// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A Commons grid tile is a <button>, and a button keeps the browser's own control font. Its badges and
 * caption inherit that font (design: Arial in the audit) unless the tile sets one. The tile rule takes
 * the app font with `font: inherit`; the badge sets no font-family of its own (inherited, so a
 * `font-family: inherit` there changes nothing).
 */
const css = readFileSync(resolve(__dirname, '../src/styles/commons.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function declarations(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  expect(match, selector).not.toBeNull();
  return match![1].split(';').map((d) => d.trim()).filter(Boolean);
}

describe('Commons grid tile font', () => {
  it('the tile button sets font: inherit (or a font-family), so its badges and caption leave the button font', () => {
    const decls = declarations('body.app-slava-restraint .commons-tile');
    expect(decls.some((d) => /^font\s*:\s*inherit$/.test(d) || /^font-family\s*:/.test(d))).toBe(true);
  });

  it('the badge carries no no-op font-family: inherit', () => {
    const decls = declarations('body.app-slava-restraint .commons-badge');
    expect(decls.filter((d) => /^font-family\s*:\s*inherit$/.test(d))).toEqual([]);
  });
});
