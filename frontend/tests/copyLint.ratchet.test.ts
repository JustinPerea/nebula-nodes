// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildContext, check, compare, decodeEntities, extractStrings, loadRules, readBaseline, readMarkers, scan, seed, shrink,
  sortEntries, writeBaselineFile,
} from '../scripts/copy-lint-core.mjs';

/**
 * The copy lint (npm run check:copy): rules, which strings it reads, the markers that exempt a line,
 * the baseline that only shrinks, and the ratchet that fails on a violation the baseline doesn't list.
 * The backend half is backend/tests/test_copy_lint.py; both run scripts/copy-lint-cases.json.
 */
const rules = loadRules();
const ctx = buildContext(rules);
const CASES = JSON.parse(readFileSync(path.join(__dirname, '..', '..', 'scripts', 'copy-lint-cases.json'), 'utf8')).cases as
  { text: string; kind: string; rules: string[] }[];

const tmp = mkdtempSync(path.join(tmpdir(), 'copy-lint-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('the rules', () => {
  it('every shared case gives the rules it lists', () => {
    for (const c of CASES) expect(check(c.text, c.kind, ctx), JSON.stringify(c.text)).toEqual(c.rules);
  });

  it.each(Object.keys(rules.rules))('%s has a failing and a passing example in the shared cases', (rule) => {
    expect(CASES.some((c) => c.rules.includes(rule)), `no failing case for ${rule}`).toBe(true);
    expect(CASES.some((c) => !c.rules.includes(rule) && c.text.length > 0), `no passing case for ${rule}`).toBe(true);
  });

  it('every rule the check can return is named in the rules file, with the line it says', () => {
    const named = new Set(Object.keys(rules.rules));
    for (const c of CASES) for (const rule of check(c.text, c.kind, ctx)) expect(named.has(rule)).toBe(true);
    for (const wants of Object.values(rules.rules)) expect(typeof wants === 'string' && wants.length > 10).toBe(true);
  });

  it('a model or provider name from the catalogues is not Title Case', () => {
    // Nano Banana and Veo are named in the rules file; ElevenLabs Music comes from the node catalogue.
    expect(check('Open Nano Banana Pro', 'text', ctx)).toEqual([]);
    expect(check('Switch to ElevenLabs Music', 'text', ctx)).toEqual([]);
    expect(check('Switch To ElevenLabs Music', 'text', ctx)).toEqual(['title-case']);
  });

  it('an entity in JSX text reads as the character it draws', () => {
    expect(decodeEntities('Nebula&rsquo;s &ldquo;own&rdquo; &mdash; &#8230;')).toBe('Nebula’s “own” — …');
  });
});

