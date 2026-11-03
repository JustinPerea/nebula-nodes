// fix/ci-flakes-rename-fix16: the notice region's own notices (RegionNotices)
// are a deferred chunk. A test that renders <NoticeRegion> before the chunk is
// in gets the notices from a Suspense retry React runs outside act(); a findBy
// sees that commit, but the store hooks' subscriptions are still queued, so a
// store change made next in act() never reaches the line. pr198Fix23Ui "a
// rename during a try" read "Opening" after the rename on a busy CI runner
// (run 41584394316, attempt 1); with React's scheduler stalled 20 ms it fails
// every time. This check keeps every test file that renders <NoticeRegion>
// loading the chunk first (helpers/regionNoticesReady.ts, or the chunk's own
// preload in a file under src/).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const TESTS = __dirname;
const SRC = join(__dirname, '../src');

const testFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === 'node_modules') return [];
  if (statSync(path).isDirectory()) return testFiles(path);
  return /\.test\.tsx?$/.test(name) ? [path] : [];
});

const rendersRegion = (source: string) => /<NoticeRegion\b/.test(source);
const loadsChunkFirst = (source: string) =>
  /\bbeforeAll\(\s*regionNoticesReady\s*\)/.test(source)
  || /\bbeforeAll\(\s*async\s*\(\)\s*=>\s*\{\s*await\s+DeferredRegionNotices\.preload\(\);?\s*\}\s*\)/.test(source);

describe('tests that render the notice region load its notices chunk first', () => {
  it('reads both forms, and only a beforeAll counts', () => {
    expect(rendersRegion('render(<NoticeRegion screen="canvas" />);')).toBe(true);
    expect(rendersRegion("import { NoticeRegion } from '../src/components/NoticeRegion';")).toBe(false);
    expect(loadsChunkFirst('beforeAll(regionNoticesReady);')).toBe(true);
    expect(loadsChunkFirst('beforeAll(async () => { await DeferredRegionNotices.preload(); });')).toBe(true);
    // Imported but never awaited before the renders: still racing.
    expect(loadsChunkFirst("import { regionNoticesReady } from './helpers/regionNoticesReady';")).toBe(false);
    // beforeAll(() => preload()) hands vitest the component as a teardown; it must be awaited, not returned.
    expect(loadsChunkFirst('beforeAll(() => DeferredRegionNotices.preload());')).toBe(false);
  });

  it('every test file that renders <NoticeRegion> waits on regionNoticesReady', () => {
    const racing = [...testFiles(TESTS), ...testFiles(SRC)].filter((path) => {
      const source = readFileSync(path, 'utf8');
      return rendersRegion(source) && !loadsChunkFirst(source);
    }).map((path) => relative(join(__dirname, '..'), path));
    expect(racing).toEqual([]);
  });
});
