// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { compareToBaseline, isScanned, lowerBaseline, scanSource } from '../scripts/check-internal-ids.mjs';

/**
 * scripts/check-internal-ids.mjs runs in `npm run lint`: comments and test titles say "design" and
 * carry no studio initials, round ids or question ids. Each bad fixture must count; each fine one
 * must not. Baseline behaviour is checked on counts and through the CLI on a scratch tree.
 */
const count = (path: string, src: string) => scanSource(path, src).length;
const kinds = (path: string, src: string) => scanSource(path, src).map((m) => m.kind);

describe('check-internal-ids: what counts', () => {
  it('counts the studio initials in a comment and in code', () => {
    expect(count('a.ts', '// GM wants this wider\nconst a = 1;')).toBe(1);
    expect(count('a.ts', 'const label = "GM pick";')).toBe(1);
  });

  it('counts a design-round id after the initials', () => {
    expect(kinds('a.ts', '// GM r12 1: the gap')).toEqual(['gm', 'round']);
  });

  it('counts a question id next to the initials', () => {
    expect(kinds('a.ts', '/* (GM, Q9 a) the tab order */')).toEqual(['gm', 'question']);
  });

  it('counts the phrase round N with an optional letter, in any case', () => {
    expect(count('a.ts', '// see round 3f for the fix')).toBe(1);
    expect(count('a.ts', '// Round 18n')).toBe(1);
  });

  it('counts a round id in a test title', () => {
    expect(count('a.test.ts', "it('design r29: the row stays put', () => {});")).toBe(1);
    expect(count('a.test.ts', 'describe("Q4 spacing", () => {});')).toBe(1);
    expect(count('a.test.ts', "test.only('r7b item 2: keeps focus', () => {});")).toBe(1);
  });

  it('counts ids in Python comments and docstrings', () => {
    expect(count('a.py', 'x = 1  # design r12: the gap\n')).toBe(1);
    expect(count('a.py', 'def f():\n    """Round 4 behaviour, Q12."""\n')).toBe(2);
  });

  it('counts ids in a CSS comment', () => {
    expect(count('a.css', '.a { /* GM r40 1 */ color: red; }')).toBe(2);
  });

  it('counts a bare round id only in a design-round context', () => {
    for (const src of ['// GM r16', '// PR #211 r9', '// review r5 NIT-1', '// r24 Q2', '// r9 item 4', '// design r12', '// fix round 9']) {
      expect(count('a.ts', src), src).toBeGreaterThan(0);
    }
  });

  it('does not count a bare r1 that is a domain id', () => {
    expect(count('a.ts', '// regions: {id: "r1"}, "r2"')).toBe(0);
    expect(count('a.ts', '// a region id (r2)')).toBe(0);
    expect(count('a.test.tsx', "it('region r1 set whole', () => {});")).toBe(0);
    expect(count('a.py', '# structure.read.regions.r1.role\n')).toBe(0);
  });

  it('counts a real Python docstring but not a triple-quoted value', () => {
    expect(count('a.py', 'def f():\n    """Round 3 behaviour."""\n    return 1\n')).toBe(1);
    expect(count('a.py', 'class A:\n    """Round 3."""\n')).toBe(1);
    expect(count('a.py', '"""Module note, round 3."""\nimport os\n')).toBe(1);
    expect(count('a.py', 'SYSTEM_PROMPT = """\nname regions r1 and round 3 and Q12\n"""\n')).toBe(0);
    expect(count('a.py', 'def f():\n    return """round 3"""\n')).toBe(0);
    expect(count('a.py', 'def f():\n    x = 1\n    y = """round 3"""\n')).toBe(0);
  });

  it('does not count GMT or a word that contains the initials', () => {
    expect(count('a.ts', '// 12:00 GMT, GMAIL, aGM, GM_FLAG')).toBe(0);
  });

  it('does not count a code identifier named like a round id', () => {
    expect(count('a.ts', 'const r12 = 1;\nconst q = r12 + 1;')).toBe(0);
  });

  it('does not count an SVG radius attribute', () => {
    expect(count('a.tsx', '<circle cx="4" cy="4" r="12" />')).toBe(0);
  });

  it('does not count Q1 inside an identifier', () => {
    expect(count('a.ts', 'const d = useQ1Data(); // Q1Data stays')).toBe(0);
  });

  it('does not count a CSS value or a plain string', () => {
    expect(count('a.css', '.a { width: 12px; transition: r12 1s; content: "r12 Q4"; }')).toBe(0);
    expect(count('a.ts', 'const s = "round 3f and r12 and Q9";')).toBe(0);
  });

  it('does not count a round id in a non-title string argument', () => {
    expect(count('a.test.ts', "expect(label).toBe('r12');")).toBe(0);
  });

  it('does not mistake a // inside a string for a comment', () => {
    expect(count('a.ts', 'const u = "http://x.test/r12"; const r1 = 1;')).toBe(0);
  });

  it('reports the line and text of a match', () => {
    const [m] = scanSource('a.ts', 'const a = 1;\n// GM r12 1: gap\n');
    expect(m).toMatchObject({ line: 2, kind: 'gm' });
    expect(m.text).toBe('// GM r12 1: gap');
  });
});

