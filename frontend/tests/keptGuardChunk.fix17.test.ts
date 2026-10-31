// @vitest-environment node
/**
 * Round 17 of PR #199 (GM r23, 3): scripts/check-kept-guard-chunk.mjs, run by
 * `npm run build` after the budget, fails the build when the kept unload
 * guard or the kept fallback line leaves the entry chunk or lands in the lazy
 * catalogRestoreCopy chunk. Here against small build folders of its shape;
 * the real build was checked when this was written (round 17 notes).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../scripts/check-kept-guard-chunk.mjs');
const GUARD = 'window.addEventListener(`beforeunload`,s)';
const KEPT_LINE = 'x=`Nebula restored its project list before your latest edits were saved. They’re kept in this tab.`';
const made: string[] = [];

function dist({ entry, copy, copies = 1 }: { entry: string; copy: string; copies?: number }): string {
  const dir = mkdtempSync(join(tmpdir(), 'kept-guard-'));
  made.push(dir);
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<script type="module" crossorigin src="/assets/index-AbC123.js"></script>');
  writeFileSync(join(dir, 'assets', 'index-AbC123.js'), entry);
  for (let i = 0; i < copies; i += 1) writeFileSync(join(dir, 'assets', `catalogRestoreCopy-Zz${i}.js`), copy);
  return dir;
}

function run(dir: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (error) {
    return { ok: false, out: String((error as { stderr?: string }).stderr ?? error) };
  }
}

afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('the kept guard stays in the entry chunk', () => {
  it('passes when both are in the entry chunk only', () => {
    const result = run(dist({ entry: `${GUARD};${KEPT_LINE}`, copy: 'export const a=1;' }));
    expect(result.ok).toBe(true);
    expect(result.out).toContain('Kept guard check passed');
  });

  it('fails, naming it, when the guard is missing from the entry chunk', () => {
    const result = run(dist({ entry: KEPT_LINE, copy: 'export const a=1;' }));
    expect(result.ok).toBe(false);
    expect(result.out).toContain('the kept unload guard is not in the entry chunk index-AbC123.js');
  });

  it('fails when the guard is in the lazy chunk', () => {
    const result = run(dist({ entry: `${GUARD};${KEPT_LINE}`, copy: GUARD }));
    expect(result.ok).toBe(false);
    expect(result.out).toContain('the kept unload guard is in the lazy chunk catalogRestoreCopy-Zz0.js');
  });

  it('fails when the kept fallback line is only in the lazy chunk', () => {
    const result = run(dist({ entry: GUARD, copy: KEPT_LINE }));
    expect(result.ok).toBe(false);
    expect(result.out).toContain('the kept fallback line is not in the entry chunk');
    expect(result.out).toContain('the kept fallback line is in the lazy chunk');
  });

  it('reads the guard in any quote minification picks', () => {
    for (const quote of ['"', "'"]) {
      const result = run(dist({ entry: `window.addEventListener(${quote}beforeunload${quote},s);${KEPT_LINE}`, copy: '' }));
      expect(result.ok).toBe(true);
    }
  });

  it('fails when the lazy chunk is not found (a renamed chunk must not pass silently)', () => {
    expect(run(dist({ entry: `${GUARD};${KEPT_LINE}`, copy: '', copies: 0 })).out).toContain('expected one catalogRestoreCopy chunk');
  });

  it('runs from npm run build, after the budget', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.build).toMatch(/node scripts\/check-build-budget\.mjs && node scripts\/check-kept-guard-chunk\.mjs/);
  });
});
