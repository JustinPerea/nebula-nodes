// fix/pin-text-corpus-flake: the pin text rules (pinDisplayText and the
// counts built on it) read Unicode data that canvasPins imports lazily, as its
// own chunk (review 13 L-2). Until the chunk lands, every rule errs toward
// hiding, by design. The product waits for the data: the pins store before
// it sanitizes, the note dialog before it counts. A test that calls the rules
// must wait too, or it races the import. agentPresenceFollowups.r12text
// failed every time alone and now and then in CI: run 41569694838 attempt 1
// failed, and attempt 2 on the same commit passed.
//
// The check (PR #218 review 1 LOW-2, LOW-3), read from each test file's syntax
// tree, so comments and strings never count:
// - It finds an import of canvasPins by the module specifier
//   /(^|\/)canvasPins(\.[jt]sx?)?$/: '../src/lib/canvasPins', '…/canvasPins.ts'
//   and a colocated './canvasPins'.
// - A named import, a re-export from a test file, or a destructured
//   `await import(…)` brings in the names it lists. A namespace import, a
//   default import, or any other `import(…)` (`const m = await import(…)`,
//   `.then`) counts as bringing in every rule.
// - A file that brings in a rule needs one of these in code: an awaited
//   pinTextReady or pinTextSettling(), with any receiver, or a beforeAll or
//   beforeEach callback that returns one.
// - Exempt: a file whose vi.mock or vi.doMock of canvasPins replaces it
//   whole, with no importOriginal and no importActual. Nothing lazy loads there.
// - Opt-out: a comment `pin-text-ratchet: off, <reason>`. The reason is
//   required, at least 10 characters (for example, a file that tests the
//   pending state on purpose).
//
// Known gaps, not caught here:
// - A helper module that re-exports a rule (`export { pinDisplayText } from
//   '…/canvasPins'` in a non-test file), when a test imports the rule from
//   that helper.
// - Indirect callers. A test that renders PinLayer or PinComposer, or puts
//   pins in the store with setState({ pins }), calls pinDisplayText with no
//   import of its own. Today none of them assert text that depends on the
//   data (review 1 NIT-1 grepped for ZWJ, FE0F, tag and emoji literals). A
//   test that does must wait as above.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const DATA_RULES = ['pinDisplayText', 'textLength', 'noteLength', 'fitNote', 'keptNoteDisplay', 'noteIsEmpty'];
const SPECIFIER = /(^|\/)canvasPins(\.[jt]sx?)?$/;
const WAITS = new Set(['pinTextReady', 'pinTextSettling']);
const OPT_OUT = /pin-text-ratchet:\s*off\b[\s,:;—–-]*(\S.{9,})/;
const ALL = '*';
const TESTS = __dirname;
const SRC = join(__dirname, '../src');

const testFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === 'node_modules') return [];
  if (statSync(path).isDirectory()) return testFiles(path);
  return /\.test\.tsx?$/.test(name) ? [path] : [];
});

const isCanvasPins = (node: ts.Node | undefined): boolean => !!node && ts.isStringLiteralLike(node) && SPECIFIER.test(node.text);
const calleeName = (call: ts.CallExpression): string => (ts.isPropertyAccessExpression(call.expression)
  ? call.expression.name.text : ts.isIdentifier(call.expression) ? call.expression.text : '');
/** `pinTextReady`, `pins.pinTextReady`, `pinTextSettling()` or `pins.pinTextSettling()`. */
const isWait = (node: ts.Expression): boolean => {
  let target = node;
  while (ts.isParenthesizedExpression(target)) target = target.expression;
  if (ts.isCallExpression(target)) target = target.expression;
  const name = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : '';
  return WAITS.has(name);
};

/** What a test file's source brings in from canvasPins, whether it waits, and whether a full mock or an opt-out exempts it. */
function readFile(source: string, fileName = 'case.test.tsx') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const names = new Set<string>();
  let waits = false;
  let fullMock = false;
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && isCanvasPins(node.moduleSpecifier) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause;
      if (clause?.name) names.add(ALL);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.add(ALL);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) if (!element.isTypeOnly) names.add((element.propertyName ?? element.name).text);
      }
    }
    if (ts.isExportDeclaration(node) && isCanvasPins(node.moduleSpecifier) && !node.isTypeOnly) {
      if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) names.add(ALL);
      else for (const element of node.exportClause.elements) names.add((element.propertyName ?? element.name).text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && isCanvasPins(node.arguments[0])) {
      // `const { a, b: c } = await import(…)` takes its names; any other use takes them all.
      const awaited = ts.isAwaitExpression(node.parent) ? node.parent : null;
      const declared = awaited && ts.isVariableDeclaration(awaited.parent) ? awaited.parent : null;
      if (declared && ts.isObjectBindingPattern(declared.name) && declared.name.elements.every((e) => !e.dotDotDotToken)) {
        for (const element of declared.name.elements) {
          const key = element.propertyName ?? element.name;
          names.add(ts.isIdentifier(key) ? key.text : ALL);
        }
      } else names.add(ALL);
    }
    if (ts.isCallExpression(node) && ['mock', 'doMock'].includes(calleeName(node)) && isCanvasPins(node.arguments[0])) {
      const factory = node.arguments[1];
      // A whole replacement: no factory (vitest's automock), or one that never reaches the real module.
      if (!factory) fullMock = true;
      else if ((ts.isArrowFunction(factory) || ts.isFunctionExpression(factory)) && factory.parameters.length === 0
        && !/\bimportActual\b|\bimportOriginal\b/.test(factory.getText(file))) fullMock = true;
    }
    if (ts.isAwaitExpression(node) && isWait(node.expression)) waits = true;
    if (ts.isCallExpression(node) && ['beforeAll', 'beforeEach'].includes(calleeName(node))) {
      const hook = node.arguments[0];
      if (hook && ts.isArrowFunction(hook) && !ts.isBlock(hook.body) && isWait(hook.body)) waits = true;
      if (hook && (ts.isArrowFunction(hook) || ts.isFunctionExpression(hook)) && ts.isBlock(hook.body)
        && hook.body.statements.some((s) => ts.isReturnStatement(s) && !!s.expression && isWait(s.expression))) waits = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  const comments = source.match(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g) ?? [];
  const optedOut = comments.some((comment) => OPT_OUT.test(comment));
  const rules = names.has(ALL) ? [...DATA_RULES] : DATA_RULES.filter((rule) => names.has(rule));
  return { rules, waits, fullMock, optedOut, racing: rules.length > 0 && !waits && !fullMock && !optedOut };
}

