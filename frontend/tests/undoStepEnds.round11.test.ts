import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Review 10, L-2: an undo pressed while a beginUndoStep step's request is on
// its way waits for that request (graphStore holdsHistory). So every caller
// must end its step once the answer is on the canvas (endUndoStep), or cancel
// it (cancelUndoStep), on every path, or Cmd+Z would wait until the hold
// limit. Each file that begins steps ends them in a `finally`.

const SRC = join(__dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const callers = sources(SRC)
  .map((path) => ({ path: relative(SRC, path), text: readFileSync(path, 'utf8') }))
  .filter(({ text }) => /beginUndoStep\(\)/.test(text));

describe('every beginUndoStep is ended', () => {
  it('the inventory: every file that begins a step', () => {
    expect(callers.map(({ path }) => path).sort()).toEqual([
      'components/panels/ChatPanel.tsx',
      'components/panels/Toolbar.tsx',
      'lib/canvasFileDrop.ts',
      // Chat's /clear (review 12, L-4: moved out of ChatPanel so its failure line is tested).
      'lib/chatCanvasClear.ts',
      'store/canvasProposalsStore.ts',
      'store/graphStore.ts',
    ]);
  });

  it.each(callers.map(({ path, text }) => [path, text] as const))('%s ends each step it begins, in a finally', (_path, text) => {
    const begun = text.match(/beginUndoStep\(\)/g)?.length ?? 0;
    const ended = text.match(/finally\s*(?:\{|\(\(\) => )[^}]*?endUndoStep\(/g)?.length ?? 0;
    expect(ended).toBe(begun);
  });
});