describe('which strings are read', () => {
  const read = (source: string, file = 'src/components/Sample.tsx') => extractStrings(source, file, rules).map((s) => [s.text, s.source, s.line]);

  it('reads JSX text, the title, aria-label, placeholder, alt and label attributes, and named properties', () => {
    const out = read(`
      export const A = () => <div title="Hello there" aria-label={\`Open \${x}\`} placeholder='Type here' alt="A cat" className="a b">
        Some text here
        <Field label="Seed" />
      </div>;
      export const D = { label: 'Seed', hint: cond ? 'One thing' : 'Two things', other: 'Not read here', description: 'a ' + b + ' c' };
    `);
    expect(out.map((r) => r[0])).toEqual([
      'Hello there', 'Open {}', 'Type here', 'A cat', 'Some text here', 'Seed',
      'Seed', 'One thing', 'Two things', 'a {} c',
    ]);
  });

  it('reads string, template and choice expressions that are JSX children', () => {
    const out = read(`
      export const A = () => <div>
        <p>{"Can't one"}</p>
        <p>{ok ? "Can't two" : "x y"}</p>
        <p>{\`\${n} couldn't three\`}</p>
        <p>{a || "Can't four"}{b ?? "Can't five"}{c && "Can't six"}{"Can't " + seven}</p>
      </div>;`);
    expect(out.map((r) => r[0])).toEqual([
      "Can't one", "Can't two", 'x y', "{} couldn't three", "Can't four", "Can't five", "Can't six", "Can't {}",
    ]);
  });

  it('reads the label-like names as JSX attributes, and a message prop only when it is a literal or template', () => {
    const out = read(`
      export const A = () => <div>
        <Empty description="Can't a" hint="Can't b" tooltip={\`Can't \${c}\`} emptyText="Can't d" message="Can't e" />
        <Empty message={text} />
        <Empty message={ok ? "Can't f" : "g h"} />
      </div>;
      export const O = { message: "Can't as a property" };`);
    expect(out.map((r) => r[0])).toEqual(["Can't a", "Can't b", "Can't {}", "Can't d", "Can't e"]);
  });

  it('reads a string or template inside a template substitution, for the straight apostrophe only', () => {
    const out = read(`
      export const A = () => <div title={\`Open \${open ? "it's" : ''}\`}>
        {\`\${n} items \${ok ? \`don't\` : 'fine'}\`}
      </div>;
      export const O = { label: \`Say \${a ? "can't" : 'can'}\` };`);
    expect(out.map((r) => r[0])).toEqual(['Open {}', "it's", '{} items {}', "don't", 'fine', 'Say {}', "can't", 'can']);
    const dir = path.join(tmp, 'nested');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'n.tsx'), "export const A = (open: boolean) => <p title={`Open ${open ? \"it's\" : 'Closed Tab'}.`}>x y</p>;\n");
    const found = scan({ frontend: dir, rules, ctx }).violations.filter((v) => v.file.endsWith('n.tsx'));
    // The nested "it's" breaks the straight-apostrophe rule; its sibling "Closed Tab" is judged only as part of the whole line.
    expect(found.map((v) => [v.rule, v.text])).toEqual([['straight-quote', "it's"]]);
  });

  it('reads the quasis of a template literal in a copy position for the straight apostrophe', () => {
    const modules = { ...rules, frontend: { ...rules.frontend, copyModules: ['src/lib/fakeCopy.ts'] } };
    const lib = extractStrings("export const f = (a: string) => `Nebula couldn't ${a} here.`;", 'src/lib/fakeCopy.ts', modules);
    expect(lib.map((s) => check(s.raw, s.kind, ctx))).toEqual([['straight-quote']]);
    const attr = read("export const A = () => <p aria-label={`It's ${x} now`}>y</p>;");
    expect(attr.map((r) => r[0])).toEqual(["It's {} now", 'y']);
    expect(check("It's {} now", 'label', ctx)).toContain('straight-quote');
    expect(check('It’s {} now', 'text', ctx)).not.toContain('straight-quote');
  });

  it('resolves an identifier to a const string in the same file and reads the string argument of a call', () => {
    const out = read(`
      const MSG = "Can't one";
      const OTHER = cond ? "Can't two" : "x y";
      export const A = () => <div><p>{MSG}</p><Field label={OTHER} hint={t("Can't three")} /></div>;
      export const O = { label: t("Can't four"), title: MSG, hint: imported };`);
    expect(out.map((r) => r[0]).sort()).toEqual(["Can't four", "Can't one", "Can't three", "Can't two", 'x y']);
  });

  it('fails on a file it cannot parse, naming the file', () => {
    expect(() => extractStrings('export const = ;', 'src/Broken.tsx', rules)).toThrow(/src\/Broken\.tsx/);
  });

  it('reads every prose string in a copy module and skips comparisons, errors, logs, regexes and imports', () => {
    const modules = { ...rules, frontend: { ...rules.frontend, copyModules: ['src/lib/fakeCopy.ts'] } };
    const source = `
      import x from 'some thing here';
      export const LINE = 'Nothing ran here.';
      export function f(a: string) {
        if (a === 'two words') return 1;
        console.log('debug text here');
        throw new Error('Developer text here');
        const r = /a b/.test('x y z');
        return \`Reloaded \${a}.\`;
      }`;
    expect(extractStrings(source, 'src/lib/fakeCopy.ts', modules).map((s) => s.text)).toEqual(['Nothing ran here.', 'Reloaded {}.']);
    expect(extractStrings(source, 'src/lib/other.ts', modules)).toEqual([]);
  });

  it('skips test files, the agent-only file and dev surfaces when scanning a tree', () => {
    const root = path.join(tmp, 'tree');
    mkdirSync(path.join(root, 'src', 'components', 'brand'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
    const bad = "export const X = () => <p>Can't do it.</p>;\n";
    writeFileSync(path.join(root, 'src', 'a.tsx'), bad);
    writeFileSync(path.join(root, 'src', 'a.test.tsx'), bad);
    writeFileSync(path.join(root, 'src', 'components', 'brand', 'Show.tsx'), bad);
    writeFileSync(path.join(root, 'src', 'lib', 'wsClient.ts'), "export const L = { label: \"It's an agent line\" };\n");
    const { violations } = scan({ frontend: root, rules, ctx });
    expect(violations.map((v: { file: string }) => v.file)).toEqual(['frontend/src/a.tsx']);
  });
});

