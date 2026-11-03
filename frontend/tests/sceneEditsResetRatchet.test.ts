// fix/ci-flakes-rename-fix16: a Cinema scene deleted while the person's edits
// to it weren't saved keeps those edits (graphStore deletedSceneEdits, GM r20
// answer 3) for when the node comes back on the same canvas. Tests reuse ids
// (n1) on one canvas, so the next test's n1 took them back as a delete undone
// and saved them: in CI that save took graphStore.fix16's queued 400. The
// edits are kept by three routes: the person's delete, a sync that takes the
// card off, and a save answered 404 (PR #221 review 1 MEDIUM-1: fix5's 404
// test leaked that way with no delete in the file). So the rule is
// structural, not about deletes: every test file that uses Cinema scenes with
// the graph store resets the store's per-node state after each test with
// resetDeletedSceneEditsForTests (idempotent and cheap).
//
// The check, read from each test file's syntax tree (review 1 LOW-2, NIT-1),
// so comments and strings never count as code:
// - A file counts when it has the string 'cinema-scene' in code and takes
//   the graph store (any non-type import, export, `import(…)`,
//   vi.importActual or require of a module /(^|\/)graphStore(\.[jt]sx?)?$/).
// - Every it or test in it (it.each, it.skip, test.only and so on) must sit
//   in the file, or in a describe, whose own body calls afterEach with the
//   reset: `afterEach(resetDeletedSceneEditsForTests)`,
//   `afterEach(store.resetDeletedSceneEditsForTests)`, or a callback that
//   calls it, alone or among other calls (any further argument is fine). A
//   bare name counts only as the graph store's own export, imported (or
//   destructured from `await import(…)`) once and never shadowed; a property
//   counts on any receiver.
// - Exempt: a file whose vi.mock or vi.doMock of the graph store replaces it
//   whole (no importOriginal, no importActual). Opt-out: a comment
//   `scene-edits-reset: off, <reason>` (at least 10 characters) for a file
//   that truly can't leak.
//
// Known gaps: a call in dead code inside the afterEach still counts; a file
// that reaches the graph store only through another module (a component it
// renders) with no import of its own isn't counted.
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { allTestFiles, calleeName, isFunctionLike, mayHold, moduleUse, optedOut, parse, rootName, some, unwrap } from './helpers/ratchetSource';

const STORE = /(^|\/)graphStore(\.[jt]sx?)?$/;
const RESET = 'resetDeletedSceneEditsForTests';
const TOKENS = ['cinema-scene'];

function readFile(source: string, fileName?: string) {
  const file = parse(source, fileName);
  const usesScenes = some(file, (node) => ts.isStringLiteralLike(node) && node.text === 'cinema-scene');
  const store = moduleUse(file, STORE);
  if (!usesScenes || !store.takes || store.fullMock) return { applies: false, uncovered: [] as string[] };

  const isReset = (node: ts.Expression) => {
    const target = unwrap(node);
    if (ts.isPropertyAccessExpression(target)) return target.name.text === RESET;
    return ts.isIdentifier(target) && store.isExport(target.text, RESET);
  };
  const resets = (hook: ts.Expression | undefined) => {
    if (!hook) return false;
    if (isReset(hook)) return true;
    return isFunctionLike(hook) && some(hook.body, (node) => ts.isCallExpression(node) && isReset(node.expression));
  };
  /** Whether a scope's own statements register the reset after each test. */
  const resetsAfterEach = (statements: readonly ts.Statement[]) => statements.some((statement) => {
    if (!ts.isExpressionStatement(statement)) return false;
    const call = unwrap(statement.expression);
    return ts.isCallExpression(call) && calleeName(call) === 'afterEach' && rootName(call.expression) === 'afterEach' && resets(call.arguments[0]);
  });

  const uncovered: string[] = [];
  const visit = (node: ts.Node, covered: boolean) => {
    if (ts.isCallExpression(node)) {
      const root = rootName(node.expression);
      if (root === 'describe' || root === 'suite') {
        const body = node.arguments.find(isFunctionLike);
        for (const argument of node.arguments) if (argument !== body) visit(argument, covered);
        if (body) {
          const own = ts.isBlock(body.body) && resetsAfterEach(body.body.statements);
          visit(body.body, covered || own);
        }
        return;
      }
      if ((root === 'it' || root === 'test') && !covered) {
        const name = node.arguments[0];
        uncovered.push(name && ts.isStringLiteralLike(name) ? name.text : node.getText(file).slice(0, 40));
      }
    }
    ts.forEachChild(node, (child) => visit(child, covered));
  };
  visit(file, resetsAfterEach(file.statements));
  // The opt-out is read last: it walks every comment, and most files never need it.
  if (uncovered.length > 0 && optedOut(file, 'scene-edits-reset')) return { applies: false, uncovered: [] as string[] };
  return { applies: true, uncovered };
}

