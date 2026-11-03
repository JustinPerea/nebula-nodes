// fix/ci-flakes-rename-fix16: a fake backend's "deleted" flag flips when the
// DELETE arrives, before it answers. Until the answer the product drops an
// Undo ("Nothing was undone. Your last change was still saving.", GM r18
// option (c)) and holds a sync that brings the node back, so a test that
// waits on the flag and then presses Undo (or restores from another window)
// races the answer. graphStore.fix16 "nothing unsaved" lost that race on a
// busy CI runner (run 41591009433, attempt 1), and the scene edit it left
// aside failed the next test too; with the DELETE's answer stalled 30 ms both
// fail every time. Tests wait on helpers/deleteLanded.ts (the delete's own
// notice) instead; this check keeps the flag wait out of every test file.
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

/** A waitFor whose condition is a `.deleted` flag turning true. */
const waitsOnDeletedFlag = (source: string) =>
  /waitFor\(\s*\(\)\s*=>\s*expect\([^;]*?\.deleted\)\.toBe\(true\)/.test(source);

describe('tests wait for a delete’s answer, not the fake backend’s flag', () => {
  it('reads the forms the harnesses used', () => {
    expect(waitsOnDeletedFlag('await vi.waitFor(() => expect(h.state.deleted).toBe(true), { timeout: 3000, interval: 5 });')).toBe(true);
    expect(waitsOnDeletedFlag("await vi.waitFor(() => expect(h.scenes.get('n7')!.deleted).toBe(true), { timeout: 2000 });")).toBe(true);
    // A plain check after the answer, and a wait for the node to come back, are fine.
    expect(waitsOnDeletedFlag('expect(h.state.deleted).toBe(true);')).toBe(false);
    expect(waitsOnDeletedFlag('await vi.waitFor(() => expect(h.state.deleted).toBe(false));')).toBe(false);
  });

  it('no test file waits on a fake backend’s deleted flag (use deleteLanded)', () => {
    const racing = [...testFiles(TESTS), ...testFiles(SRC)]
      .filter((path) => !path.endsWith('deleteLandedRatchet.test.ts'))
      .filter((path) => waitsOnDeletedFlag(readFileSync(path, 'utf8')))
      .map((path) => relative(join(__dirname, '..'), path));
    expect(racing).toEqual([]);
  });
});