const racing = (source: string, fileName?: string) => readFile(source, fileName).racing;
const LIB = "'../src/lib/canvasPins'";

describe('the ratchet reads every import form (mutation cases: each must be caught)', () => {
  const caught: Array<[string, string]> = [
    ['a named import', `import { pinDisplayText } from ${LIB};`],
    ['a renamed import', `import { noteLength as n } from ${LIB};`],
    ['a namespace import', `import * as pins from ${LIB};`],
    ['a default import', `import pins from ${LIB};`],
    ['a non-destructured dynamic import', `const m = await import(${LIB});`],
    ['a dynamic import through .then', `import(${LIB}).then((m) => m.pinDisplayText('a'));`],
    ['a destructured dynamic import', `const { fitNote } = await import(${LIB});`],
    ['a renamed destructured dynamic import', `const { textLength: count } = await import(${LIB});`],
    ['an explicit .ts extension', "import { pinDisplayText } from '../src/lib/canvasPins.ts';"],
    ['a colocated ./canvasPins', "import { pinDisplayText } from './canvasPins';"],
    ['a colocated ../canvasPins', "import { pinDisplayText } from '../canvasPins';"],
    ['a re-export in a test file', `export { pinDisplayText } from ${LIB};`],
    ['pinTextReady only in a line comment', `import { pinDisplayText } from ${LIB};\n// await pinTextReady`],
    ['pinTextReady only in a block comment', `import { pinDisplayText } from ${LIB};\n/* beforeAll(() => pinTextReady); */`],
    ['pinTextReady only in a string', `import { pinDisplayText } from ${LIB};\nconst why = 'await pinTextReady';`],
    ['pinTextReady imported but never awaited', `import { pinDisplayText, pinTextReady } from ${LIB};\nvoid pinTextReady;`],
    ['pinTextSettling called but not awaited', `import { pinDisplayText, pinTextSettling } from ${LIB};\npinTextSettling();`],
    ['a partial mock (importOriginal) is still the real module', `vi.mock(${LIB}, async (importOriginal) => ({ ...await importOriginal() }));\nimport { pinDisplayText } from ${LIB};`],
    ['an opt-out with no reason', `// pin-text-ratchet: off\nimport { pinDisplayText } from ${LIB};`],
  ];
  it.each(caught)('%s', (_, source) => {
    expect(racing(source)).toBe(true);
  });

  const passes: Array<[string, string]> = [
    ['await pinTextReady', `import { pinDisplayText, pinTextReady } from ${LIB};\nbeforeAll(async () => { await pinTextReady; });`],
    ['beforeAll(() => pinTextReady)', `import { pinDisplayText, pinTextReady } from ${LIB};\nbeforeAll(() => pinTextReady);`],
    ['beforeEach returning pinTextSettling()', `import { fitNote, pinTextSettling } from ${LIB};\nbeforeEach(function () { return pinTextSettling(); });`],
    ['await on a namespace', `const pins = await import(${LIB});\nawait pins.pinTextReady;`],
    ['await pins.pinTextSettling() in act', `import * as pins from ${LIB};\nawait act(async () => { await pins.pinTextSettling(); });`],
    ['a full mock without importOriginal', `vi.mock(${LIB}, () => ({ pinDisplayText: (s: string) => s }));\nimport { pinDisplayText } from ${LIB};`],
    ['an automock', `vi.mock(${LIB});\nimport { pinDisplayText } from ${LIB};`],
    ['an opt-out with a reason', `// pin-text-ratchet: off, tests the pending state on purpose\nimport { pinDisplayText } from ${LIB};`],
    ['only names that read no data', `import { noteKeptLine, PIN_REFUSAL_COPY, type KeptNote } from ${LIB};`],
    ['a type-only import', `import type { KeptNote } from ${LIB};`],
    ['another module named like it', "import { pinDisplayText } from '../src/lib/canvasPinsLegacy';"],
  ];
  it.each(passes)('passes: %s', (_, source) => {
    expect(racing(source)).toBe(false);
  });
});

describe('tests of the pin text rules wait for the Unicode data', () => {
  it('every test file that brings in a rule waits on pinTextReady or pinTextSettling', () => {
    const files = [...testFiles(TESTS), ...testFiles(SRC)];
    expect(files.length).toBeGreaterThan(100);
    const found = files.filter((path) => path !== __filename && racing(readFileSync(path, 'utf8'), path))
      .map((path) => relative(join(__dirname, '..'), path));
    expect(found).toEqual([]);
  });
});
