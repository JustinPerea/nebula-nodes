// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { startupSet } from '../scripts/lib/startupChunks.mjs';

/**
 * The startup set is the entry plus every chunk it imports statically or
 * index.html modulepreloads. These build small fake dist folders.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pad = (n: number) => `/*${'x'.repeat(n)}*/`;

function fakeDist(files: Record<string, string>, preloads: string[] = []) {
  const dist = mkdtempSync(path.join(tmpdir(), 'nebula-startup-'));
  dirs.push(dist);
  mkdirSync(path.join(dist, 'assets'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dist, 'assets', name), body);
  const links = preloads.map((n) => `<link rel="modulepreload" crossorigin href="/assets/${n}">`).join('');
  writeFileSync(
    path.join(dist, 'index.html'),
    `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-AAAAAAAA.js"></script>${links}</head><body></body></html>`,
  );
  return dist;
}

const names = async (dist: string) => (await startupSet(dist)).members.map((m) => m.name).sort();

describe('startupSet', () => {
  it('counts the entry alone when nothing else loads at startup', async () => {
    const dist = fakeDist({ 'index-AAAAAAAA.js': 'console.log(1)', 'big-BBBBBBBB.js': pad(500) });
    expect(await names(dist)).toEqual(['index-AAAAAAAA.js']);
  });

  it('counts a chunk the entry imports statically, transitively, in minified forms', async () => {
    const dist = fakeDist({
      'index-AAAAAAAA.js': 'import{a as e}from"./store-BBBBBBBB.js";import"./side-CCCCCCCC.js";export*from"./reexp-GGGGGGGG.js";',
      'store-BBBBBBBB.js': 'import{b}from"./deep-DDDDDDDD.js";export{b as a}',
      'deep-DDDDDDDD.js': pad(300),
      'side-CCCCCCCC.js': '1',
      'reexp-GGGGGGGG.js': '1',
    });
    expect(await names(dist)).toEqual([
      'deep-DDDDDDDD.js', 'index-AAAAAAAA.js', 'reexp-GGGGGGGG.js', 'side-CCCCCCCC.js', 'store-BBBBBBBB.js',
    ]);
  });

  it('counts a modulepreloaded chunk the entry does not import', async () => {
    const dist = fakeDist(
      { 'index-AAAAAAAA.js': '1', 'pre-EEEEEEEE.js': pad(200) },
      ['pre-EEEEEEEE.js'],
    );
    const set = await startupSet(dist);
    expect(set.members.map((m) => m.name)).toContain('pre-EEEEEEEE.js');
    expect(set.raw).toBeGreaterThan(200);
  });

  it('does not count a chunk only reached by dynamic import() or a mapDeps list', async () => {
    const dist = fakeDist({
      'index-AAAAAAAA.js': 'const m=["assets/lazy-FFFFFFFF.js"];const f=()=>import("./lazy-FFFFFFFF.js");const g=()=>import(`./lazy2-HHHHHHHH.js`);',
      'lazy-FFFFFFFF.js': pad(900),
      'lazy2-HHHHHHHH.js': pad(900),
    });
    expect(await names(dist)).toEqual(['index-AAAAAAAA.js']);
  });

  it('terminates on import cycles and counts each chunk once', async () => {
    const dist = fakeDist({
      'index-AAAAAAAA.js': 'import"./a-BBBBBBBB.js";',
      'a-BBBBBBBB.js': 'import"./b-CCCCCCCC.js";import"./index-AAAAAAAA.js";',
      'b-CCCCCCCC.js': 'import"./a-BBBBBBBB.js";',
    });
    expect(await names(dist)).toEqual(['a-BBBBBBBB.js', 'b-CCCCCCCC.js', 'index-AAAAAAAA.js']);
  });
});

describe('check-build-budget startup limit', () => {
  it('fails over the limit and names the biggest members', () => {
    // The script reads ../dist relative to itself, so run a copy laid out like frontend/.
    const root = mkdtempSync(path.join(tmpdir(), 'nebula-budget-'));
    dirs.push(root);
    mkdirSync(path.join(root, 'scripts'));
    const src = path.resolve(__dirname, '../scripts');
    for (const f of ['check-build-budget.mjs', 'check-built-fonts.mjs', 'check-chunk-cycles.mjs']) {
      writeFileSync(path.join(root, 'scripts', f), readFileSync(path.join(src, f)));
    }
    mkdirSync(path.join(root, 'scripts', 'lib'));
    writeFileSync(path.join(root, 'scripts', 'lib', 'startupChunks.mjs'), readFileSync(path.join(src, 'lib', 'startupChunks.mjs')));
    const dist = path.join(root, 'dist');
    mkdirSync(path.join(dist, 'assets'), { recursive: true });
    // Incompressible-ish padding so gzip is large too; a small entry that statically imports a huge chunk.
    const noise = Array.from({ length: 2_200_000 }, (_, i) => String.fromCharCode(97 + ((i * 7919 + (i >> 3) * 31) % 26))).join('');
    writeFileSync(path.join(dist, 'assets', 'index-AAAAAAAA.js'), 'import"./hugeStore-BBBBBBBB.js";');
    writeFileSync(path.join(dist, 'assets', 'hugeStore-BBBBBBBB.js'), `/*${noise}*/`);
    writeFileSync(path.join(dist, 'index.html'), '<script type="module" src="/assets/index-AAAAAAAA.js"></script>');
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-build-budget.mjs')], { encoding: 'utf8' });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain('Startup set exceeds budget');
    expect(run.stderr).toContain('hugeStore.js');
  });
});
