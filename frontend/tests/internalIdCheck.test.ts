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

  it('counts the whole word lane in a string, a title and a docstring, not in a comment', () => {
    expect(kinds('a.ts', 'const help = "give each lane its own cursor";')).toEqual(['lane']);
    expect(kinds('a.ts', "it('keeps one lane per agent', () => {});")).toEqual(['lane']);
    expect(kinds('a.py', 'HELP = "set a value per Lane"\n')).toEqual(['lane']);
    expect(kinds('a.py', 'def f():\n    """Give each lane its own cursor."""\n')).toEqual(['lane']);
    expect(count('a.ts', 'const x = ["lane", "lanes"];')).toBe(2);
    expect(count('a.css', '/* the scrollbar lane */ .a { color: red; }')).toBe(0);
    expect(count('a.ts', '// the scrollbar lane stays empty\n/* a lane here */')).toBe(0);
    expect(count('a.py', '# the scrollbar lane\n')).toBe(0);
    expect(count('a.ts', 'const s = "plane, laneway, lanewise, Elaney";')).toBe(0);
  });

  it('counts lane only in text people read, never in code', () => {
    expect(count('a.ts', 'const lane = 1;')).toBe(0);
    expect(count('a.css', '.swim-lane { grid-area: lane; }')).toBe(0);
    expect(count('a.tsx', 'const lane = 1;\nconst x = <div>{lane}</div>;')).toBe(0);
    expect(count('a.ts', "const t = 'each lane';")).toBe(1);
    expect(count('a.ts', 'const t = `each lane ${x}`;')).toBe(1);
    expect(count('a.tsx', 'const x = <p>each lane</p>;')).toBe(1);
    expect(count('a.tsx', 'const x = (\n  <p className="a">\n    each lane\n  </p>\n);')).toBe(1);
    expect(count('a.py', 'def f():\n    """Give each lane a cursor."""\n    lane = 1\n')).toBe(1);
    expect(count('a.py', 'lane = 1\ndef lane(): pass\n')).toBe(0);
  });

  it('finds lane in strings, templates, JSX text and Python strings with a parser, never in code or comments', () => {
    // a JS string -> 1
    expect(count("a.ts", "const t = 'each lane';")).toBe(1);
    // a template with an expression around literal lane text -> 1
    expect(count("a.ts", "const t = `a ${x} lane ${y}`;")).toBe(1);
    // JSX text after an expression -> 1
    expect(count("a.tsx", "const x = <Trans>each {n} lane</Trans>;")).toBe(1);
    // JSX text with a semicolon -> 1
    expect(count("a.tsx", "const x = <p>a;lane</p>;")).toBe(1);
    // multi-line JSX text -> 1
    expect(count("a.tsx", "const x = (\n  <p>\n    each\n    lane\n  </p>\n);")).toBe(1);
    // a JSX attribute string -> 1
    expect(count("a.tsx", "const x = <input aria-label=\"each lane\" />;")).toBe(1);
    // JSX text in a .jsx file -> 1
    expect(count("a.jsx", "const x = <p>each lane</p>;")).toBe(1);
    // JSX text in a .js file -> 1
    expect(count("a.js", "const x = <p>each lane</p>;")).toBe(1);
    // a test title -> 1
    expect(count("a.test.ts", "it('keeps one lane per agent', () => {});")).toBe(1);
    // a Python docstring -> 1
    expect(count("a.py", "def f():\n    \"\"\"Give each lane a cursor.\"\"\"\n")).toBe(1);
    // a Python module constant in triple quotes -> 1
    expect(count("a.py", "X = \"\"\"each lane\"\"\"\n")).toBe(1);
    // a Python f-string -> 1
    expect(count("a.py", "x = f\"each lane {n}\"\n")).toBe(1);
    // a Python return of a triple-quoted string -> 1
    expect(count("a.py", "def f():\n    return \"\"\"lane\"\"\"\n")).toBe(1);
    // a lane identifier -> 0
    expect(count("a.ts", "const lane = 1;")).toBe(0);
    // a lane expression in a template -> 0
    expect(count("a.ts", "const s = `${lane} x`;")).toBe(0);
    // a lane identifier after a generic type -> 0
    expect(count("a.tsx", "const m: Array<string> = [];\nconst lane = 1;")).toBe(0);
    // a lane argument after a generic call -> 0
    expect(count("a.tsx", "const [v] = useState<string>(lane);")).toBe(0);
    // a lane parameter of a generic function -> 0
    expect(count("a.tsx", "function f<T>(lane: T) { return lane }")).toBe(0);
    // a comparison chain that looks like a tag -> 0
    expect(count("a.tsx", "const z = a<b && c>lane;")).toBe(0);
    // a CSS class and grid area -> 0
    expect(count("a.css", ".swim-lane { grid-area: lane; }")).toBe(0);
    // A stylesheet's content: string is drawn on screen, so it counts; url(), class names and comments don't.
    expect(count("a.css", '.x::after { content: "each lane"; }')).toBe(1);
    expect(count("a.css", ".x::before { content: 'a lane' }")).toBe(1);
    expect(count("a.css", '.a { background: url("lane.png"); }')).toBe(0);
    expect(count("a.css", '/* content: "lane" */ .a {}')).toBe(0);
    // a line comment -> 0
    expect(count("a.ts", "// the lane stays empty")).toBe(0);
    // a block comment -> 0
    expect(count("a.ts", "/* a lane here */")).toBe(0);
    // a JSX comment -> 0
    expect(count("a.tsx", "const x = <div>{/* lane */}</div>;")).toBe(0);
    // a Python comment -> 0
    expect(count("a.py", "# lane\n")).toBe(0);
    // a Python function named lane -> 0
    expect(count("a.py", "def lane():\n    pass\n")).toBe(0);
    // a lane name in an f-string replacement field -> 0
    expect(count("a.py", "x = f\"{lane} x\"\n")).toBe(0);
    // a lane in a shell script -> 0
    expect(count("a.sh", "echo \"each lane\"\n")).toBe(0);
  });

  it('does not count GMT or a word that contains the initials', () => {
    expect(count('a.ts', '// 12:00 GMT, GMAIL, aGM')).toBe(0);
  });

  it('counts the initials at an underscore boundary of an uppercase identifier', () => {
    expect(count('a.ts', 'const GM_LINE = "stop";')).toBe(1);
    expect(kinds('a.ts', 'const GM_CARD = "x"; const GM9 = "y";')).toEqual(['gm', 'gm']);
    expect(count('a.ts', 'const MY_GM_CARD = "x";')).toBe(1);
    expect(count('a.ts', 'const A_GM = "x"; const B_GM_2 = "y"; const C_GMS = "z";')).toBe(3);
    expect(count('a.py', 'GM_DIRECTION = "left"\nFOO_GM = 1\n')).toBe(2);
    expect(count('a.sh', 'GM_KINDS="a b"\n')).toBe(1);
    // A bare uppercase GM is still the whole-word match: counted once, never doubled.
    expect(kinds('a.ts', '// GM wants it')).toEqual(['gm']);
    expect(count('a.ts', 'const x = GM;')).toBe(1);
  });

  it('counts the initials at an underscore boundary of a snake_case identifier', () => {
    expect(kinds('a.py', 'def gm_board():\n    pass\n')).toEqual(['gm']);
    expect(count('a.py', 'def test_reads_gms_line():\n    pass\n')).toBe(1);
    expect(count('a.py', 'gm_run = "x"\nfoo_gm = 1\nfoo_gms_2 = 2\n')).toBe(3);
    expect(count('a.ts', 'const reads_gms_line = 1;')).toBe(1);
    // A digit tail still counts: the initials plus a case number are the initials.
    expect(count('a.py', 'ed_gm7run00000001 = "x"\n')).toBe(1);
    expect(count('a.ts', 'const ed_gm7val00000001 = "x";')).toBe(1);
  });

  it('counts the initials at a camelCase hump', () => {
    expect(count('a.ts', 'const gmBoard = 1;')).toBe(1);
    expect(count('a.ts', 'function readsGmsLine() {}')).toBe(1);
    expect(count('a.ts', 'const cursorGm1Node = 1;')).toBe(1);
    expect(count('a.ts', 'const myGm = 1; const myGms = 2;')).toBe(2);
    expect(count('a.ts', 'const GmsLine = 1;')).toBe(1);
  });

  it('counts a $ prefix, a leading underscore before a capital and an acronym hump', () => {
    expect(count('a.sh', 'export $GM_TOKEN=x\nexport $gm_board=y\nexport $gmBoard=z\n')).toBe(3);
    expect(count('a.ts', 'const d = _gmBoard; const e = _gmsLine;')).toBe(2);
    expect(count('a.ts', 'class GMPanel {}\nconst f = readsGMLine; const g = xGM9;')).toBe(3);
    expect(count('a.ts', 'const h = $gmBoard;')).toBe(1);
    // an acronym hump reads as the initials only before a capital-lowercase pair or a digit
    expect(count('a.ts', 'const i = BGMVolume; const j = playBGM;')).toBe(0);
    expect(count('a.ts', 'const k = toGMTString; const l = PNGMeta; const m = aGM; const n = myGM;')).toBe(0);
    // kebab case is not an identifier shape
    expect(count('a.ts', '// gm-board gm-card\nconst el = 1;')).toBe(0);
    expect(count('a.css', '.a { /* gm-board gm-card */ }')).toBe(0);
  });

  it('does not count a bare Gm or Gms standing alone, or the initials inside a string', () => {
    expect(count('a.ts', 'const a = Gm; const b = Gms;')).toBe(0);
    expect(count('a.ts', 'const chords = "Am F C Gm7 Gm";')).toBe(0);
    // string literal text is blanked out: a gm shape inside one never counts
    expect(count('a.ts', 'const s = "aGm3 gms9 gm_board GM_LINE readsGmsLine $GM_TOKEN _gmBoard GMPanel";')).toBe(0);
    expect(count('a.ts', 'const id = \'ed_gm7val00000001\';')).toBe(0);
    expect(count('a.ts', 'const t = `tpl gm_board x`;')).toBe(0);
    expect(count('a.py', 'x = "p_gm mb_gm ed_gm7run"\n')).toBe(0);
    expect(count('a.py', 'cmd = "nebula moodboard show mb_gm"\n')).toBe(0);
    // a shell file has no string spans, so its quotes change nothing
    expect(count('a.sh', 'echo "mb_gm ed_gm7run"\n')).toBe(2);
    // comments are still read
    expect(count('a.ts', '// gm_board readsGmsLine $GM_TOKEN _gmBoard GMPanel')).toBe(5);
  });

  it('does not count the initials inside a word or as a bare lowercase token', () => {
    expect(count('a.ts', 'const s = "segment, pigment, enigma, gmail, gmock";')).toBe(0);
    expect(count('a.ts', 'const gmt = 1; const gmail2 = 2; const gmock = 3;')).toBe(0);
    expect(count('a.ts', 'const FOO_GMT = 1; const A_GMAIL = 2; const aGM = 3;')).toBe(0);
    expect(count('a.ts', 'const myGMT = 1; const aGmail = 2;')).toBe(0);
    expect(count('a.py', 'log_gmtime = 1\nenigma_flag = 2\n')).toBe(0);
    // A bare lowercase gm token and a regex flag string are not identifier shapes.
    expect(count('a.ts', "const flags = 'gm';")).toBe(0);
    expect(count('a.ts', 'const gm = 1; const gms = 2;')).toBe(0);
    expect(count('a.py', 'gm = 1\ndef gm(): pass\n')).toBe(0);
  });

  it('does not count the identifier shapes in a stylesheet or a markdown file', () => {
    expect(count('a.css', '.a { /* GM_LINE gm_board readsGmsLine */ }')).toBe(0);
    expect(count('skills/x/SKILL.md', 'GM_LINE gm_board readsGmsLine cursorGm1\n')).toBe(0);
  });

  it('counts round, review and question ids inside a Python def test_ name', () => {
    expect(kinds('a.py', 'def test_gm_r901_foo():\n    pass\n')).toEqual(['gm', 'round']);
    expect(kinds('a.py', 'def test_r901_foo():\n    pass\n')).toEqual(['round']);
    expect(kinds('a.py', 'def test_r23a_x():\n    pass\n')).toEqual(['round']);
    expect(kinds('a.py', 'def test_r6_N4_a_terminal():\n    pass\n')).toEqual(['round', 'review']);
    expect(kinds('a.py', 'def test_gm_r25_5_copy_names():\n    pass\n')).toEqual(['gm', 'round']);
    expect(kinds('a.py', 'def test_review15_nit4_a_stray():\n    pass\n')).toEqual(['review', 'review']);
    expect(kinds('a.py', 'def test_q4_the_note():\n    pass\n')).toEqual(['question']);
    expect(kinds('a.py', 'def test_round_901_foo():\n    pass\n')).toEqual(['round']);
    expect(kinds('a.py', 'def test_round_901e_foo():\n    pass\n')).toEqual(['round']);
    expect(kinds('a.py', 'def test_review_901_foo():\n    pass\n')).toEqual(['review']);
    expect(kinds('a.py', 'def test_review_rule_901_foo():\n    pass\n')).toEqual(['review']);
    expect(kinds('a.py', 'def test_foo_review_rule():\n    pass\n')).toEqual(['review']);
    expect(kinds('a.py', 'def test_q901_foo():\n    pass\n')).toEqual(['question']);
    expect(kinds('a.py', 'def test_q21b_x():\n    pass\n')).toEqual(['question']);
    expect(kinds('a.py', 'def test_gms_line():\n    pass\n')).toEqual(['gm']);
    expect(kinds('a.py', 'def test_reads_gms_line():\n    pass\n')).toEqual(['gm']);
    expect(kinds('a.py', 'def test_nit1_foo():\n    pass\n')).toEqual(['review']);
    expect(kinds('a.py', 'def test_medium1_foo():\n    pass\n')).toEqual(['review']);
    expect(kinds('a.py', 'def test_lr1_foo():\n    pass\n')).toEqual(['review']);
    expect(kinds('a.py', 'def test_Le_foo():\n    pass\n')).toEqual(['review']);
    expect(kinds('a.py', 'def test_H1_foo():\n    pass\n')).toEqual(['review']);
    // a gm segment is also caught by the identifier rule; the id counts once, not twice
    expect(count('a.py', 'def test_gm_r901_foo():\n    pass\n')).toBe(2);
    expect(count('a.py', 'def test_gm7_x():\n    pass\n')).toBe(1);
    // the same shapes in comments were not already counted, so each name yields one match
    expect(count('a.py', 'def test_review_901_foo():\n    pass\n')).toBe(1);
    // the whole pair id is the match text, not the bare word
    const [r] = scanSource('a.py', 'def test_round_901():\n    pass\n');
    const [v] = scanSource('a.py', 'def test_review_901():\n    pass\n');
    const [w] = scanSource('a.py', 'def test_review_rule_5():\n    pass\n');
    expect(r.match).toBe('round_901');
    expect(v.match).toBe('review_901');
    expect(w.match).toBe('review_rule_5');
  });

  it('counts only the leading run of a def test_ name, so a domain token up front still fires', () => {
    // a leading run of id-shaped segments ends at the first ordinary word; after it only
    // round_N and review_N / review_rule(_N) count
    expect(kinds('a.py', 'def test_the_q901b_foo():\n    pass\n')).toEqual([]);
    expect(kinds('a.py', 'def test_follow_r901_item():\n    pass\n')).toEqual([]);
    expect(kinds('a.py', 'def test_the_LOW4_foo():\n    pass\n')).toEqual([]);
    expect(count('a.py', 'def test_jpeg_q90_output():\n    pass\n')).toBe(0);
    expect(count('a.py', 'def test_deepseek_r1_reply():\n    pass\n')).toBe(0);
    expect(count('a.py', 'def test_runs_on_M4():\n    pass\n')).toBe(0);
    expect(count('a.py', 'def test_the_plan_records_q113():\n    pass\n')).toBe(0);
    expect(count('a.py', 'def test_grace_low1_x():\n    pass\n')).toBe(0);
    // a bare number keeps the run going but is not itself an id
    expect(kinds('a.py', 'def test_r21_3_x():\n    pass\n')).toEqual(['round']);
    // residual collisions, counted on purpose: a domain token as the leading word
    expect(kinds('a.py', 'def test_r2_bucket_upload():\n    pass\n')).toEqual(['round']);
    expect(kinds('a.py', 'def test_L2_norm():\n    pass\n')).toEqual(['review']);
    expect(kinds('a.py', 'def test_q4_k_m_quant():\n    pass\n')).toEqual(['question']);
    expect(kinds('a.py', 'def test_high1_low1_thresholds():\n    pass\n')).toEqual(['review', 'review']);
    // putting a word first is the fix: the domain token falls out of the leading run
    expect(count('a.py', 'def test_cloudflare_r2_bucket_upload():\n    pass\n')).toBe(0);
  });

  it('skips a def test_ name inside a string or a comment and round_N before an arithmetic word', () => {
    expect(count('a.py', 'SRC = """\ndef test_r2_x():\n"""\n')).toBe(0);
    expect(count('a.py', 'x = "def test_q9_y"\n')).toBe(0);
    expect(count('a.py', '# def test_q9_y\nx = 1\n')).toBe(0);
    // a real def on a later line is still read
    expect(kinds('a.py', 'SRC = "a"\ndef test_q9_y():\n    pass\n')).toEqual(['question']);
    // class Test... and def testCamel are out of scope
    expect(count('a.py', 'class TestR901:\n    pass\n')).toBe(0);
    expect(count('a.py', 'def testR901():\n    pass\n')).toBe(0);
    // round_N is skipped when the next segment is an arithmetic word, as in comments
    for (const name of [
      'test_round_2_decimals', 'test_round_2_places', 'test_round_3_digits',
      'test_round_4_dp', 'test_round_2_sig',
    ]) {
      expect(count('a.py', `def ${name}():\n    pass\n`), name).toBe(0);
    }
    expect(kinds('a.py', 'def test_round_2_items():\n    pass\n')).toEqual(['round']);
  });

  it('does not read a domain value or a word in a def test_ name as an id', () => {
    // model and provider versions, node ids, endpoint names and formats stay out
    for (const name of [
      'test_n1_connects', 'test_n2_connects', 'test_v3_database', 'test_v4_generate',
      'test_h3_text_to_video', 'test_v26_endpoint', 'test_t2v_request', 'test_i2v_body',
      'test_s2v_shape', 'test_e2e_generate', 'test_o3_endpoint', 'test_t2_meshy',
      'test_e00_matches_reference', 'test_b64_mime', 'test_m4a_audio', 'test_r2v_endpoint',
      'test_wan26_r2v_video', 'test_f_rest_zero', 'test_qc_node', 'test_vp8l_alpha',
      'test_H264_stream', 'test_H265_stream', 'test_r1234_foo', 'test_q1234_foo',
      'test_L40s_gpu', 'test_jpeg_q90_output', 'test_deepseek_r1_reply',
    ]) {
      expect(count('a.py', `def ${name}():\n    pass\n`), name).toBe(0);
    }
    // bare round / review / rule / answers are English, not ids
    expect(count('a.py', 'def test_round_trip():\n    pass\n')).toBe(0);
    expect(count('a.py', 'def test_the_review_found_this():\n    pass\n')).toBe(0);
    expect(count('a.py', 'def test_the_rule_stands():\n    pass\n')).toBe(0);
    expect(count('a.py', 'def test_the_review_case_62():\n    pass\n')).toBe(0);
    expect(count('a.py', 'def test_reviews_it():\n    pass\n')).toBe(0);
    // a bare single letter, an article and a label letter stay out
    expect(count('a.py', 'def test_a_thing():\n    pass\n')).toBe(0);
    expect(count('a.py', 'def test_c_person_form():\n    pass\n')).toBe(0);
    expect(count('a.py', 'def test_for_A_and_B():\n    pass\n')).toBe(0);
    // an uppercase R901 is not a round id, in a def name either
    expect(count('a.py', 'def test_probe_R901():\n    pass\n')).toBe(0);
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

  it('still sees a comment after a JSX closing tag, a postfix operator or a keyword-named property', () => {
    expect(count('a.tsx', 'const e = <div>a</div>; // Q901')).toBe(1);
    expect(count('a.tsx', 'return <div>{x}</div>; // Q901')).toBe(1);
    expect(count('a.tsx', '</div> // Q901')).toBe(1);
    expect(count('a.tsx', '</b> {/* round 901 */}')).toBe(1);
    expect(count('a.tsx', '<Foo a={1} /> // Q901')).toBe(1);
    expect(count('a.ts', 'x++ / 2; // Q901')).toBe(1);
    expect(count('a.ts', 'x-- / 2; // Q901')).toBe(1);
    expect(count('a.ts', 'const q = obj.in / 2; // Q901')).toBe(1);
    expect(count('a.ts', 'return /a\\/*b/.test(s);\nconst t = "Q901";')).toBe(0);
    expect(count('a.ts', 'const g = x + /\\*\\//; const t = "Q901";')).toBe(0);
    expect(count('a.ts', 'const f = (s) => /\\*\\//.test(s); const t = "Q901";')).toBe(0);
  });

  it('counts "review N" only when what follows reads as an id', () => {
    expect(count('a.ts', '// review 3 items')).toBe(0);
    expect(count('a.ts', '// code review 2 passes')).toBe(0);
    expect(count('a.ts', '// we review 5 files')).toBe(0);
    expect(count('a.ts', '// Review 17, H-1')).toBe(2);
    expect(count('a.ts', '// Review 3 LOW-3')).toBe(2);
    expect(count('a.ts', '// (review 9, LOW-2)')).toBe(2);
    expect(count('a.ts', '// review 901')).toBe(1);
    expect(count('a.ts', '/* review 901 */')).toBe(1);
    expect(count('a.ts', '// review 901 M1')).toBe(1);
    expect(count('a.ts', '// review 901 round 2')).toBe(2);
    expect(count('a.ts', '// review 901: the gap')).toBe(1);
    expect(count('a.ts', '// review 901 of PR #9001')).toBe(1);
    expect(count('a.ts', '// review 901 on #9001')).toBe(1);
    expect(count('a.ts', '// review 3 of the files')).toBe(0);
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

  it('reports the line, column and text of a match', () => {
    const [m] = scanSource('a.ts', 'const a = 1;\n// GM r901 1: gap\n');
    expect(m).toMatchObject({ line: 2, col: 4, kind: 'gm', match: 'GM' });
    expect(m.text).toBe('// GM r901 1: gap');
  });
});

describe('check-internal-ids: ids split across comment lines', () => {
  it('counts an id wrapped across two // lines, on the line where it starts', () => {
    const found = scanSource('a.ts', 'const a = 1;\n// (PR #9001 round\n// 901; the gap)\nconst b = 2;\n');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ line: 2, kind: 'round', match: 'round 901' });
    expect(count('a.ts', '// the fix, review\n// 901 of PR #9001\n')).toBe(1);
    expect(count('a.ts', '  // (Q\n  // 901)\n')).toBe(0); // Q and its number are not an id when split mid-token
  });

  it('counts an id wrapped across two lines of a block, with or without the * prefix', () => {
    expect(count('a.ts', '/*\n * (PR #9001 round\n * 901; the gap)\n */\n')).toBe(1);
    expect(count('a.ts', '/**\n * (PR #9001 round\n   901; the gap)\n */')).toBe(1);
    expect(count('a.css', '/* the gap (PR #9001 round\n   901) */')).toBe(1);
  });

  it('counts an id wrapped across two # lines in Python and in shell', () => {
    expect(count('a.py', 'x = 1\n# (PR #9001 round\n# 901; the gap)\ny = 2\n')).toBe(1);
    expect(count('a.py', '    # (PR #9001 round\n    # 901)\n')).toBe(1);
    expect(count('a.sh', 'echo hi\n# (PR #9001 round\n# 901)\n')).toBe(1);
  });

  it('joins a wrapped trailing comment with the standalone lines that continue it', () => {
    // The first line is a comment after code; the next line holds only a comment, so it continues it.
    expect(count('a.ts', 'const x = 1; // round\n// 901\n')).toBe(1);
    expect(count('a.py', 'x = 1  # round\n# 901\n')).toBe(1);
    // A line with code before its marker never continues a comment above it.
    expect(count('a.ts', '// round\nconst x = 1; // 901\n')).toBe(0);
  });

  it('does not join two comments with a code line or a blank line between them', () => {
    expect(count('a.ts', '// (PR #9001 round\nconst x = 1;\n// 901)\n')).toBe(0);
    expect(count('a.ts', '// (PR #9001 round\n\n// 901)\n')).toBe(0);
    expect(count('a.py', '# (PR #9001 round\nx = 1\n# 901)\n')).toBe(0);
    expect(count('a.ts', '/* round */\n/* 901 */\n')).toBe(0);
  });

  it('counts a split id once, and leaves a run with no id at zero', () => {
    expect(count('a.ts', '// round\n// 901\n// round\n// 902\n')).toBe(2);
    expect(count('a.ts', '// the shot order\n// is kept\n')).toBe(0);
  });

  it('keeps the line-end rules: a review id ending a line still counts beside prose', () => {
    expect(count('a.ts', '// the gap (review 901\n// of the rows)\n')).toBe(1);
    expect(count('a.ts', '// review 901\n// the gap\n')).toBe(1);
    expect(count('a.ts', '// round\n// 3 decimal places\n')).toBe(0); // the arithmetic skip applies to a joined run too
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

describe('check-internal-ids: agent-facing markdown', () => {
  const md = 'skills/x/SKILL.md';

  it('counts ids in a paragraph, a heading, a list item and a table cell', () => {
    expect(kinds(md, 'Round 901b changed the lines.\n')).toEqual(['round']);
    expect(kinds(md, '# Q901 spacing\n')).toEqual(['question']);
    expect(kinds(md, '- see review 901, LOW-1 for it\n')).toEqual(['review', 'review']);
    expect(kinds(md, '| col | note |\n| --- | --- |\n| a | GM r901 |\n')).toEqual(['gm', 'round']);
    expect(kinds(md, '> Q901 a quote\n')).toEqual(['question']);
    expect(kinds(md, 'See [round 901](https://example.com/a) for it.\n')).toEqual(['round']);
  });

  it('does not count round, question or review ids in a fence, a code span or a link target', () => {
    expect(count(md, '```sh\nnebula run --note "round 901 Q901 review 901,"\n```\n')).toBe(0);
    expect(count(md, '~~~\nQ901 r901 LOW-1\n~~~\n')).toBe(0);
    expect(count(md, 'Pass `--round 901` or `Q901` or `review 901,` here.\n')).toBe(0);
    expect(count(md, 'Pass ``a ` Q901 b`` here.\n')).toBe(0);
    expect(count(md, 'See [the page](https://example.com/round-901/Q901/review%20901) now.\n')).toBe(0);
    expect(count(md, '[ref]: https://example.com/Q901 "title"\n')).toBe(0);
  });

  it('counts the text after a fence or code span closes', () => {
    expect(kinds(md, '```\ncode\n```\nRound 901 here\n')).toEqual(['round']);
    expect(kinds(md, 'Run `x` after round 901 ends.\n')).toEqual(['round']);
  });

  it('counts the word lane in prose, not in a code span or a fence', () => {
    expect(kinds(md, 'Give each lane its own cursor.\n')).toEqual(['lane']);
    expect(count(md, 'Pass `--lane 3` to pick it.\n')).toBe(0);
    expect(count(md, '```\nnebula --lane a\n```\n')).toBe(0);
  });

  it('counts the studio initials everywhere, a code fence and a code span included', () => {
    expect(kinds(md, '```\nGM says so\n```\n')).toEqual(['gm']);
    expect(kinds(md, 'Pass `GM` here.\n')).toEqual(['gm']);
  });

  it('reports the line the id is on', () => {
    expect(scanSource(md, 'a\n```\nQ901\n```\nround 901\n').map((m) => m.line)).toEqual([5]);
  });

  it('keeps a stray backtick from pairing across a blank line', () => {
    expect(kinds(md, 'a stray ` tick\n\nnext `code` prose Q901 here `e` end\n')).toEqual(['question']);
    expect(kinds(md, 'a stray ` tick\n  \nnext `code` prose Q901 here `e` end\n')).toEqual(['question']);
  });

  it('keeps a stray backtick from pairing across a fence', () => {
    expect(kinds(md, 'a stray ` tick\n```\nx\n```\nprose Q901 `c` end\n')).toEqual(['question']);
  });

  it('treats an unmatched backtick run as literal text', () => {
    expect(kinds(md, 'use ``` to fence; Q901 prose `x` and more\n')).toEqual(['question']);
  });

  it('treats a line that starts with inline triple backticks as a code span, not a fence', () => {
    expect(kinds(md, '```x``` then Q901 prose\nQ902 next\n')).toEqual(['question', 'question']);
  });

  it('closes a fence only with its own character and at least its own length', () => {
    expect(kinds(md, '```\nQ901\n~~~\nQ902\n```\nQ903 after\n')).toEqual(['question']);
    expect(kinds(md, '~~~\nQ901\n```\nQ902\n~~~\nQ903 after\n')).toEqual(['question']);
    expect(kinds(md, '````\nQ901\n```\nQ902\n````\nQ903 after\n')).toEqual(['question']);
    expect(kinds(md, '```\nQ901\n````\nQ902 after\n')).toEqual(['question']);
    expect(kinds(md, '~~~\nQ901\n~~~```\nround 902\n~~~\nQ903 after\n')).toEqual(['question']);
  });

  it('runs an unclosed fence to the end of the file', () => {
    expect(count(md, 'before\n```\nQ901\nround 902\n')).toBe(0);
  });

  it('blanks a code span across one newline', () => {
    expect(count(md, 'Pass `--a\nQ901` here.\n')).toBe(0);
  });

  it('does not count ids in an autolink or a bare URL', () => {
    expect(count(md, 'See <https://x.test/round-901/Q901/lanes> now.\n')).toBe(0);
    expect(count(md, 'See https://x.test/Q901/lane now.\n')).toBe(0);
    expect(kinds(md, 'See https://x.test/a, then Q901.\n')).toEqual(['question']);
  });

  it('reads only the listed markdown roots', () => {
    expect(isScanned('docs/MCP-SETUP.md')).toBe(true);
    expect(isScanned('skills/nebula/SKILL.md')).toBe(true);
    expect(isScanned('skills/nebula/references/a.md')).toBe(true);
    expect(isScanned('.agents/skills/krea/SKILL.md')).toBe(true);
    expect(isScanned('docs/OTHER.md')).toBe(false);
    expect(isScanned('README.md')).toBe(false);
    expect(isScanned('.planning/a.md')).toBe(false);
    expect(isScanned('frontend/src/a.md')).toBe(false);
  });
});

describe('check-internal-ids: baseline', () => {
  const matches = { 'a.ts': [{ line: 3, col: 4, text: '// GM wants it', kind: 'gm', match: 'GM' }] };

  it('fails when a count rises, naming file:line:col, the match and the text', () => {
    const { failures } = compareToBaseline({ 'a.ts': 2 }, matches, { 'a.ts': 1 });
    expect(failures).toHaveLength(1);
    expect(failures[0].lines[0]).toContain('a.ts:3:4');
    expect(failures[0].lines[0]).toContain('[gm "GM"]');
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
    expect(moveAllowance({ 'a.ts': 5 }, { 'b.ts': 2 }, 'a.ts', 'b.ts')).toEqual({ 'a.ts': 3, 'b.ts': 2 });
    expect(moveAllowance({ 'a.ts': 5 }, { 'a.ts': 3, 'b.ts': 2 }, 'a.ts', 'b.ts')).toEqual({ 'a.ts': 3, 'b.ts': 2 });
    expect(() => moveAllowance({ 'a.ts': 2 }, {}, 'x.ts', 'b.ts')).toThrow(/not in the baseline/);
  });

  it('moveAllowance splits one gone file into two new files across two moves', () => {
    const counts = { 'b.ts': 2, 'c.ts': 3 };
    const first = moveAllowance({ 'a.ts': 5 }, counts, 'a.ts', 'b.ts');
    expect(first).toEqual({ 'a.ts': 3, 'b.ts': 2 });
    const second = moveAllowance(first, counts, 'a.ts', 'c.ts');
    expect(second).toEqual({ 'b.ts': 2, 'c.ts': 3 });
    expect(compareToBaseline(counts, {}, second).failures).toEqual([]);
  });

  it('the move hint names only sources that are gone from the tree', () => {
    const counts = { 'new.ts': 2 };
    const present = compareToBaseline(counts, { 'new.ts': [] }, { 'x.ts': 10 });
    expect(present.failures[0].hint).toContain('move of x.ts');
    const kept = compareToBaseline({ ...counts, 'x.ts': 1 }, { 'new.ts': [] }, { 'x.ts': 10 });
    expect(kept.failures[0].hint).toBeUndefined();
  });

  it('compareWithMain with a merge base: behind main passes, a real raise fails, a move passes', () => {
    const base = { 'a.ts': 3, 'z.ts': 1 };
    const main = { 'a.ts': 1 };
    expect(compareWithMain(base, main, base)).toEqual([]);
    expect(compareWithMain({ 'a.ts': 4, 'z.ts': 1 }, main, base)).toHaveLength(1);
    expect(compareWithMain({ ...base, 'y.ts': 1 }, main, base)).toHaveLength(1);
    // a move: z.ts gone, y.ts takes its allowance
    expect(compareWithMain({ 'a.ts': 3, 'y.ts': 1 }, main, base)).toEqual([]);
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
    expect(r.out).toContain('grid-area');
  });

  it('reads the listed markdown roots in a tree without git', () => {
    write('docs/MCP-SETUP.md', 'GM wants it.\n');
    write('skills/nebula/SKILL.md', 'fine\n');
    write('docs/OTHER.md', 'GM wants it.\n');
    write('.agents/skills/k/SKILL.md', 'GM too.\n');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('docs/MCP-SETUP.md:1');
    expect(r.out).toContain('.agents/skills/k/SKILL.md:1');
    expect(r.out).not.toContain('docs/OTHER.md');
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

  const gitIn = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t.test', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

  it('a branch that is behind main and never touched the baseline passes; a real raise fails', () => {
    write('frontend/src/z.ts', '// GM z\n');
    writeFileSync(baselineFile(), JSON.stringify({ 'frontend/src/a.ts': 2, 'frontend/src/z.ts': 1 }));
    gitIn(root, 'init', '-q', '-b', 'main');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'base');
    gitIn(root, 'checkout', '-qb', 'feat');
    // main lowers a.ts and deletes z.ts
    gitIn(root, 'checkout', '-q', 'main');
    write('frontend/src/a.ts', '// GM one\n');
    rmSync(join(root, 'frontend/src/z.ts'));
    writeFileSync(baselineFile(), JSON.stringify({ 'frontend/src/a.ts': 1 }));
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'main lowers');
    gitIn(root, 'update-ref', 'refs/remotes/origin/main', 'main');
    gitIn(root, 'checkout', '-q', 'feat');
    expect(run().code).toBe(0);
    writeFileSync(baselineFile(), JSON.stringify({ 'frontend/src/a.ts': 3, 'frontend/src/z.ts': 1 }));
    write('frontend/src/a.ts', '// GM one\n// GM two\n// GM three\n');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('baseline 3 is above');
  });

  it('a shallow checkout without its parent fetched compares with main', () => {
    gitIn(root, 'init', '-q', '-b', 'main');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'base');
    gitIn(root, 'checkout', '-qb', 'feat');
    writeFileSync(baselineFile(), JSON.stringify({ 'frontend/src/a.ts': 3 }));
    write('frontend/src/a.ts', '// GM one\n// GM two\n// GM three\n');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'feat raises');
    const shallow = join(root, 'shallow');
    gitIn(root, 'clone', '-q', '--depth', '1', '--branch', 'feat', `file://${root}`, shallow);
    gitIn(shallow, 'fetch', '-q', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    let code = 0;
    let out = '';
    try {
      execFileSync('node', [script, '--root', shallow], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      code = err.status;
      out = `${err.stdout}${err.stderr}`;
    }
    expect(code).toBe(1);
    expect(out).toContain('baseline 3 is above');
  });

  it('a shallow merge ref made on an older main compares with the commit it sits on, as CI does', () => {
    // The merge ref sits on main as it stood when it was made; main then lowers a.ts before lint
    // fetches it. Only a raise on the branch itself may fail.
    gitIn(root, 'init', '-q', '-b', 'main');
    gitIn(root, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'base');
    const oldMain = gitIn(root, 'rev-parse', 'HEAD').trim();
    gitIn(root, 'checkout', '-qb', 'quiet');
    write('frontend/src/c.txt', 'no ids\n');
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'quiet branch');
    gitIn(root, 'checkout', '-q', '-b', 'raise', oldMain);
    write('frontend/src/a.ts', '// GM one\n// GM two\n// GM three\n');
    writeFileSync(baselineFile(), JSON.stringify({ 'frontend/src/a.ts': 3 }));
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'raising branch');
    for (const [n, branch] of [['1', 'quiet'], ['2', 'raise']]) {
      gitIn(root, 'checkout', '-q', '--detach', oldMain);
      gitIn(root, 'merge', '-q', '--no-ff', '-m', `merge ${branch}`, branch);
      gitIn(root, 'update-ref', `refs/pull/${n}/merge`, 'HEAD');
    }
    gitIn(root, 'checkout', '-q', 'main');
    write('frontend/src/a.ts', '// GM one\n');
    writeFileSync(baselineFile(), JSON.stringify({ 'frontend/src/a.ts': 1 }));
    gitIn(root, 'add', '-A');
    gitIn(root, 'commit', '-qm', 'main lowers');

    const checkout = (n: string, withParent: boolean) => {
      const dir = join(root, `pull-${n}-${withParent ? 'parent' : 'main'}`);
      mkdirSync(dir);
      gitIn(dir, 'init', '-q');
      gitIn(dir, 'remote', 'add', 'origin', `file://${root}`);
      gitIn(dir, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', `+refs/pull/${n}/merge:refs/remotes/pull/${n}/merge`);
      gitIn(dir, 'checkout', '-q', '--force', `refs/remotes/pull/${n}/merge`);
      const parent = /^parent ([0-9a-f]+)$/m.exec(gitIn(dir, 'cat-file', 'commit', 'HEAD'))?.[1] ?? '';
      expect(parent).toBe(oldMain);
      const refs = ['+refs/heads/main:refs/remotes/origin/main', ...(withParent ? [parent] : [])];
      gitIn(dir, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', ...refs);
      return dir;
    };
    const check = (dir: string) => {
      try {
        execFileSync('node', [script, '--root', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, out: '' };
      } catch (e) {
        const err = e as { status: number; stdout: string; stderr: string };
        return { code: err.status, out: `${err.stdout}${err.stderr}` };
      }
    };

    // With only main fetched, main's later lowering reads as the branch's raise.
    const stale = check(checkout('1', false));
    expect(stale.code).toBe(1);
    expect(stale.out).toContain("frontend/src/a.ts: baseline 2 is above main's 1");
    // With the first parent fetched too, the quiet branch passes and the raise still fails.
    expect(check(checkout('1', true)).code).toBe(0);
    const raised = check(checkout('2', true));
    expect(raised.code).toBe(1);
    expect(raised.out).toContain("frontend/src/a.ts: baseline 3 is above the merge base's 2");
  });

  it('--write-baseline with --move is refused', () => {
    const r = run('--write-baseline', '--move', 'frontend/src/a.ts', 'frontend/src/b.ts');
    expect(r.code).toBe(1);
    expect(r.out).toContain('cannot be combined');
    expect(baseline()).toEqual({ 'frontend/src/a.ts': 2 });
  });

  it('--move writes only when the check then passes, and one call can split a gone file', () => {
    write('frontend/src/a.ts', '// GM 1\n// GM 2\n// GM 3\n// GM 4\n// GM 5\n');
    writeFileSync(baselineFile(), JSON.stringify({ 'frontend/src/a.ts': 5 }));
    rmSync(join(root, 'frontend/src/a.ts'));
    write('frontend/src/b.ts', '// GM 1\n// GM 2\n');
    write('frontend/src/c.ts', '// GM 1\n// GM 2\n// GM 3\n');
    const half = run('--move', 'frontend/src/a.ts', 'frontend/src/b.ts');
    expect(half.code).toBe(1);
    expect(half.out).toContain('baseline was not written');
    expect(baseline()).toEqual({ 'frontend/src/a.ts': 5 });
    const both = run('--move', 'frontend/src/a.ts', 'frontend/src/b.ts', '--move', 'frontend/src/a.ts', 'frontend/src/c.ts');
    expect(both.code).toBe(0);
    expect(baseline()).toEqual({ 'frontend/src/b.ts': 2, 'frontend/src/c.ts': 3 });
  });

  it('--move drops what a gone file had left after a split', () => {
    writeFileSync(baselineFile(), JSON.stringify({ 'frontend/src/a.ts': 7 }));
    rmSync(join(root, 'frontend/src/a.ts'));
    write('frontend/src/b.ts', '// GM 1\n// GM 2\n');
    write('frontend/src/c.ts', '// GM 1\n// GM 2\n// GM 3\n');
    const r = run('--move', 'frontend/src/a.ts', 'frontend/src/b.ts', '--move', 'frontend/src/a.ts', 'frontend/src/c.ts');
    expect(r.code).toBe(0);
    expect(baseline()).toEqual({ 'frontend/src/b.ts': 2, 'frontend/src/c.ts': 3 });
  });
});
