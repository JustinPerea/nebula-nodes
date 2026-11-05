import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GM - Design r70's budget on #225: only the wake path (the socket's rows,
 * listeners and session activity) rides in the entry with the thread store;
 * the draft and the send (the one API call) are lib/personThreadCompose.ts's,
 * which only the deferred box imports. A runtime import of it, or of the API
 * helpers, from the eager modules would pull it back into the entry.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../src', file), 'utf8');
const runtimeImports = (source: string) => [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)].map((m) => m[1]);

describe('the thread store’s entry half', () => {
  it('the eager store and lib import neither the compose half nor the API at run time', () => {
    for (const file of ['store/personThreadStore.ts', 'lib/personThread.ts']) {
      const imports = runtimeImports(read(file));
      expect(imports.filter((path) => /personThreadCompose|apiRequest|errorCopy|personThreadBox/.test(path)), file).toEqual([]);
    }
  });

  it('the store has no send or draft code; the box sends through the compose half', () => {
    const store = read('store/personThreadStore.ts');
    expect(store).not.toMatch(/\bsend:\s*async/);
    expect(store).not.toMatch(/\bsetDraft:/);
    const box = read('components/panels/MessageBox.tsx');
    expect(runtimeImports(box)).toContain('../../lib/personThreadCompose');
    // The app loads the store eagerly; nothing eager loads the compose half.
    expect(read('App.tsx')).not.toMatch(/personThreadCompose/);
  });
});
