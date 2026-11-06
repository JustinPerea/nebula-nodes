// @vitest-environment node
/**
 * Round 18 of PR #199 (review 16 kept-ui NIT-2): the chunk check finds the
 * kept unload guard by its own literal, so another component's beforeunload
 * in the entry chunk can't pass for it while the kept guard went elsewhere.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../scripts/check-kept-guard-chunk.mjs');
const KEPT_LINE = 'x=`Nebula restored its project list before your latest edits were saved. They’re kept in this tab.`';
const OTHER_GUARD = 'let c=e=>{e.preventDefault(),e.returnValue=``};window.addEventListener(`beforeunload`,c)';
const KEPT_GUARD = 'let s=e=>{if(F()){e.preventDefault(),e.returnValue=`nebula-kept-unload-guard`;return}};window.addEventListener(`beforeunload`,s)';
const made: string[] = [];

function run(entry: string, copy: string, extra: Record<string, string> = {}, flows = 'export const f=1;'): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kept-guard18-'));
  made.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<script type="module" crossorigin src="/assets/index-AbC123.js"></script>');
  writeFileSync(join(dir, 'assets', 'index-AbC123.js'), entry);
  writeFileSync(join(dir, 'assets', 'catalogRestoreCopy-Zz0.js'), copy);
  writeFileSync(join(dir, 'assets', 'projectFlows-Qq1.js'), flows);
  for (const [name, code] of Object.entries(extra)) writeFileSync(join(dir, 'assets', name), code);
  try {
    return { ok: true, out: execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { ok: false, out: String((error as { stderr?: string }).stderr ?? error) };
  }
}

afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('review 16 kept-ui NIT-2: the check finds the kept guard itself', () => {
  it('another beforeunload in the entry chunk, the kept guard in the lazy one: fails', () => {
    const result = run(`${OTHER_GUARD};${KEPT_LINE}`, KEPT_GUARD);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('the kept unload guard is not in the entry chunk');
    expect(result.out).toContain('or a chunk it imports statically');
    expect(result.out).toContain('the kept unload guard is in the lazy chunk');
  });

  it('the kept guard and another one both in the entry chunk: passes', () => {
    expect(run(`${OTHER_GUARD};${KEPT_GUARD};${KEPT_LINE}`, 'export const a=1;').ok).toBe(true);
  });

  // Round 25 (PR #199): the bundler may put what the entry and the lazy chunks
  // share in a common chunk the entry imports, which loads as early as it does.
  it('the kept guard in a chunk the entry imports statically passes, one reached only by a dynamic import does not', () => {
    const entry = (link: string) => `import{a}from"./${link}";${OTHER_GUARD};`;
    expect(run(entry('projectStore-Aa1.js'), 'export const a=1;', { 'projectStore-Aa1.js': `${KEPT_GUARD};${KEPT_LINE};export const a=1;` }).ok).toBe(true);
    // Two hops: the entry imports a chunk that imports the one that holds the guard.
    expect(run(entry('mid-Bb2.js'), 'export const a=1;', {
      'mid-Bb2.js': 'import{a}from"./deep-Cc3.js";export{a};', 'deep-Cc3.js': `${KEPT_GUARD};${KEPT_LINE};export const a=1;` }).ok).toBe(true);
    const lazy = run(`${OTHER_GUARD};const l=()=>import("./later-Dd4.js");`, 'export const a=1;', { 'later-Dd4.js': `${KEPT_GUARD};${KEPT_LINE}` });
    expect(lazy.ok).toBe(false);
    expect(lazy.out).toContain('the kept unload guard is not in the entry chunk');
  });

  it('the guard or the fallback line in the project flows chunk fails, even when the entry has them too', () => {
    const result = run(`${KEPT_GUARD};${KEPT_LINE}`, 'export const a=1;', {}, `${KEPT_GUARD};${KEPT_LINE}`);
    expect(result.ok).toBe(false);
    expect(result.out).toContain('the kept unload guard is in the lazy chunk projectFlows-Qq1.js');
    expect(result.out).toContain('the kept fallback line is in the lazy chunk projectFlows-Qq1.js');
  });

  it('the store marks the kept branch with that literal', () => {
    const store = readFileSync(resolve(__dirname, '../src/store/projectStore.ts'), 'utf8');
    expect(store).toContain("const KEPT_UNLOAD_MARK = 'nebula-kept-unload-guard';");
    expect(store).toMatch(/if \(isCanvasKept\(\)\) \{[\s\S]{0,400}event\.returnValue = KEPT_UNLOAD_MARK;/);
  });
});
