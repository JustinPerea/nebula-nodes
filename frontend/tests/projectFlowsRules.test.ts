/**
 * PR #199 round 25: the two rules that keep the lazy flows chunk sound.
 *  1. Only store/projectFlows.ts sets a project context (so a context exists
 *     only after the chunk is evaluated, and code that runs with one may rely
 *     on the chunk being in).
 *  2. Nothing but the loader (and tests) imports store/projectFlows: a second
 *     instance, loaded from a fresh retry URL, would split its state in two.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const files: string[] = [];
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
  }
})(SRC);
const rel = (p: string) => relative(SRC, p).split('\\').join('/');

describe('the lazy project flows rules', () => {
  it('only store/projectFlows.ts sets a project context', () => {
    const setters = files
      .filter((f) => !f.endsWith('lib/projectContext.ts'))
      .filter((f) => /\bsetProjectContext\s*\(/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(setters).toEqual(['store/projectFlows.ts']);
  });

  it('no module imports store/projectFlows directly except the loader', () => {
    const importers = files
      .filter((f) => !f.endsWith('store/projectFlows.ts'))
      .filter((f) => /from\s+['"][^'"]*\/projectFlows['"]|from\s+['"]\.\/projectFlows['"]|import\(\s*['"][^'"]*\/projectFlows['"]\s*\)/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(importers).toEqual(['store/projectFlowsLoader.ts']);
  });
});
