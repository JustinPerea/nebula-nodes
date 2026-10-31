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

function run(entry: string, copy: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kept-guard18-'));
  made.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<script type="module" crossorigin src="/assets/index-AbC123.js"></script>');
  writeFileSync(join(dir, 'assets', 'index-AbC123.js'), entry);
  writeFileSync(join(dir, 'assets', 'catalogRestoreCopy-Zz0.js'), copy);
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
    expect(result.out).toContain('the kept unload guard is in the lazy chunk');
  });

  it('the kept guard and another one both in the entry chunk: passes', () => {
    expect(run(`${OTHER_GUARD};${KEPT_GUARD};${KEPT_LINE}`, 'export const a=1;').ok).toBe(true);
  });

  it('the store marks the kept branch with that literal', () => {
    const store = readFileSync(resolve(__dirname, '../src/store/projectStore.ts'), 'utf8');
    expect(store).toContain("const KEPT_UNLOAD_MARK = 'nebula-kept-unload-guard';");
    expect(store).toMatch(/if \(isCanvasKept\(\)\) \{[\s\S]{0,400}event\.returnValue = KEPT_UNLOAD_MARK;/);
  });
});
