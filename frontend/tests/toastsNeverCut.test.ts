import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GM (#198 r8, and #199 r8 for the saved toast): "Toasts wrap to 3 lines and
 * never cut a sentence", app-wide. PR #198's no-cut sweep, here too, so the
 * rule holds wherever toasts live on this branch.
 */
describe('no toast cuts a sentence', () => {
  // Every stylesheet; a toast or notice's text never sits on one line with an
  // ellipsis, so it wraps instead of cutting. A toast's buttons (its action,
  // "Back to …", ×) keep their own one-line rules.
  const root = join(__dirname, '../src');
  const files: string[] = [];
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path); else if (name.endsWith('.css')) files.push(path); } };
  walk(root);
  const rules = files.flatMap((file) => {
    const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ file: file.slice(root.length + 1), selector: selector.trim(), body }));
  });

  it('finds the toasts', () => {
    expect(rules.some((rule) => /canvas-undo-notice__text/.test(rule.selector))).toBe(true);
    expect(rules.some((rule) => /project-home__toast-text/.test(rule.selector))).toBe(true);
  });

  it('no toast or notice text is cut with an ellipsis or kept to one line', () => {
    const cut = rules.filter((rule) => /(toast|notice)(?![\w-]*(dot|icon|close|action|button|dismiss|back))/i.test(rule.selector)
      && (/text-overflow:\s*ellipsis/.test(rule.body) || /white-space:\s*nowrap/.test(rule.body)))
      .map((rule) => `${rule.file}: ${rule.selector}`);
    expect(cut).toEqual([]);
  });
});
