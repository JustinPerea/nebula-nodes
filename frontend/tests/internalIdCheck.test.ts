// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  compareToBaseline,
  compareWithMain,
  isScanned,
  lowerBaseline,
  moveAllowance,
  scanSource,
} from '../scripts/check-internal-ids.mjs';

/**
 * scripts/check-internal-ids.mjs runs in `npm run lint`: comments and test titles say "design" and
 * carry no studio initials, round ids, question ids or review ids. Each bad fixture must count;
 * each fine one must not. Fixture ids are synthetic (901 and up) so they match nothing real.
 */
const count = (path: string, src: string) => scanSource(path, src).length;
const kinds = (path: string, src: string) => scanSource(path, src).map((m) => m.kind);

describe('check-internal-ids: what counts', () => {
  it('counts the studio initials in a comment and in code', () => {
    expect(count('a.ts', '// GM wants this wider\nconst a = 1;')).toBe(1);
    expect(count('a.ts', 'const label = "GM pick";')).toBe(1);
  });

  it('counts a design-round id after the initials', () => {
    expect(kinds('a.ts', '// GM r901 1: the gap')).toEqual(['gm', 'round']);
  });

  it('counts a question id next to the initials', () => {
    expect(kinds('a.ts', '/* (GM, Q901 a) the tab order */')).toEqual(['gm', 'question']);
  });

  it('counts the phrase round N with an optional letter, in any case', () => {
    expect(count('a.ts', '// see round 901b for the fix')).toBe(1);
    expect(count('a.ts', '// Round 901n')).toBe(1);
  });

  it('counts a round id in a test title', () => {
    expect(count('a.test.ts', "it('design r901: the row stays put', () => {});")).toBe(1);
    expect(count('a.test.ts', 'describe("Q901 spacing", () => {});')).toBe(1);
    expect(count('a.test.ts', "test.only('r901b item 2: keeps focus', () => {});")).toBe(1);
  });

  it('counts titles written with .each', () => {
    expect(count('a.test.ts', "it.each([1, 2])('design r901 %s', () => {});")).toBe(1);
    expect(count('a.test.ts', "test.each([[1, 2]])(\n  'Q901 %s',\n  () => {},\n);")).toBe(1);
    expect(count('a.test.ts', "describe.each([{ a: 1 }])('round 901 %o', () => {});")).toBe(1);
  });

  it('does not read a member call as a test title', () => {
    expect(count('a.test.ts', "expect(RE.test('Q901 spacing')).toBe(false);")).toBe(0);
    expect(count('a.ts', "const ok = /x/.test('round 901');")).toBe(0);
    expect(count('a.ts', "const ok = obj.it('round 901');")).toBe(0);
  });

  it('counts review ids and severity ids in comments and titles only', () => {
    expect(count('a.ts', '// Review 901, LOW-91: the gap')).toBe(2);
    expect(count('a.ts', '// review 901')).toBe(1);
    expect(count('a.ts', '// keep the last N-1 frames and the first M-2 rows')).toBe(0);
    for (const id of ['LOW-91', 'MED-91', 'MEDIUM-91', 'HIGH-91', 'NIT-91']) {
      expect(kinds('a.ts', `// ${id}`), id).toEqual(['review']);
    }
    for (const id of ['H-91', 'L-91', 'M-91', 'N-91']) {
      expect(kinds('a.ts', `// Review 901, ${id}: the gap`), id).toEqual(['review', 'review']);
      expect(kinds('a.ts', `// LOW-91, ${id}`), id).toEqual(['review', 'review']);
      expect(count('a.ts', `// ${id} on its own`), id).toBe(0);
    }
    expect(count('a.test.ts', "it('Review 901 H-91', () => {});")).toBe(2);
    expect(count('a.ts', 'const s = "Review 901 LOW-91";')).toBe(0);
    expect(count('a.ts', '// SHA-256 and UTF-8 and low-3')).toBe(0);
  });

  it('counts a bare round id in the wider design-round contexts', () => {
    for (const src of [
      '// GM r901',
      '// PR #9001 r901',
      '// #9001 r901',
      '// review r901 NIT-91',
      '// since r901',
      '// per r901',
      '// r901 Q901',
      '// r901 item 4',
      '// design r901',
      '// fix round 901',
    ]) {
      expect(count('a.ts', src), src).toBeGreaterThan(0);
    }
  });

  it('counts both ids of a slash chain whose first one counts', () => {
    expect(count('a.py', '# GM r901/r902 19\n')).toBe(3);
    expect(count('a.ts', '// r901/r902')).toBe(0);
  });

  it('does not count uppercase R901', () => {
    expect(count('a.ts', '// Probe R901: the gap')).toBe(0);
    expect(count('a.ts', '// since R901')).toBe(0);
  });

  it('does not count a bare r1 that is a domain id, nor "in r901"', () => {
    expect(count('a.ts', '// regions: {id: "r901"}, "r902"')).toBe(0);
    expect(count('a.ts', '// a region id (r901)')).toBe(0);
    expect(count('a.ts', '// in r901 the region is set')).toBe(0);
    expect(count('a.test.tsx', "it('region r901 set whole', () => {});")).toBe(0);
    expect(count('a.py', '# structure.read.regions.r901.role\n')).toBe(0);
  });

  it('does not count round N used as arithmetic or Q after quarter or fiscal', () => {
    expect(count('a.ts', '// round 2 decimal places')).toBe(0);
    expect(count('a.ts', '// round 0.5 up to 1')).toBe(0);
    expect(count('a.ts', "it('round 2.5 rounds up', () => {});")).toBe(0);
    expect(count('a.ts', '// round 3 digits, round 4 dp')).toBe(0);
    expect(count('a.ts', '// quarters Q1 to Q4')).toBe(0);
    expect(count('a.ts', '// fiscal Q3 numbers')).toBe(0);
  });

  it('counts ids in Python comments and docstrings', () => {
    expect(count('a.py', 'x = 1  # design r901: the gap\n')).toBe(1);
    expect(count('a.py', 'def f():\n    """Round 901 behaviour, Q901."""\n')).toBe(2);
  });

  it('counts a real Python docstring but not a triple-quoted value', () => {
    expect(count('a.py', 'def f():\n    """Round 901 behaviour."""\n    return 1\n')).toBe(1);
    expect(count('a.py', 'class A:\n    """Round 901."""\n')).toBe(1);
    expect(count('a.py', '"""Module note, round 901."""\nimport os\n')).toBe(1);
    expect(count('a.py', 'SYSTEM_PROMPT = """\nname regions r901 and round 901 and Q901\n"""\n')).toBe(0);
    expect(count('a.py', 'def f():\n    return """round 901"""\n')).toBe(0);
    expect(count('a.py', 'def f():\n    x = 1\n    y = """round 901"""\n')).toBe(0);
  });

  it('counts a docstring after a multi-line signature, not a dict value after a key line', () => {
    expect(count('a.py', 'def f(\n    a: int,\n) -> int:\n    """round 901"""\n')).toBe(1);
    expect(count('a.py', "def f():\n    d = {\n        'a':\n            \"\"\"round 901 Q901\"\"\",\n    }\n")).toBe(0);
    expect(count('a.py', 'def f():\n    if (x):\n        """round 901"""\n')).toBe(0);
  });

  it('counts ids in a CSS comment', () => {
    expect(count('a.css', '.a { /* GM r901 1 */ color: red; }')).toBe(2);
  });

  it('does not count GMT or a word that contains the initials', () => {
    expect(count('a.ts', '// 12:00 GMT, GMAIL, aGM, GM_FLAG')).toBe(0);
  });

  it('does not count a code identifier named like a round id', () => {
    expect(count('a.ts', 'const r901 = 1;\nconst q = r901 + 1;')).toBe(0);
  });

  it('does not count an SVG radius attribute', () => {
    expect(count('a.tsx', '<circle cx="4" cy="4" r="12" />')).toBe(0);
  });

  it('does not count Q901 inside an identifier', () => {
    expect(count('a.ts', 'const d = useQ901Data(); // Q901Data stays')).toBe(0);
  });

  it('does not count a CSS value or a plain string', () => {
    expect(count('a.css', '.a { width: 12px; transition: r901 1s; content: "r901 Q901"; }')).toBe(0);
    expect(count('a.ts', 'const s = "round 901b and r901 and Q901";')).toBe(0);
  });

  it('does not count a round id in a non-title string argument', () => {
    expect(count('a.test.ts', "expect(label).toBe('r901');")).toBe(0);
  });

  it('does not mistake a // inside a string for a comment', () => {
    expect(count('a.ts', 'const u = "http://x.test/r901"; const r1 = 1;')).toBe(0);
  });

  it('reads a regex literal after a keyword or an operator as a regex', () => {
    expect(count('a.ts', "function f(s) { return /a\\/*b/.test(s); }\nconst x = 'round 901 Q901';")).toBe(0);
    expect(count('a.ts', "const glob = x + /\\*\\//; const t = 'Q901';")).toBe(0);
    expect(count('a.ts', "const a = typeof /x\\/\\//; const t = 'Q901';")).toBe(0);
    expect(count('a.ts', "const b = x < /\\/\\//; // GM")).toBe(1);
  });

  it('treats shell # as a comment only at line start or after whitespace or ; | & (', () => {
    expect(count('a.sh', 'n=${#arr[@]} round 901 Q901\n')).toBe(0);
    expect(count('a.sh', 'echo $# round 901\n')).toBe(0);
    expect(count('a.sh', 'url=http://x#Q901\n')).toBe(0);
    expect(count('a.sh', 'x="a\nb # not a comment Q901"\n')).toBe(0);
    expect(count('a.sh', 'cmd; # Q901\n')).toBe(1);
    expect(count('a.sh', '# Q901\n')).toBe(1);
    expect(count('a.sh', 'echo hi # round 901\n')).toBe(1);
  });

  it('reports the line and text of a match', () => {
    const [m] = scanSource('a.ts', 'const a = 1;\n// GM r901 1: gap\n');
    expect(m).toMatchObject({ line: 2, kind: 'gm' });
    expect(m.text).toBe('// GM r901 1: gap');
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

  it('hints at a move when a new path matches what a vanished path freed', () => {
    const { failures } = compareToBaseline({ 'b.ts': 2 }, { 'b.ts': [] }, { 'a.ts': 2 });
    expect(failures[0].hint).toBe('b.ts looks like a move of a.ts (2 allowed): run with --move a.ts b.ts, or drop the ids');
    expect(compareToBaseline({ 'b.ts': 3 }, { 'b.ts': [] }, { 'a.ts': 2 }).failures[0].hint).toBeUndefined();
  });

  it('lowerBaseline only lowers, drops files at zero and never adds a file', () => {
    expect(lowerBaseline({ 'a.ts': 5, 'b.ts': 1, 'c.ts': 9 }, { 'a.ts': 3, 'b.ts': 4, 'd.ts': 2 })).toEqual({
      'a.ts': 3,
      'b.ts': 1,
    });
  });

  it('moveAllowance moves, caps at the new count, keeps a split remainder and refuses unknown paths', () => {
    expect(moveAllowance({ 'a.ts': 2 }, { 'b.ts': 2 }, 'a.ts', 'b.ts')).toEqual({ 'b.ts': 2 });
    expect(moveAllowance({ 'a.ts': 5 }, { 'b.ts': 2 }, 'a.ts', 'b.ts')).toEqual({ 'b.ts': 2 });
    expect(moveAllowance({ 'a.ts': 5 }, { 'a.ts': 3, 'b.ts': 2 }, 'a.ts', 'b.ts')).toEqual({ 'a.ts': 3, 'b.ts': 2 });
    expect(() => moveAllowance({ 'a.ts': 2 }, {}, 'x.ts', 'b.ts')).toThrow(/not in the baseline/);
  });

  it('compareWithMain fails a raised entry and a net raise on new paths, and lets a move pass', () => {
    expect(compareWithMain({ 'a.ts': 3 }, { 'a.ts': 2 })).toHaveLength(1);
    expect(compareWithMain({ 'a.ts': 2, 'b.ts': 1 }, { 'a.ts': 2 })).toHaveLength(1);
    expect(compareWithMain({ 'b.ts': 2 }, { 'a.ts': 2 })).toEqual([]);
    expect(compareWithMain({ 'a.ts': 1, 'b.ts': 1 }, { 'a.ts': 2 })).toEqual([]);
    expect(compareWithMain({ 'a.ts': 1 }, { 'a.ts': 2, 'b.ts': 1 })).toEqual([]);
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
  const baseline = () => JSON.parse(readFileSync(baselineFile(), 'utf8'));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'idcheck-'));
    write('frontend/src/a.ts', '// GM one\n// GM two\n');
    write('frontend/scripts/keep', '');
    run('--write-baseline');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates the baseline once, then passes and prints every kind', () => {
    expect(baseline()).toEqual({ 'frontend/src/a.ts': 2 });
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('2 studio, 0 round, 0 question, 0 review');
  });

  it('fails when a count rises and says to write design', () => {
    write('frontend/src/a.ts', '// GM one\n// GM two\n// GM three\n');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('frontend/src/a.ts:3');
    expect(r.out).toContain('"design"');
    expect(r.out).toContain('neutral name');
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
    expect(r.out).toContain('npm run check:internal-ids -- --write-baseline');
    expect(run('--write-baseline').code).toBe(0);
    expect(baseline()).toEqual({ 'frontend/src/a.ts': 1 });
    write('frontend/src/a.ts', '// fine\n');
    run('--write-baseline');
    expect(baseline()).toEqual({});
  });

  it('--write-baseline never raises a count or adds a file', () => {
    write('frontend/src/a.ts', '// GM one\n// GM two\n// GM three\n');
    write('frontend/src/b.ts', '// GM new\n');
    const r = run('--write-baseline');
    expect(r.code).toBe(1);
    expect(baseline()).toEqual({ 'frontend/src/a.ts': 2 });
  });

  it('hints at a rename, and --move carries the allowance over', () => {
    rmSync(join(root, 'frontend/src/a.ts'));
    write('frontend/src/b.ts', '// GM one\n// GM two\n');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('frontend/src/b.ts looks like a move of frontend/src/a.ts (2 allowed)');
    expect(r.out).toContain('--move frontend/src/a.ts frontend/src/b.ts');
    const moved = run('--move', 'frontend/src/a.ts', 'frontend/src/b.ts');
    expect(moved.code).toBe(0);
    expect(baseline()).toEqual({ 'frontend/src/b.ts': 2 });
  });

  it('--move refuses a path that is not in the baseline', () => {
    const r = run('--move', 'frontend/src/zzz.ts', 'frontend/src/a.ts');
    expect(r.code).toBe(1);
    expect(r.out).toContain('not in the baseline');
    expect(baseline()).toEqual({ 'frontend/src/a.ts': 2 });
  });

  it('scans untracked files in a git tree', () => {
    const git = (...a: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t.test', ...a], { stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'base');
    write('frontend/src/c.ts', '// GM untracked\n');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('frontend/src/c.ts:1');
  });

  it('fails a baseline raised above origin/main, and stays quiet without origin/main', () => {
    const git = (...a: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t.test', ...a], { stdio: 'ignore' });
    expect(run().code).toBe(0);
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', 'base');
    expect(run().code).toBe(0);
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect(run().code).toBe(0);
    write('frontend/src/a.ts', '// GM one\n// GM two\n// GM three\n');
    writeFileSync(baselineFile(), JSON.stringify({ 'frontend/src/a.ts': 3 }));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("above main's 2");
  });
});
