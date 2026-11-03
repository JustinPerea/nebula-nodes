// fix/pin-text-corpus-flake: the pin text rules (pinDisplayText and the
// counts built on it) read Unicode data that canvasPins imports lazily, as its
// own chunk (review 13 L-2). Until the chunk lands every rule errs toward
// hiding, by design. The product waits for it (the pins store before it
// sanitizes, the note dialog before it counts); a test that calls the rules
// must wait too, or it races the import: agentPresenceFollowups.r12text
// failed every time alone and now and then in CI (run 41569694838 attempt 1
// failed, attempt 2 on the same commit passed). This check keeps every test
// file that imports one of those rules waiting on pinTextReady (or
// pinTextSettling, for a file that drives the load itself).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const DATA_RULES = ['pinDisplayText', 'textLength', 'noteLength', 'fitNote', 'keptNoteDisplay', 'noteIsEmpty'];
const TESTS = __dirname;
const SRC = join(__dirname, '../src');

const testFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === 'node_modules') return [];
  if (statSync(path).isDirectory()) return testFiles(path);
  return /\.test\.tsx?$/.test(name) ? [path] : [];
});

// The names a file takes from lib/canvasPins, by `import { … } from` or
// `const { … } = await import(…)`.
const canvasPinsImports = (source: string): string[] => {
  const names: string[] = [];
  const forms = [
    /import\s*\{([^}]*)\}\s*from\s*['"][^'"]*lib\/canvasPins['"]/g,
    /\{([^}]*)\}\s*=\s*await\s+import\(\s*['"][^'"]*lib\/canvasPins['"]\s*\)/g,
  ];
  for (const form of forms) {
    for (const match of source.matchAll(form)) {
      for (const part of match[1].split(',')) {
        const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+|:/)[0].trim();
        if (name) names.push(name);
      }
    }
  }
  return names;
};

describe('tests of the pin text rules wait for the Unicode data', () => {
  it('reads both import forms', () => {
    expect(canvasPinsImports("import { pinDisplayText, type KeptNote } from '../src/lib/canvasPins';")).toEqual(['pinDisplayText', 'KeptNote']);
    expect(canvasPinsImports("const { fitNote, noteLength: count } = await import('../src/lib/canvasPins');")).toEqual(['fitNote', 'noteLength']);
  });

  it('every test file that imports a rule waits on pinTextReady or pinTextSettling', () => {
    const racing = [...testFiles(TESTS), ...testFiles(SRC)].filter((path) => {
      const source = readFileSync(path, 'utf8');
      const rules = canvasPinsImports(source).filter((n) => DATA_RULES.includes(n));
      return rules.length > 0 && !/\bpinText(Ready|Settling)\b/.test(source);
    }).map((path) => relative(join(__dirname, '..'), path));
    expect(racing).toEqual([]);
  });
});