describe('markers', () => {
  it('exempts the marked line, the line below a marker alone, and a block; a marker needs a reason', () => {
    const source = [
      "const a = <p>Can't one</p>; // copy-lint-ignore: shows the literal character",
      '// copy-lint-ignore: agent line',
      "const b = <p>Can't two</p>;",
      "const c = <p>Can't three</p>;",
      '// copy-lint-ignore-start: a block of agent lines',
      "const d = <p>Can't four</p>;",
      "const e = <p>Can't five</p>;",
      '// copy-lint-ignore-end',
      '// copy-lint-ignore',
    ].join('\n');
    const { exempt, markers } = readMarkers(source);
    expect([...exempt].sort((x: number, y: number) => x - y)).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10]);
    expect(markers.filter((m: { ok: boolean }) => !m.ok).map((m: { line: number }) => m.line)).toEqual([9]);
  });

  it('a marked string is left out of the scan, and a marker with no reason is reported', () => {
    const root = path.join(tmp, 'marked');
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'm.tsx'), [
      "export const A = () => <p>Can't one</p>; // copy-lint-ignore: agent line",
      "export const B = () => <p>Can't two</p>;",
      "export const C = () => <p>Can't three</p>; // copy-lint-ignore",
    ].join('\n'));
    const { violations, markers } = scan({ frontend: root, rules, ctx });
    expect(violations.map((v: { text: string }) => v.text)).toEqual(["Can't two"]);
    expect(markers.filter((m: { ok: boolean }) => !m.ok)).toHaveLength(1);
  });
});

describe('the baseline only shrinks', () => {
  const v = (text: string, line = 1, rule = 'straight-quote', file = 'frontend/src/a.tsx') => ({ file, line, rule, text });
  const entry = (text: string, count?: number, rule = 'straight-quote') =>
    ({ family: 'straight-quotes', file: 'frontend/src/a.tsx', rule, text, ...(count ? { count } : {}) });

  it('a violation the baseline lacks is new, and a repeat beyond its count is new', () => {
    const baseline = { entries: [entry("Can't", 2)] };
    expect(compare([v("Can't"), v("Can't", 5)], baseline).fresh).toEqual([]);
    const over = compare([v("Can't"), v("Can't", 5), v("Can't", 9)], baseline);
    expect(over.fresh.map((f: { extra: number }) => f.extra)).toEqual([1]);
    expect(compare([v("Won't")], baseline).fresh.map((f: { text: string }) => f.text)).toEqual(["Won't"]);
  });

  it('a line number change does not break an entry (the key is file, rule and text)', () => {
    const baseline = { entries: [entry("Can't")] };
    const { fresh, stale } = compare([v("Can't", 400)], baseline);
    expect(fresh).toEqual([]);
    expect(stale).toEqual([]);
  });

  it('an entry that matches nothing, or fewer than its count, is stale', () => {
    const baseline = { entries: [entry("Can't", 2), entry('Gone')] };
    const { stale } = compare([v("Can't")], baseline);
    expect(stale.map((s: { text: string; have: number }) => [s.text, s.have])).toEqual([["Can't", 1], ['Gone', 0]]);
  });

  it('--write-baseline drops fixed entries and lowers counts, and adds or raises nothing', () => {
    const baseline = { entries: [entry("Can't", 3), entry('Gone'), entry('Same')] };
    const today = [v("Can't"), v("Can't", 2), v('Same'), v('Brand new'), v('Same', 7), v('Same', 8)];
    const kept = sortEntries(shrink(today, baseline)).map((e: { text: string; count: number }) => [e.text, e.count]);
    expect(kept).toEqual([["Can't", 2], ['Same', 1]]);
    expect(kept.some(([t]: [string, number]) => t === 'Brand new' || t === 'Gone')).toBe(false);
  });

  it('writing the shrunk baseline to disk keeps the family and sorts the entries', () => {
    const file = path.join(tmp, 'baseline.json');
    writeBaselineFile([entry('b'), entry('a', 2)], file);
    const back = readBaseline(file);
    expect(back.entries.map((e: { text: string }) => e.text)).toEqual(['a', 'b']);
    expect(back.entries[0]).toEqual({ family: 'straight-quotes', file: 'frontend/src/a.tsx', rule: 'straight-quote', text: 'a', count: 2 });
  });

  it('seeding refuses when a baseline with entries exists', () => {
    expect(() => seed([v('x')], { entries: [entry('y')] })).toThrow(/hand edit/);
    expect(seed([v('x')], { entries: [] })).toHaveLength(1);
  });
});

describe('the repo', () => {
  it('has no copy violation the baseline lacks, and no baseline entry that matches nothing', () => {
    const { violations, markers } = scan();
    const { fresh, stale } = compare(violations, readBaseline());
    expect(fresh.map((f: { file: string; lines: number[]; text: string }) => `${f.file}:${f.lines[0]} ${f.text}`)).toEqual([]);
    expect(stale.map((s: { file: string; text: string }) => `${s.file} ${s.text}`)).toEqual([]);
    expect(markers.filter((m: { ok: boolean }) => !m.ok)).toEqual([]);
    // The scan parses every source file. It takes under a second alone and several seconds beside
    // the rest of a CI shard, so it gets its own limit.
  }, 120_000);

  it('every baseline entry names a family and a rule the rules file knows', () => {
    for (const e of readBaseline().entries) {
      expect(typeof e.family === 'string' && e.family.length > 0).toBe(true);
      expect(Object.keys(rules.rules)).toContain(e.rule);
    }
  });
});