describe('check-internal-ids: what is scanned', () => {
  it('skips data fixtures, dependencies, lockfiles and the check itself', () => {
    expect(isScanned('frontend/src/a.ts')).toBe(true);
    expect(isScanned('backend/x/y.py')).toBe(true);
    expect(isScanned('backend/tests/fixtures/a.py')).toBe(false);
    expect(isScanned('frontend/tests/__golden__/a.ts')).toBe(false);
    expect(isScanned('frontend/src/node_modules/a.ts')).toBe(false);
    expect(isScanned('frontend/src/a.json')).toBe(false);
    expect(isScanned('frontend/scripts/check-internal-ids.mjs')).toBe(false);
    expect(isScanned('frontend/tests/internalIdCheck.test.ts')).toBe(false);
    expect(isScanned('docs/a.ts')).toBe(false);
  });
});

describe('check-internal-ids: baseline', () => {
  const matches = { 'a.ts': [{ line: 3, text: '// GM wants it', kind: 'gm', match: 'GM' }] };

  it('fails when a count rises, naming file:line and the text', () => {
    const { failures } = compareToBaseline({ 'a.ts': 2 }, matches, { 'a.ts': 1 });
    expect(failures).toHaveLength(1);
    expect(failures[0].lines[0]).toContain('a.ts:3');
    expect(failures[0].lines[0]).toContain('GM wants it');
  });

  it('fails a file that is not in the baseline and has a match', () => {
    expect(compareToBaseline({ 'b.ts': 1 }, matches, { 'a.ts': 1 }).failures).toHaveLength(1);
  });

  it('passes an unchanged count and a fall, and notes the fall', () => {
    expect(compareToBaseline({ 'a.ts': 1 }, matches, { 'a.ts': 1 })).toEqual({ failures: [], notes: [] });
    const fell = compareToBaseline({ 'a.ts': 1 }, matches, { 'a.ts': 3 });
    expect(fell.failures).toEqual([]);
    expect(fell.notes).toEqual([{ file: 'a.ts', count: 1, allowed: 3 }]);
    const gone = compareToBaseline({}, {}, { 'a.ts': 3 });
    expect(gone.failures).toEqual([]);
    expect(gone.notes).toHaveLength(1);
  });

  it('lowerBaseline only lowers, drops files at zero and never adds a file', () => {
    expect(lowerBaseline({ 'a.ts': 5, 'b.ts': 1, 'c.ts': 9 }, { 'a.ts': 3, 'b.ts': 4, 'd.ts': 2 })).toEqual({
      'a.ts': 3,
      'b.ts': 1,
    });
  });
});

describe('check-internal-ids: command line on a scratch tree', () => {
  let root: string;
  const script = join(__dirname, '..', 'scripts', 'check-internal-ids.mjs');
  const run = (...args: string[]) => {
    try {
      const out = execFileSync('node', [script, '--root', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };
  const write = (rel: string, body: string) => {
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), body);
  };
  const baselineFile = () => join(root, 'frontend/scripts/internal-ids-baseline.json');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'idcheck-'));
    write('frontend/src/a.ts', '// GM one\n// GM two\n');
    write('frontend/scripts/keep', '');
    run('--write-baseline');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates the baseline once, then passes', () => {
    expect(JSON.parse(readFileSync(baselineFile(), 'utf8'))).toEqual({ 'frontend/src/a.ts': 2 });
    expect(run().code).toBe(0);
  });

  it('fails when a count rises and says to write design', () => {
    write('frontend/src/a.ts', '// GM one\n// GM two\n// GM three\n');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('frontend/src/a.ts:3');
    expect(r.out).toContain('"design"');
  });

  it('fails a new file with a match', () => {
    write('frontend/src/b.ts', '// GM new\n');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('frontend/src/b.ts:1');
  });

  it('passes a fall with a note, and --write-baseline lowers it', () => {
    write('frontend/src/a.ts', '// GM one\n');
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('--write-baseline');
    expect(run('--write-baseline').code).toBe(0);
    expect(JSON.parse(readFileSync(baselineFile(), 'utf8'))).toEqual({ 'frontend/src/a.ts': 1 });
    write('frontend/src/a.ts', '// fine\n');
    run('--write-baseline');
    expect(JSON.parse(readFileSync(baselineFile(), 'utf8'))).toEqual({});
  });

  it('--write-baseline never raises a count or adds a file', () => {
    write('frontend/src/a.ts', '// GM one\n// GM two\n// GM three\n');
    write('frontend/src/b.ts', '// GM new\n');
    const r = run('--write-baseline');
    expect(r.code).toBe(1);
    expect(JSON.parse(readFileSync(baselineFile(), 'utf8'))).toEqual({ 'frontend/src/a.ts': 2 });
  });
});
