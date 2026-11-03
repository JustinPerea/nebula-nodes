// fix/ci-flakes-rename-fix16: a Cinema scene deleted while the person's edits
// to it weren't saved keeps those edits (graphStore deletedSceneEdits, GM r20
// answer 3) for when the node comes back on the same canvas. Tests reuse ids
// (n1) on one canvas, so the next test's n1 took them back as a delete undone
// and saved them: in CI that save took graphStore.fix16's queued 400. This
// check keeps every test file that deletes scene nodes (deleteNode or
// deleteNodes, or a fake backend marking a node deleted) resetting that state
// in afterEach with resetDeletedSceneEditsForTests.
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

const deletesScenes = (source: string) => /['"]cinema-scene['"]/.test(source)
  && /\bdeleteNodes?\(|\.deleted\s*=\s*true\b|\bdeleted:\s*true\b/.test(source);
const resetsAfterEach = (source: string) =>
  /\bafterEach\(\s*\(\)\s*=>\s*\{?\s*(?:store\.)?resetDeletedSceneEditsForTests\(\)/.test(source);

describe('test files that delete scenes reset the kept scene edits after each test', () => {
  it('reads the forms', () => {
    const scene = "data: { definitionId: 'cinema-scene' } ";
    expect(deletesScenes(`${scene} useGraphStore.getState().deleteNode('n1');`)).toBe(true);
    expect(deletesScenes(`${scene} state.deleted = true;`)).toBe(true);
    expect(deletesScenes("useGraphStore.getState().deleteNode('n1');")).toBe(false);
    expect(resetsAfterEach('afterEach(() => resetDeletedSceneEditsForTests());')).toBe(true);
    expect(resetsAfterEach('afterEach(() => store.resetDeletedSceneEditsForTests());')).toBe(true);
    // Called once, not after each test: the next test still inherits.
    expect(resetsAfterEach('beforeAll(() => resetDeletedSceneEditsForTests());')).toBe(false);
  });

  it('every test file that deletes scene nodes calls resetDeletedSceneEditsForTests in afterEach', () => {
    const leaking = [...testFiles(TESTS), ...testFiles(SRC)]
      .filter((path) => !path.endsWith('sceneEditsResetRatchet.test.ts'))
      .filter((path) => {
        const source = readFileSync(path, 'utf8');
        return deletesScenes(source) && !resetsAfterEach(source);
      }).map((path) => relative(join(__dirname, '..'), path));
    expect(leaking).toEqual([]);
  });
});