const leaking = (source: string, fileName?: string) => mayHold(source, TOKENS) && readFile(source, fileName).uncovered.length > 0;

const SCENE = "const node = { data: { definitionId: 'cinema-scene' } };\n";
const STATIC = "import { useGraphStore, resetDeletedSceneEditsForTests } from '../src/store/graphStore';\n";
const NAMESPACE = "const store = await import('../../src/store/graphStore');\n";
const TEST = "it('saves', async () => { useGraphStore.getState().updateNodeData('n1', {}); });\n";

describe('the ratchet reads the forms (mutation cases: each must be caught)', () => {
  const caught: Array<[string, string]> = [
    ['no reset at all', `${STATIC}${SCENE}${TEST}`],
    // Review 1 MEDIUM-1: a 404 keeps the edits with no delete in the file.
    ['a save answered 404, no delete in the file', `${NAMESPACE}${SCENE}it('404', async () => { fetchMock.mockResolvedValue(json({ detail: "That node isn't on the canvas anymore." }, 404)); });\n`],
    // Review 1 LOW-2: a comment or a string is not a hook.
    ['the reset only in a line comment', `${STATIC}${SCENE}// afterEach(() => resetDeletedSceneEditsForTests());\n${TEST}`],
    ['the reset only in a block comment', `${STATIC}${SCENE}/* afterEach(() => resetDeletedSceneEditsForTests()); */\n${TEST}`],
    ['the reset only in a string', `${STATIC}${SCENE}const why = 'afterEach(() => resetDeletedSceneEditsForTests())';\n${TEST}`],
    ['the reset in beforeAll (once, not after each)', `${STATIC}${SCENE}beforeAll(() => resetDeletedSceneEditsForTests());\n${TEST}`],
    ['the reset in afterAll', `${STATIC}${SCENE}afterAll(resetDeletedSceneEditsForTests);\n${TEST}`],
    ['the reset only inside a test', `${STATIC}${SCENE}it('x', () => { resetDeletedSceneEditsForTests(); });\n${TEST}`],
    ['the reset named but never called', `${STATIC}${SCENE}afterEach(() => { void resetDeletedSceneEditsForTests; });\n${TEST}`],
    ['a local function with the same name', `${NAMESPACE}${SCENE}const resetDeletedSceneEditsForTests = () => {};\nafterEach(resetDeletedSceneEditsForTests);\n${TEST}`],
    ['the reset in one describe, a test outside it', `${STATIC}${SCENE}describe('a', () => { afterEach(resetDeletedSceneEditsForTests); ${TEST} });\n${TEST}`],
    ['the reset in a sibling describe', `${STATIC}${SCENE}describe('a', () => { afterEach(resetDeletedSceneEditsForTests); });\ndescribe('b', () => { ${TEST} });`],
    ['an it.each outside the reset', `${STATIC}${SCENE}it.each([1, 2])('n %s', () => {});\n`],
    ['a partial mock is still the real store', `vi.mock('../src/store/graphStore', async (importOriginal) => ({ ...await importOriginal() }));\n${STATIC}${SCENE}${TEST}`],
    ['the store through vi.importActual', `const store = await vi.importActual('../src/store/graphStore');\n${SCENE}${TEST}`],
    ['an opt-out with no reason', `// scene-edits-reset: off\n${STATIC}${SCENE}${TEST}`],
    ['an opt-out only in a template', `${STATIC}${SCENE}const t = \`// scene-edits-reset: off, only a template literal here\`;\n${TEST}`],
    ['a unicode escape in the scene id', `${STATIC}const node = { data: { definitionId: 'cinema-sc\\u0065ne' } };\n${TEST}`],
  ];
  it.each(caught)('%s', (_, source) => {
    expect(leaking(source)).toBe(true);
  });
  it('the prefilter lets every caught form through', () => {
    expect(caught.filter(([, source]) => !mayHold(source, TOKENS)).map(([name]) => name)).toEqual([]);
    expect(mayHold("import { useGraphStore } from '../src/store/graphStore';", TOKENS)).toBe(false);
  });

  const passes: Array<[string, string]> = [
    ['afterEach(() => resetDeletedSceneEditsForTests())', `${STATIC}${SCENE}afterEach(() => resetDeletedSceneEditsForTests());\n${TEST}`],
    ['afterEach(() => store.resetDeletedSceneEditsForTests())', `${NAMESPACE}${SCENE}afterEach(() => store.resetDeletedSceneEditsForTests());\n${TEST}`],
    // Review 1 NIT-1: the forms that false-failed.
    ['afterEach(resetDeletedSceneEditsForTests)', `${STATIC}${SCENE}afterEach(resetDeletedSceneEditsForTests);\n${TEST}`],
    ['afterEach(store.resetDeletedSceneEditsForTests)', `${NAMESPACE}${SCENE}afterEach(store.resetDeletedSceneEditsForTests);\n${TEST}`],
    ['the reset after another call in one afterEach block', `${NAMESPACE}${SCENE}afterEach(() => { store.setSceneQuietRetryForTests(null); store.resetDeletedSceneEditsForTests(); });\n${TEST}`],
    ['a destructured dynamic import', `const { useGraphStore, resetDeletedSceneEditsForTests } = await import('../../src/store/graphStore');\n${SCENE}afterEach(() => resetDeletedSceneEditsForTests());\n${TEST}`],
    ['destructured from the store namespace', `${NAMESPACE}const { resetDeletedSceneEditsForTests } = store;\n${SCENE}afterEach(() => resetDeletedSceneEditsForTests());\n${TEST}`],
    ['a renamed import', `import { resetDeletedSceneEditsForTests as reset } from '../src/store/graphStore';\n${SCENE}afterEach(() => { reset(); });\n${TEST}`],
    ['an async afterEach with a timeout', `${NAMESPACE}${SCENE}afterEach(async () => { await settle(); store.resetDeletedSceneEditsForTests(); }, 5_000);\n${TEST}`],
    ['the reset in the describe around every test', `${STATIC}${SCENE}describe('all', () => { afterEach(resetDeletedSceneEditsForTests); ${TEST} describe('inner', () => { ${TEST} }); });`],
    ['scenes without the graph store', `${SCENE}${TEST}`],
    ['the store without scenes', `${STATIC}${TEST}`],
    ['the scene id only in a comment', `${STATIC}// definitionId: 'cinema-scene'\n${TEST}`],
    ['a type-only import of the store', `import type { GraphState } from '../src/store/graphStore';\n${SCENE}${TEST}`],
    ['a full mock of the store', `vi.mock('../src/store/graphStore', () => ({ useGraphStore: {} }));\n${STATIC}${SCENE}${TEST}`],
    ['an opt-out with a reason', `// scene-edits-reset: off, reads the scene catalogue only and never syncs a node\n${STATIC}${SCENE}${TEST}`],
  ];
  it.each(passes)('passes: %s', (_, source) => {
    expect(leaking(source)).toBe(false);
  });
});

describe('test files that use Cinema scenes with the graph store reset its per-node state after each test', () => {
  // Sized from measurement: see the PR notes (the scan's time locally and under load).
  it('every such file calls resetDeletedSceneEditsForTests in afterEach, around every test', { timeout: 20_000 }, () => {
    const files = allTestFiles();
    expect(files.length).toBeGreaterThan(100);
    const found = files.filter((path) => path !== __filename && leaking(readFileSync(path, 'utf8'), path))
      .map((path) => relative(join(__dirname, '..'), path));
    expect(found).toEqual([]);
  });
});
