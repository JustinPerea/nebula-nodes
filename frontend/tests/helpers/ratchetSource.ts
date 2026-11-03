import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/**
 * Shared by the syntax-tree ratchets of fix/ci-flakes-rename-fix16
 * (regionNoticesReady, deleteLanded, sceneEditsReset), the way
 * pinTextReadyRatchet reads files: comments and strings never count as code.
 *
 * Each repo scan prefilters on raw text and parses only files that could
 * hold what it reads (PR #220's ratchet timed out in CI at 5 s parsing every
 * test file). A file holding any escape that could spell part of a token
 * (`P`, `\x63`, an octal, a line continuation) is parsed too.
 */

export const TESTS = join(__dirname, '..');
export const SRC = join(__dirname, '../../src');

export const testFiles = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === 'node_modules') return [];
  if (statSync(path).isDirectory()) return testFiles(path);
  return /\.test\.tsx?$/.test(name) ? [path] : [];
});

/** Every test file under tests/ and src/. */
export const allTestFiles = (): string[] => [...testFiles(TESTS), ...testFiles(SRC)];

const ESCAPE = /\\(?:u\{?[0-9a-fA-F]|x[0-9a-fA-F]|[0-7]|\r?\n)/;
/** The prefilter: the raw text holds one of the tokens, or an escape that could spell one. */
export const mayHold = (source: string, tokens: readonly (string | RegExp)[]): boolean =>
  tokens.some((token) => (typeof token === 'string' ? source.includes(token) : token.test(source))) || ESCAPE.test(source);

const PARSE_OPTIONS: ts.CreateSourceFileOptions = { languageVersion: ts.ScriptTarget.Latest };
export const parse = (source: string, fileName = 'case.test.tsx'): ts.SourceFile =>
  ts.createSourceFile(fileName, source, PARSE_OPTIONS, true, fileName.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX);

export const unwrap = (node: ts.Expression): ts.Expression =>
  (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) ? unwrap(node.expression) : node);

/** The called name: `f()` → f, `a.b.f()` → f, anything else → ''. */
export const calleeName = (call: ts.CallExpression): string => {
  const callee = unwrap(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
};

/** The identifier a call chain starts from: `it.each(rows)('x', fn)` → it, `vi.waitFor(fn)` → vi. */
export const rootName = (expression: ts.Expression): string => {
  const node = unwrap(expression);
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return rootName(node.expression);
  if (ts.isCallExpression(node)) return rootName(node.expression);
  if (ts.isTaggedTemplateExpression(node)) return rootName(node.tag);
  return '';
};

export const isFunctionLike = (node: ts.Node | undefined): node is ts.ArrowFunction | ts.FunctionExpression =>
  !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

/** Whether any node under `root` (itself included) matches. */
export const some = (root: ts.Node, test: (node: ts.Node) => boolean): boolean => {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (test(node)) { found = true; return; }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
};

/** Every comment in the file, by the scanner's comment ranges around each node: never text inside a string or template. */
export function commentsOf(file: ts.SourceFile): string[] {
  const text = file.getFullText();
  const seen = new Map<number, string>();
  const take = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) seen.set(range.pos, text.slice(range.pos, range.end));
  };
  const visit = (node: ts.Node) => {
    take(ts.getLeadingCommentRanges(text, node.getFullStart()));
    take(ts.getTrailingCommentRanges(text, node.getEnd()));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...seen.values()];
}

/** A real comment `<key>: off, <reason>` with a reason of at least 10 characters. */
export const optedOut = (file: ts.SourceFile, key: string): boolean => {
  const rule = new RegExp(`${key}:\\s*off\\b[\\s,:;—–-]*(\\S.{9,})`);
  return commentsOf(file).some((comment) => rule.test(comment));
};

const isModule = (node: ts.Node | undefined, specifier: RegExp): boolean =>
  !!node && ts.isStringLiteralLike(node) && specifier.test(node.text);

/**
 * What a file takes from a module: the local names bound to its exports
 * (a named import, or a destructured `await import(…)`), whether it takes the
 * module at all (any non-type import, export, `import(…)`, vi.importActual or
 * require), and whether a vi.mock or vi.doMock replaces it whole (no factory,
 * or one that never reaches importOriginal or importActual).
 */
export function moduleUse(file: ts.SourceFile, specifier: RegExp) {
  const bindings = new Map<string, string>();
  const declarations = new Map<string, number>();
  const namespaces = new Set<string>();
  let takes = false;
  let fullMock = false;
  const declare = (name: string) => declarations.set(name, (declarations.get(name) ?? 0) + 1);
  const visit = (node: ts.Node) => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) declare(node.name.text);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isFunctionExpression(node)) && node.name) declare(node.name.text);
    if ((ts.isImportSpecifier(node) || ts.isNamespaceImport(node) || ts.isImportClause(node)) && node.name) declare(node.name.text);
    if (ts.isImportDeclaration(node) && isModule(node.moduleSpecifier, specifier) && !node.importClause?.isTypeOnly) {
      takes = true;
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (!element.isTypeOnly) bindings.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    }
    if (ts.isExportDeclaration(node) && isModule(node.moduleSpecifier, specifier) && !node.isTypeOnly) takes = true;
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && isModule(node.arguments[0], specifier)) takes = true;
    if (ts.isCallExpression(node) && ['importActual', 'require'].includes(calleeName(node)) && isModule(node.arguments[0], specifier)) takes = true;
    if (ts.isImportDeclaration(node) && isModule(node.moduleSpecifier, specifier) && !node.importClause?.isTypeOnly) {
      const named = node.importClause?.namedBindings;
      if (named && ts.isNamespaceImport(named)) namespaces.add(named.name.text);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      const loaded = ts.isAwaitExpression(init) ? unwrap(init.expression) : init;
      const fromModule = ts.isCallExpression(loaded) && (loaded.expression.kind === ts.SyntaxKind.ImportKeyword || calleeName(loaded) === 'importActual')
        && isModule(loaded.arguments[0], specifier);
      // `const store = await import(…)`: a later `const { a } = store` takes a.
      if (fromModule && ts.isIdentifier(node.name)) namespaces.add(node.name.text);
      if (ts.isObjectBindingPattern(node.name) && (fromModule || (ts.isIdentifier(loaded) && namespaces.has(loaded.text)))) {
        for (const element of node.name.elements) {
          const key = element.propertyName ?? element.name;
          if (ts.isIdentifier(key) && ts.isIdentifier(element.name)) bindings.set(element.name.text, key.text);
        }
      }
    }
    if (ts.isCallExpression(node) && ['mock', 'doMock'].includes(calleeName(node)) && isModule(node.arguments[0], specifier)) {
      const factory = node.arguments[1];
      if (!factory) fullMock = true;
      else if (isFunctionLike(factory) && factory.parameters.length === 0
        && !/\bimportActual\b|\bimportOriginal\b/.test(factory.getText(file))) fullMock = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  /** Whether a bare name is this module's `exported`, imported once and never shadowed. */
  const isExport = (name: string, exported: string) => bindings.get(name) === exported && declarations.get(name) === 1;
  return { takes, fullMock, isExport };
}
