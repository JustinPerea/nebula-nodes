/**
 * PR #204 round 5 (review 3 MEDIUM-1): the structural half of the "clears on promote" ratchet.
 * It finds, without a hand-written map:
 *
 * 1. Every backend route behind the person gate: a route anywhere in backend/ (round 7)
 *    whose handler reaches a gate form (`require_person(`, `_person_only_refusal(`,
 *    `stop_refusal(`, `person_only`, PersonGateError or PERSON_REQUIRED written inline, or a
 *    `Depends(person_only)` route, parameter or router) directly or through any helper in
 *    main.py, routes/ or services/ (`_check_style_write` → `_refuse_agent_billing_change` →
 *    `_person_only_refusal`). Read with Python's ast (personGateRoutes.py).
 * 2. Every frontend caller of such a route: a string or template literal that is the route's
 *    path, sent with the route's method (a call's `method:`; none is GET; one it can't read
 *    counts as any), followed through lib/ helpers (who calls the helper, and who calls that)
 *    to the first function outside lib/: the store action or component that keeps the line.
 *
 * Read with the TypeScript parser (no type checking): names, not types, so a helper is found by
 * its name wherever it is called or passed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = join(__dirname, '..');
export const SRC = join(ROOT, 'src');
const BACKEND = join(ROOT, '../backend');

const walk = (dir: string, ext: RegExp): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === 'node_modules' || name === 'tests' || name === 'test' ? [] : walk(path, ext);
  return ext.test(name) && !/\.test\./.test(name) && !/\.d\.ts$/.test(name) ? [path] : [];
});

// ---------- backend ----------

export interface GatedRoute { method: string; path: string; handler: string }

/**
 * Every backend route behind the person gate, read with Python's ast (tests/personGateRoutes.py,
 * review 4 LOW-2, round 6): multi-line decorators, either quote, api_route, helpers in services/
 * and other modules, aliases, a class's static method, PersonGateError or PERSON_REQUIRED written
 * inline, Depends(person_only) in a parameter or a router's dependencies=. `files` (tests): a
 * backend given as {path: source} in place of the real one.
 */
export function gatedRoutes(files?: Record<string, string>): GatedRoute[] {
  return [...readGateRoutes(files).routes].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

/**
 * PR #204 round 10: the routes that refuse anyone but the person every time (personGateRoutes.py
 * personOnly: require_person, person_only or the Commons' human_dep, reached unconditionally),
 * the set whose controls lock (tests/personLockSweep.ratchet.test.ts).
 */
export function personOnlyRoutes(files?: Record<string, string>): GatedRoute[] {
  return [...readGateRoutes(files).personOnly].sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

/** A route form personGateRoutes.py can't read (round 7): it is listed, never skipped. */
export interface UnreadableRouteForm {
  file: string; line: number; form: string;
  handler: string | null; method: string | null; path: string | null;
  /** Whether what it could read reaches a gate (null: no handler to read). */
  gated: boolean | null;
}

/** Every route form the backend scan can't read: an owner, path, prefix, methods= or
 * dependencies= it can't evaluate, an endpoint it can't find, a gated middleware, a file that
 * doesn't parse. `files` as in gatedRoutes. */
export function unreadableRouteForms(files?: Record<string, string>): UnreadableRouteForm[] {
  return [...readGateRoutes(files).unreadable];
}

interface GateScan { routes: GatedRoute[]; unreadable: UnreadableRouteForm[]; personOnly: GatedRoute[] }
let realScan: GateScan | undefined;

/** One run of the script per backend: the real one is read once per test file. */
function readGateRoutes(files?: Record<string, string>): GateScan {
  if (!files && realScan) return realScan;
  const script = join(__dirname, 'personGateRoutes.py');
  const out = files
    ? execFileSync('python3', ['-I', script, '--stdin'], { input: JSON.stringify({ files }), encoding: 'utf8', maxBuffer: 64 << 20 })
    : execFileSync('python3', ['-I', script, BACKEND], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const scan = JSON.parse(out) as GateScan;
  if (!files) realScan = scan;
  return scan;
}

// ---------- frontend ----------

export interface Unit {
  file: string; name: string; wide: boolean; node: ts.Node; via?: string; constant?: boolean;
  /** Round 6 (review 4 MEDIUM-1): what the catch on this call does with a refusal, at the worst
   * of the unit's calls on the route: 'keeps' (registers), 'drops' (must be declared). */
  outcome?: Outcome;
  /** It hands a Response back to its callers (round 7): their `!res.ok` handling is what's read. */
  responds?: boolean;
  /** Round 11: where in the unit the route is reached (callersOf's result): the calls or paths
   * lockReach follows to the controls. */
  points?: ts.Node[];
}

const isFunctionLike = (node: ts.Node | undefined): boolean => !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

/** The nearest named function around `node`: a declaration, a const bound to a function (or a
 * call that wraps one: a hook, useCallback), an object's method or function property, or (round 6,
 * review 4 LOW-1) a top-level const that holds the path itself, traced through its references. */
function unitOf(file: string, node: ts.Node): Unit | null {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return { file, name: n.name.text, wide: ts.isSourceFile(n.parent), node: n };
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return { file, name: n.name.text, wide: true, node: n };
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && isFunctionLike(n.initializer)) {
      return { file, name: n.name.text, wide: true, node: n };
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const statement = n.parent?.parent;
      const top = !!statement && ts.isSourceFile(statement.parent);
      if (isFunctionLike(n.initializer) || ts.isCallExpression(n.initializer)) return { file, name: n.name.text, wide: top, node: n };
      if (top && n.initializer === node || (top && pathRoot(node) === n.initializer)) return { file, name: n.name.text, wide: true, node: n, constant: true };
    }
  }
  return null;
}

/** The outermost `+` of strings a node is part of (or the node). */
function pathRoot(node: ts.Node): ts.Node {
  let n = node;
  while (n.parent && (ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
    || ts.isParenthesizedExpression(n.parent))) n = n.parent;
  return n;
}

/** A top-level `const NAME = '…'` of the node's file, by name: what a placeholder holds. Round 11
 * (review 9 LOW-3): also one imported by name (`import { PRESETS_PATH } from '../lib/paths'`, an
 * alias, a re-export) or read off a namespace import (`paths.PRESETS_PATH`). */
function constantText(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return namespaceConstText(node);
  if (!ts.isIdentifier(node)) return null;
  return topConstText(node.getSourceFile(), node.text) ?? importedConstText(node);
}
function topConstText(source: ts.SourceFile, name: string): string | null {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer
        && (ts.isStringLiteral(declaration.initializer) || ts.isNoSubstitutionTemplateLiteral(declaration.initializer))) {
        return declaration.initializer.text;
      }
    }
  }
  return null;
}

/** The files the trace reads (src, or a test's sources), by path under src. */
let currentFiles: Map<string, ts.SourceFile> | null = null;
const fileOf = (source: ts.SourceFile): string => relative(SRC, source.fileName);

/** The text of `name` exported as a top-level string const by `module`, through `export { … }
 * from` and `export * from` (a few hops). */
function exportedConstText(module: string, name: string, depth = 0): string | null {
  const source = currentFiles?.get(module);
  if (!source || depth > 5) return null;
  const own = topConstText(source, name);
  if (own !== null) return own;
  const known = new Set(currentFiles!.keys());
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const from = resolveModule(module, statement.moduleSpecifier.text, known);
    if (!from) continue;
    if (!statement.exportClause) {
      const found = exportedConstText(from, name, depth + 1);
      if (found !== null) return found;
    } else if (ts.isNamedExports(statement.exportClause)) {
      const element = statement.exportClause.elements.find((el) => el.name.text === name);
      if (element) return exportedConstText(from, (element.propertyName ?? element.name).text, depth + 1);
    }
  }
  return null;
}
/** The module an import in `source` binds `local` from, and the name it has there (a namespace
 * import: name null). */
function importOf(source: ts.SourceFile, local: string): { module: string; name: string | null } | null {
  if (!currentFiles) return null;
  const known = new Set(currentFiles.keys());
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.importClause?.namedBindings) continue;
    const bindings = statement.importClause.namedBindings;
    const module = resolveModule(fileOf(source), statement.moduleSpecifier.text, known);
    if (!module) continue;
    if (ts.isNamespaceImport(bindings)) {
      if (bindings.name.text === local) return { module, name: null };
      continue;
    }
    const element = bindings.elements.find((el) => el.name.text === local);
    if (element) return { module, name: (element.propertyName ?? element.name).text };
  }
  return null;
}
function importedConstText(node: ts.Identifier): string | null {
  const bound = importOf(node.getSourceFile(), node.text);
  return bound?.name ? exportedConstText(bound.module, bound.name) : null;
}
function namespaceConstText(node: ts.PropertyAccessExpression): string | null {
  if (!ts.isIdentifier(node.expression)) return null;
  const bound = importOf(node.getSourceFile(), node.expression.text);
  return bound && bound.name === null ? exportedConstText(bound.module, node.name.text) : null;
}

/**
 * Round 10 (review 8 LOW-1): the `const` a name refers to when it is declared in a block around
 * the name inside a function (a top-level one is constantText's). Null for anything else: a
 * declaration, a property's name, a parameter, a top-level name.
 */
function localConst(node: ts.Node): ts.VariableDeclaration | null {
  if (!ts.isIdentifier(node) || !isValueReference(node)) return null;
  for (let scope: ts.Node | undefined = node.parent; scope && !ts.isSourceFile(scope); scope = scope.parent) {
    if (!ts.isBlock(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === node.text) return declaration;
      }
    }
  }
  return null;
}
/** A name that stands for its value here: not one being declared, nor a property's name. */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.expression === node;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  return (parent as { name?: ts.Node }).name !== node;
}
const isConstList = (declaration: ts.VariableDeclaration): boolean =>
  ts.isVariableDeclarationList(declaration.parent) && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;

/** What a function-local `const` holds as a path, read through parentheses and a conditional
 * whose branches are both read; null when any part of it can't be read. */
function readableTexts(node: ts.Node, depth = 0): string[] | null {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isConditionalExpression(e)) {
    const whenTrue = readableTexts(e.whenTrue, depth);
    const whenFalse = readableTexts(e.whenFalse, depth);
    return whenTrue && whenFalse ? [...whenTrue, ...whenFalse] : null;
  }
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const top = constantText(e);
    if (top !== null) return [top];
    return depth < 4 && ts.isIdentifier(e) ? localConstTexts(e, depth + 1) : null;
  }
  const texts = literalTexts(e);
  return texts.length > 0 ? texts : null;
}
/** The texts of the function-local `const` a name refers to (null: not one, or not read). Round 11
 * (review 9 NIT-1): a const read while it is being read (`const u = \`${u}/api/…\``, TDZ code) is
 * null there, so no cycle runs away. */
const reading = new Set<ts.VariableDeclaration>();
function localConstTexts(node: ts.Node, depth = 0): string[] | null {
  const declaration = localConst(node);
  if (!declaration || !isConstList(declaration) || !declaration.initializer || reading.has(declaration)) return null;
  reading.add(declaration);
  try { return readableTexts(declaration.initializer, depth); } finally { reading.delete(declaration); }
}
/** A placeholder's or a `+` part's text: a top-level const, or a function-local one of one text. */
function nameText(node: ts.Node): string | null {
  const top = constantText(node);
  if (top !== null) return top;
  const local = localConstTexts(node);
  return local && local.length === 1 ? local[0] : null;
}

/** A literal's texts: one, or, for a template whose placeholder picks between two strings
 * (`/api/${kind === 'moodboard' ? 'moodboards' : 'characters'}/…`), one per choice (round 7).
 * Round 10: a name that refers to a function-local `const` path is that path, written here. */
function literalTexts(node: ts.Node): string[] {
  if (ts.isIdentifier(node)) return localConstTexts(node) ?? [];
  if (ts.isTemplateExpression(node)) {
    let out = [node.head.text];
    for (const span of node.templateSpans) {
      const choices = spanChoices(span.expression);
      out = out.flatMap((head) => choices.map((choice) => head + choice + span.literal.text));
    }
    return out;
  }
  const text = literalText(node);
  return text === null ? [] : [text];
}

/** What a template's placeholder reads as: either of two strings, a const's text, or anything. */
function spanChoices(expression: ts.Expression): string[] {
  let e: ts.Expression = expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return ts.isConditionalExpression(e) && [e.whenTrue, e.whenFalse].every((b) => ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b))
    ? [e.whenTrue, e.whenFalse].map((b) => (b as ts.StringLiteral).text)
    : [nameText(expression) ?? '\uE000'];
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // Round 7 (gates-security LOW-1): a placeholder that names a top-level string const is its text
  // (`${API}presets` with `const API = '/api/'`).
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `${nameText(span.expression) ?? '\uE000'}${span.literal.text}`).join('');
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  // Round 6 (review 4 LOW-1): '/api/' + 'presets', `${BASE}/api/…` + id.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left) ?? nameText(node.left);
    const right = literalText(node.right) ?? nameText(node.right);
    if (left === null && right === null) return null;
    return (left ?? '\uE000') + (right ?? '\uE000');
  }
  return null;
}

/** A literal's path as a route reads it: a base before /api/ (`${BASE}/api/…`) and a written
 * ?query dropped (review 4 LOW-1). Null when it holds no /api/ path. */
function apiPath(text: string): string | null {
  const at = text.indexOf('/api/');
  if (at < 0) return null;
  const before = text.slice(0, at);
  if (before !== '' && !/^\uE000+$/.test(before)) return null;
  return text.slice(at).replace(/\?.*$/, '');
}

/** Calls that send their path with GET unless an init says otherwise. */
const GET_BY_DEFAULT = new Set(['apiFetch', 'apiRequest', 'request', 'fetch', 'graphMutationFetch']);
const HTTP_METHOD = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE)$/;

/** The method a literal path is sent with: an argument's `method:`, or a helper call's own
 * method word (`json('PUT', …)`); GET for a plain transport call that names none; '*' when it
 * can't be read (another helper, a variable, a path kept in a const), which matches any route. */
function methodOf(node: ts.Node): string {
  let n: ts.Node = node;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isBinaryExpression(n.parent) || ts.isTemplateSpan(n.parent))) n = n.parent;
  const call = n.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(n as ts.Expression)) return '*';
  const after = call.arguments.slice(call.arguments.indexOf(n as ts.Expression) + 1);
  for (const argument of after) {
    // `apiRequest(message, path, undefined, { allow: [404] })`: no init, so no method.
    if ((ts.isIdentifier(argument) && argument.text === 'undefined') || argument.kind === ts.SyntaxKind.NullKeyword) continue;
    // A method word after the path (`call(path, 'PUT')`) is the method; other text (a failure line) isn't.
    if (ts.isStringLiteralLike(argument)) {
      if (HTTP_METHOD.test(argument.text.toUpperCase())) return argument.text.toUpperCase();
      continue;
    }
    if (ts.isObjectLiteralExpression(argument)) {
      for (const property of argument.properties) {
        if (ts.isShorthandPropertyAssignment(property) && property.name.text === 'method') return '*';
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== 'method') continue;
        return ts.isStringLiteralLike(property.initializer) ? property.initializer.text.toUpperCase() : '*';
      }
    } else if (ts.isCallExpression(argument) && argument.arguments[0] && ts.isStringLiteralLike(argument.arguments[0])
      && HTTP_METHOD.test(argument.arguments[0].text.toUpperCase())) {
      return argument.arguments[0].text.toUpperCase();
    } else {
      return '*';
    }
  }
  const callee = ts.isIdentifier(call.expression) ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';
  return GET_BY_DEFAULT.has(callee) ? 'GET' : '*';
}

const escape = (text: string) => text.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');

/** Whether a literal (a template's placeholders as \uE000) can be the route's path: each
 * placeholder stands for anything; only a literal that starts with /api/ counts. */
function sendsTo(text: string, path: string): boolean {
  // /api/ and a written first segment: `/api/${kind}/…` could be any route, and isn't read as one.
  if (!/^\/api\/[^/\uE000]+(?:\/|\uE000|$)/.test(text) || /^\/api\/[^/]*\uE000/.test(text.slice(0, text.indexOf('/', 5) === -1 ? undefined : text.indexOf('/', 5)))) return false;
  const pattern = new RegExp(`^${text.split('\uE000').map(escape).join('.*')}(?:\\?.*)?$`);
  return pattern.test(path.replace(/\{[^}]+\}/g, 'x1'));
}

interface Parsed { file: string; source: ts.SourceFile }

/** What one file takes from one module: names it imports, namespaces (`* as api`), default
 * imports (their local names), or a dynamic `import()` (any name). */
interface Taken { names: Set<string>; namespaces: Set<string>; defaults: Set<string>; dynamic: boolean }

interface Frontend {
  files: Parsed[];
  references: Map<string, { file: string; node: ts.Identifier }[]>;
  imports: Map<string, Map<string, Taken>>;
  /** Every /api/ literal in a function, read once. `wrapped`: handed to a same-file function
   * that returns the transport's Response (round 11). */
  literals: Literal[];
  /** /api/ text the trace can't follow (round 6, fail closed), with why (round 11). */
  untraced: Untraced[];
  /** A module's default export: the name of the function it is. */
  defaults: Map<string, string>;
  /** Functions that return an /api/ path, by `file#name`, with each path they return (round 9). */
  helpers: Map<string, string[]>;
  /** Helper references whose call is read as part of a longer path (round 11). */
  composed: Set<ts.Node>;
  /** Path const references the trace reads at the local they're held in, or lists (round 11). */
  heldConsts: Set<ts.Node>;
  /** Round 13 (review 10 LOW-3): a path const's or helper's reference handed to a function that
   * returns the transport's Response, with that function's call (its `!res.ok` is what's read). */
  wrappedRefs: Map<ts.Node, ts.CallExpression>;
  byFile: Map<string, ts.SourceFile>;
}
interface Literal { text: string; method: string; unit: Unit; node: ts.Node; wrapped?: boolean }
export interface Untraced { file: string; line: number; text: string; reason?: string }
let cache: Frontend | null = null;

/** A relative module specifier, as a file under src. */
function resolveModule(from: string, specifier: string, known: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = join(from.split('/').slice(0, -1).join('/'), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** Tests: run `fn` against the given sources ({path under src: text}) in place of src. */
export function withSources<T>(sources: Record<string, string>, fn: () => T): T {
  const saved = cache;
  const savedFiles = currentFiles;
  const savedKeepers = new Map(keepersCache);
  cache = build(Object.entries(sources).map(([file, text]) => ({ file,
    source: ts.createSourceFile(join(SRC, file), text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) })));
  keepersCache.clear();
  try { return fn(); } finally {
    cache = saved;
    currentFiles = savedFiles;
    keepersCache.clear();
    for (const [key, value] of savedKeepers) keepersCache.set(key, value);
  }
}

function frontend(): Frontend {
  if (cache) { currentFiles = cache.byFile; return cache; }
  cache = build(walk(SRC, /\.(ts|tsx)$/).map((path) => ({
    file: relative(SRC, path),
    source: ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
      path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
  })));
  return cache;
}

function build(files: Parsed[]): Frontend {
  const byFile = new Map(files.map((entry) => [entry.file, entry.source]));
  currentFiles = byFile;
  const references = new Map<string, { file: string; node: ts.Identifier }[]>();
  for (const { file, source } of files) {
    const visit = (node: ts.Node) => {
      // `getState()['save']()`: the string names the action (review 5 LOW-7, round 7).
      if (ts.isStringLiteral(node) && ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) {
        references.set(node.text, [...(references.get(node.text) ?? []), { file, node: node as unknown as ts.Identifier }]);
      }
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const declares = (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent)
          || ts.isMethodDeclaration(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent)
          || ts.isExportSpecifier(parent) || ts.isParameter(parent) || ts.isPropertySignature(parent)) && parent.name === node;
        if (!declares) references.set(node.text, [...(references.get(node.text) ?? []), { file, node }]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const known = new Set(files.map((entry) => entry.file));
  const taken = (into: Map<string, Taken>, module: string) => {
    if (!into.has(module)) into.set(module, { names: new Set(), namespaces: new Set(), defaults: new Set(), dynamic: false });
    return into.get(module)!;
  };
  // `export { name } from './other'` (or `name as alias`): an import of it from this file is
  // one of the original name from ./other. `export * from './other'`: any name may be.
  const reexports = new Map<string, { module: string; name: string }>();
  const stars = new Map<string, string[]>();
  const defaults = new Map<string, string>();
  for (const { file, source } of files) {
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name
        && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) defaults.set(file, statement.name.text);
      if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) defaults.set(file, statement.expression.text);
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = resolveModule(file, statement.moduleSpecifier.text, known);
      if (!module) continue;
      if (!statement.exportClause) { stars.set(file, [...(stars.get(file) ?? []), module]); continue; }
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        reexports.set(`${file}#${element.name.text}`, { module, name: (element.propertyName ?? element.name).text });
      }
    }
  }
  const origins = (module: string, name: string, depth = 0): { module: string; name: string }[] => {
    const via = reexports.get(`${module}#${name}`);
    const out = [{ module, name }];
    if (depth > 5) return out;
    if (via) out.push(...origins(via.module, via.name, depth + 1));
    for (const star of stars.get(module) ?? []) out.push(...origins(star, name, depth + 1));
    return out;
  };
  const imports = new Map<string, Map<string, Taken>>();
  for (const { file, source } of files) {
    const into = new Map<string, Taken>();
    imports.set(file, into);
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const module = resolveModule(file, node.moduleSpecifier.text, known);
        const clause = node.importClause;
        if (module && clause?.name) taken(into, module).defaults.add(clause.name.text);
        if (module && clause?.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            taken(into, module).namespaces.add(clause.namedBindings.name.text);
            for (const star of stars.get(module) ?? []) taken(into, star).namespaces.add(clause.namedBindings.name.text);
          } else for (const element of clause.namedBindings.elements) {
            const name = (element.propertyName ?? element.name).text;
            for (const origin of origins(module, name)) taken(into, origin.module).names.add(origin.name);
          }
        }
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const module = resolveModule(file, node.arguments[0].text, known);
        if (module) taken(into, module).dynamic = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const literals: Literal[] = [];
  const untraced: Untraced[] = [];
  const lineOf = (node: ts.Node) => node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const shown = (text: string) => text.replace(/\uE000/g, '${…}');
  /** One path text found at `node` (a literal, or a helper's call composed into one). */
  const take = (file: string, node: ts.Node, text: string) => {
    const path = apiPath(text);
    const unit = unitOf(file, node);
    // Round 7 (gates-security LOW-1): a path whose first segment is a placeholder
    // (`/api/${kind}/…`) could be any route, and a string that is only the /api/ prefix is
    // joined to one somewhere the trace can't read: both are listed, never skipped.
    const unplaced = path !== null && (/^\/api\/\uE000/.test(path) || /^\/api\/?$/.test(path));
    // `new OfflineRefusal('POST', '/api/…')` names the request a refusal stands for; it
    // sends nothing (round 7: no longer a caller to follow).
    if (describesOnly(node)) return;
    const held = heldPath(node);
    if (held === 'followed') return;
    // Round 11 (review 9 LOW-3): a path handed to a same-file function that sends it
    // (`const post = (u) => apiFetch(u, …); post('/api/x')`) is that function's request.
    // Round 13 (review 10 LOW-3): an imported one, or an object's member, too (calledFunction).
    const wrapper = paramWrapper(node);
    const reason = path === null ? 'no /api/ path at its start' : !unit ? 'not in a function' : unplaced ? 'its first segment isn\'t written'
      : held === 'unread' ? 'held in a name or object the trace doesn\'t read' : unreadUse(node, false) ? 'used where the trace can\'t read it'
        : wrapper === 'unread' ? 'handed to a function that sends it and reads the answer itself'
          : wrapper === 'unknown' ? 'handed to a function the trace can\'t read' : null;
    if (reason) untraced.push({ file, line: lineOf(node), text: shown(text), reason });
    else literals.push({ text: path!, method: methodOf(node), unit: unit!, node, wrapped: wrapper === 'responds' });
  };
  for (const { file, source } of files) {
    const visit = (node: ts.Node) => {
      const texts = literalTexts(node);
      if (texts.some((text) => text.includes('/api/'))) {
        for (const text of texts) take(file, node, text);
        return; // the parts of a `+` are read with it
      }
      // Round 11 (review 9 LOW-3): '/api' joined to something the trace can't read
      // (`'/api' + path`, `${API}${path}`) could be any route: listed. A top-level const that
      // holds it is checked at each use instead.
      if (texts.some((text) => /^\uE000*\/api(?:\uE000|$)/.test(text)) && !describesOnly(node)) {
        // A const that holds it is checked at its uses (a top-level one below, file by file).
        const held = constHolding(node);
        if (!held || !prefixUsesRead(held)) {
          untraced.push({ file, line: lineOf(node), text: shown(texts[0]), reason: 'the /api prefix joined where the trace can\'t read the path' });
        }
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const reachable = (reference: { file: string }, file: string) => reference.file === file || !!imports.get(reference.file)?.has(file);
  // Round 9 (review 7 LOW-2): each call of a path helper whose use can't be read is untraced too.
  // Round 11 (review 9 LOW-2): a helper's call inside a longer path (`${base(s)}/${id}/dismiss`,
  // `base(s) + '/read'`) is read with the rest of it, the helper's every path in its place: that
  // is the path sent, not the helper's own.
  const helpers = pathHelpers(literals);
  const composed = new Set<ts.Node>();
  const wrappedRefs = new Map<ts.Node, ts.CallExpression>();
  for (const [id, texts] of helpers) {
    const [file, name] = id.split('#');
    for (const reference of references.get(name) ?? []) {
      if (!reachable(reference, file)) continue;
      const call = helperCall(reference.node);
      const whole = call === reference.node ? call : composeRoot(call);
      if (whole !== call) {
        const made = composedTexts(whole, call, texts);
        // Held in a name, it is listed, and the helper's own trace still drops at the caller.
        if (heldPath(whole) !== null) {
          untraced.push({ file: reference.file, line: lineOf(whole), text: shown(made[0] ?? ''), reason: 'a path helper\'s call in a longer path held in a name' });
        } else {
          composed.add(reference.node);
          for (const text of made) take(reference.file, whole, text);
        }
        continue;
      }
      // Round 13 (review 10 LOW-3): its call handed to a function that sends it (paramWrapper).
      const wrapper = call === reference.node ? null : paramWrapper(call);
      if (wrapper === 'responds') wrappedRefs.set(reference.node, climbPath(call).parent as ts.CallExpression);
      if (wrapper === 'unread' || wrapper === 'unknown') {
        composed.add(reference.node);
        untraced.push({ file: reference.file, line: lineOf(reference.node), text: shown(texts[0]),
          reason: wrapper === 'unread' ? 'a path helper\'s call handed to a function that sends it and reads the answer itself'
            : 'a path helper\'s call handed to a function the trace can\'t read' });
        continue;
      }
      if (!helperPassed(reference.node) && (call === reference.node || !unreadUse(reference.node, true))) continue;
      untraced.push({ file: reference.file, line: lineOf(reference.node), text: shown(texts[0]),
        reason: helperPassed(reference.node) ? 'a path helper handed on uncalled' : 'a path helper\'s call used where the trace can\'t read it' });
    }
  }
  // Round 11 (review 9 LOW-3): a path const used by name. Held in a function-local const that is
  // read at its uses (literalTexts): those uses are the request. Held where the trace can't read
  // it (a `let`, an object): listed. Written into a longer path read as one: that path is.
  const heldConsts = new Set<ts.Node>();
  const constants = new Map<string, string>();
  for (const literal of literals) if (literal.unit.constant) constants.set(`${literal.unit.file}#${literal.unit.name}`, literal.text);
  for (const [id, text] of constants) {
    const [file, name] = id.split('#');
    for (const reference of references.get(name) ?? []) {
      if (!reachable(reference, file)) continue;
      const named = helperName(reference.node);
      const whole = climbPath(named);
      if (whole !== named && literalTexts(whole).some((t) => t.includes('/api/'))) { heldConsts.add(reference.node); continue; }
      const held = heldPath(named);
      if (held === null) {
        // Round 13 (review 10 LOW-3): handed to a function that sends it (`post(PRESETS)`).
        const wrapper = paramWrapper(named);
        if (wrapper === 'responds') wrappedRefs.set(reference.node, climbPath(named).parent as ts.CallExpression);
        if (wrapper === 'unread' || wrapper === 'unknown') {
          heldConsts.add(reference.node);
          untraced.push({ file: reference.file, line: lineOf(reference.node), text: shown(text),
            reason: wrapper === 'unread' ? 'a path const handed to a function that sends it and reads the answer itself'
              : 'a path const handed to a function the trace can\'t read' });
        }
        continue;
      }
      heldConsts.add(reference.node);
      if (held === 'unread') untraced.push({ file: reference.file, line: lineOf(reference.node), text: shown(text), reason: 'a path const held in a name or object the trace doesn\'t read' });
    }
  }
  // Round 11 (review 9 LOW-3): a top-level const that is only '/api' is joined to a path at each
  // use; a use the trace doesn't read as one /api/ path is listed.
  for (const { file, source } of files) {
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !isTopConstValue(declaration.initializer)) continue;
        if (!literalTexts(declaration.initializer).some((text) => /^\/api$/.test(text))) continue;
        for (const reference of references.get(declaration.name.text) ?? []) {
          if (!reachable(reference, file)) continue;
          if (prefixUseRead(reference.node)) continue;
          untraced.push({ file: reference.file, line: lineOf(reference.node), text: '/api', reason: 'the /api prefix joined where the trace can\'t read the path' });
        }
      }
    }
  }
  return { files, references, imports, literals, untraced, defaults, helpers, composed, heldConsts, wrappedRefs, byFile };
}

/** The `const` whose whole value `node` is (top-level or function-local), or null. */
function constHolding(node: ts.Node): ts.VariableDeclaration | null {
  const declaration = climbPath(node).parent;
  return declaration && ts.isVariableDeclaration(declaration) && declaration.initializer === climbPath(node)
    && ts.isIdentifier(declaration.name) && isConstList(declaration) ? declaration : null;
}
/** Round 11: whether a use of a '/api' prefix (a name for it) is read as one /api/ path: written
 * into a template or `+` that is one, or held in a local const each of whose uses is. */
function prefixUseRead(use: ts.Node, depth = 0): boolean {
  const whole = climbPath(helperName(use));
  if (literalTexts(whole).some((text) => text.includes('/api/'))) return true;
  const held = constHolding(whole);
  return !!held && !isTopConstValue(whole) && depth < 4 && prefixUsesRead(held, depth + 1);
}
/** Whether every use of a function-local const holding a '/api' prefix is read (at least one). */
function prefixUsesRead(declaration: ts.VariableDeclaration, depth = 0): boolean {
  if (isTopConstValue(declaration.initializer!)) return true; // checked at each use, file by file
  const name = declaration.name as ts.Identifier;
  const uses: ts.Identifier[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isIdentifier(n) && n !== name && n.text === name.text && localConst(n) === declaration) uses.push(n);
    ts.forEachChild(n, visit);
  };
  visit(declaration.parent.parent.parent);
  return uses.length > 0 && uses.every((use) => prefixUseRead(use, depth));
}

/** The initializer of a top-level `const`. */
function isTopConstValue(node: ts.Node): boolean {
  const declaration = node.parent;
  return !!declaration && ts.isVariableDeclaration(declaration) && declaration.initializer === node
    && ts.isVariableStatement(declaration.parent.parent) && ts.isSourceFile(declaration.parent.parent.parent);
}

/** The template or `+` of strings a helper's call is written in (or the call itself). */
function composeRoot(call: ts.Node): ts.Node {
  let n = call;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isTemplateSpan(n.parent) && n.parent.expression === n
    || ts.isTemplateExpression(n.parent) || ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) n = n.parent;
  return n;
}
const holds = (outer: ts.Node, inner: ts.Node) => inner.pos >= outer.pos && inner.end <= outer.end;
/** The texts of `node` with the helper's `call` read as each of the helper's paths. */
function composedTexts(node: ts.Node, call: ts.Node, texts: string[]): string[] {
  if (node === call) return texts;
  if (ts.isParenthesizedExpression(node)) return composedTexts(node.expression, call, texts);
  const part = (e: ts.Expression) => holds(e, call) ? composedTexts(e, call, texts) : spanChoices(e);
  if (ts.isTemplateExpression(node)) {
    let out = [node.head.text];
    for (const span of node.templateSpans) {
      const choices = part(span.expression);
      out = out.flatMap((head) => choices.map((choice) => head + choice + span.literal.text));
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = holds(node.left, call) ? composedTexts(node.left, call, texts) : [literalText(node.left) ?? nameText(node.left) ?? '\uE000'];
    const right = holds(node.right, call) ? composedTexts(node.right, call, texts) : [literalText(node.right) ?? nameText(node.right) ?? '\uE000'];
    return left.flatMap((l) => right.map((r) => l + r));
  }
  return ['\uE000'];
}

/**
 * Round 11 (review 9 LOW-3): a path handed to a same-file function (`const post = (u) =>
 * apiFetch(u, …)`, a function declaration) whose parameter at that place is a transport's path:
 * 'responds' when the function returns that transport's Response (its caller's `!res.ok` is
 * what's read); null when it throws on every failure answer (a throwing call, as before) or for
 * any other call; 'unread' when it reads the answer some other way (listed).
 * Round 13 (review 10 LOW-3): the function is also found through an import (by name, an alias, a
 * re-export, a namespace) and as a member of a top-level object (`http.post(…)`, same file or
 * imported). 'unknown': the callee is one of the trace's own files' functions or objects, but
 * the trace can't read which function it is (listed, never decided by the catch around it).
 */
function paramWrapper(at: ts.Node): 'responds' | 'unread' | 'unknown' | null {
  const top = climbPath(at);
  const call = top.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(top as ts.Expression)) return null;
  if (TRANSPORT_NAMES.has(calleeName(call))) return null;
  const found = calledFunction(call);
  if (found === 'unknown') return 'unknown';
  const fn = found;
  const param = fn?.parameters[call.arguments.indexOf(top as ts.Expression)]?.name;
  if (!fn?.body || !param || !ts.isIdentifier(param)) return null;
  const sends: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ANSWERS_WITH_RESPONSE.has(calleeName(node)) && node.arguments[0]) {
      let arg: ts.Expression = node.arguments[0];
      while (ts.isParenthesizedExpression(arg) || reshapes(arg)) arg = (arg as ts.ParenthesizedExpression).expression;
      if (ts.isIdentifier(arg) && arg.text === param.text) sends.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(fn.body);
  if (sends.length === 0) return null;
  const returned = (send: ts.Node): boolean => {
    let n = send;
    while (n.parent && (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent) || reshapes(n.parent))) n = n.parent;
    return n.parent === fn && fn.body === n || ts.isReturnStatement(n.parent) && enclosingFunction(n.parent) === fn;
  };
  if (sends.every(returned)) return 'responds';
  // One that throws on every failure answer is a throwing call: the catch around it decides.
  return sends.every((send) => returned(send) || throwsOnFailure(send)) ? null : 'unread';
}

/** The transports and path wrappers by name: a path handed to one is its request (transportAround,
 * methodOf), never a wrapper's. */
const TRANSPORT_NAMES = new Set([...GET_BY_DEFAULT, 'OfflineRefusal', 'describeSaves', 'String', 'backendUrl', 'backendUrlSync',
  'joinBackendPath', 'encodeURI']);

/** A function `name` declares at the top of `source`: `function name`, `const name = (…) => …`. */
function topFunction(source: ts.SourceFile, name: string): ts.FunctionLikeDeclaration | null {
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) return statement;
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer
        && isFunctionLike(declaration.initializer)) return declaration.initializer as ts.ArrowFunction;
    }
  }
  return null;
}
/** A top-level `const name = { … }` of `source`. */
function topObject(source: ts.SourceFile, name: string): ts.ObjectLiteralExpression | null {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      let init = declaration.initializer;
      while (init && (ts.isParenthesizedExpression(init) || reshapes(init))) init = (init as ts.ParenthesizedExpression).expression;
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && init && ts.isObjectLiteralExpression(init)) return init;
    }
  }
  return null;
}
/** Whether `source` declares `name` at its top (any value: a function, an object, a call's result). */
function declaresTop(source: ts.SourceFile, name: string): boolean {
  return source.statements.some((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name
    || ts.isClassDeclaration(statement) && statement.name?.text === name
    || ts.isVariableStatement(statement) && statement.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name));
}
/** The member `member` of an object literal: a function it holds, 'unknown' (there, but not a
 * function the trace reads), or null (not there). */
function objectMember(object: ts.ObjectLiteralExpression, member: string): ts.FunctionLikeDeclaration | 'unknown' | null {
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) return 'unknown'; // `{ ...base }`: any member may be from it
    const key = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : null;
    if (key !== member) continue;
    if (ts.isMethodDeclaration(property)) return property;
    if (ts.isPropertyAssignment(property) && isFunctionLike(property.initializer)) return property.initializer as ts.ArrowFunction;
    return 'unknown';
  }
  return null;
}
/** What `module` exports as `name` (through `export { … } from`, `export *` and a local
 * `export { a as name }`): a function, an object literal, 'unknown' (exported, but neither), or
 * null (not found). */
function exportedValue(module: string, name: string, depth = 0): ts.FunctionLikeDeclaration | ts.ObjectLiteralExpression | 'unknown' | null {
  const source = currentFiles?.get(module);
  if (!source || depth > 5) return null;
  const own = topFunction(source, name) ?? topObject(source, name);
  if (own) return own;
  const known = new Set(currentFiles!.keys());
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause && !statement.moduleSpecifier) continue;
    const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
      ? resolveModule(module, statement.moduleSpecifier.text, known) : null;
    if (!statement.exportClause) {
      const found = from ? exportedValue(from, name, depth + 1) : null;
      if (found) return found;
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    const element = statement.exportClause.elements.find((el) => el.name.text === name);
    if (!element) continue;
    const original = (element.propertyName ?? element.name).text;
    if (from) return exportedValue(from, original, depth + 1) ?? 'unknown';
    if (!statement.moduleSpecifier) return (topFunction(source, original) ?? topObject(source, original)) ?? 'unknown';
  }
  return declaresTop(source, name) ? 'unknown' : null;
}
/**
 * Round 13 (review 10 LOW-3): the function a call's callee names, where the trace can read it:
 * a same-file function (runnerNamed), one imported by name (an alias, a re-export), a namespace
 * import's member, or a member of a top-level object literal, in this file or imported
 * (`http.post(…)`). 'unknown': the callee is one of the trace's files' own (an import of them, a
 * top-level name here) but the trace can't read which function it is. Null: not the trace's own
 * (a global, a package, a parameter), read as before.
 */
function calledFunction(call: ts.CallExpression): ts.FunctionLikeDeclaration | 'unknown' | null {
  const source = call.getSourceFile();
  const callee = call.expression;
  const asFunction = (found: ts.FunctionLikeDeclaration | ts.ObjectLiteralExpression | 'unknown' | null) =>
    found === null ? 'unknown' : found === 'unknown' || ts.isObjectLiteralExpression(found) ? 'unknown' : found;
  if (ts.isIdentifier(callee)) {
    const own = runnerNamed(callee) as ts.FunctionLikeDeclaration | null;
    if (own) return own;
    const bound = importOf(source, callee.text);
    if (bound) return bound.name === null ? 'unknown' : asFunction(exportedValue(bound.module, bound.name));
    return null;
  }
  if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return null;
  const object = callee.expression.text;
  const member = callee.name.text;
  const bound = importOf(source, object);
  if (bound) {
    if (bound.name === null) return asFunction(exportedValue(bound.module, member));
    const value = exportedValue(bound.module, bound.name);
    if (value === null || value === 'unknown' || !ts.isObjectLiteralExpression(value)) return 'unknown';
    return objectMember(value, member) ?? 'unknown';
  }
  const local = topObject(source, object);
  if (local) return objectMember(local, member) ?? 'unknown';
  return null;
}

/** Functions that return an /api/ path (`const presetsPath = () => '/api/presets'`), by
 * `file#name`, with each path (round 11: a helper that picks between two keeps both). */
function pathHelpers(literals: Frontend['literals']): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const { text, unit, node } of literals) {
    let top = climbPath(node);
    while (top.parent && ts.isCallExpression(top.parent) && top.parent.arguments.includes(top as ts.Expression)
      && PATH_WRAPPERS.has(calleeName(top.parent))) top = climbPath(top.parent);
    const body = unitBody(unit);
    const returned = top.parent && (top.parent === body && isFunctionLike(body) && (body as ts.ArrowFunction).body === top
      || ts.isReturnStatement(top.parent) && enclosingFunction(top.parent) === body);
    if (returned) out.set(`${unit.file}#${unit.name}`, [...(out.get(`${unit.file}#${unit.name}`) ?? []), text]);
  }
  return out;
}
function enclosingFunction(node: ts.Node): ts.Node | undefined {
  let n = node.parent;
  while (n && !isFunctionLike(n) && !ts.isFunctionDeclaration(n) && !ts.isMethodDeclaration(n)) n = n.parent;
  return n;
}

/** Constructors and functions whose /api/ argument only names a request (nothing is sent):
 * graphStore's describeSaves turns a path into the settings GM's lines name. */
const DESCRIBES = new Set(['OfflineRefusal', 'describeSaves']);
function describesOnly(node: ts.Node): boolean {
  let n: ts.Node = node;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isBinaryExpression(n.parent) || ts.isTemplateSpan(n.parent))) n = n.parent;
  if (ts.isBinaryExpression(node.parent) && COMPARES.has(node.parent.operatorToken.kind)) return true; // `path === '/api/…'`
  return !!n.parent && (ts.isNewExpression(n.parent) || ts.isCallExpression(n.parent) && n.parent.arguments.includes(n as ts.Expression))
    && ts.isIdentifier(n.parent.expression) && DESCRIBES.has(n.parent.expression.text);
}
const COMPARES = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
/** Climbs from a path literal through what still names the same request: parentheses, a concat,
 * a template, and either branch of a conditional (`want ? '/a' : '/b'`). Round 9 (review 7
 * LOW-2): also the whole template, and await, `as`, `satisfies`, `!` and `<T>x`. */
function climbPath(at: ts.Node): ts.Node {
  let n: ts.Node = at;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isBinaryExpression(n.parent) || ts.isTemplateSpan(n.parent)
    || ts.isTemplateExpression(n.parent) || reshapes(n.parent)
    || ts.isConditionalExpression(n.parent) && n.parent.condition !== n)) n = n.parent;
  return n;
}
/** Wrappers that change a value's type or wait for it, not what it is. */
const reshapes = (node: ts.Node): boolean => ts.isAwaitExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)
  || ts.isNonNullExpression(node) || ts.isTypeAssertionExpression(node);

/** Calls that only turn a path into a URL or a string; they send nothing. */
const PATH_WRAPPERS = new Set(['String', 'backendUrl', 'backendUrlSync', 'joinBackendPath', 'encodeURI']);
const calleeName = (call: ts.CallExpression): string => ts.isIdentifier(call.expression) ? call.expression.text
  : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';

/** The expression a helper's reference makes its path with: `helper()`, `paths.helper()`, and
 * (round 10, review 8 LOW-1) `paths['helper']()`. */
function helperCall(at: ts.Node): ts.Node {
  const n = helperName(at);
  return n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n ? n.parent : at;
}
/** A helper's reference with the object it is read from: `paths.helper`, `paths['helper']`. */
function helperName(at: ts.Node): ts.Node {
  if (at.parent && ts.isPropertyAccessExpression(at.parent) && at.parent.name === at) return at.parent;
  if (at.parent && ts.isElementAccessExpression(at.parent) && at.parent.argumentExpression === at) return at.parent;
  return at;
}
/** Round 10 (review 8 LOW-1, fail closed): a path helper handed to a call uncalled
 * (`send(presetsPath)`): the call that makes its path isn't read, so it is listed. */
function helperPassed(at: ts.Node): boolean {
  let n = helperName(at);
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || reshapes(n.parent))) n = n.parent;
  return !!n.parent && (ts.isCallExpression(n.parent) || ts.isNewExpression(n.parent)) && !!n.parent.arguments?.includes(n as ts.Expression);
}

/**
 * Round 9 (review 7 LOW-2, fail closed): a path, or a path helper's call, whose use the trace
 * can't read once it went through await, `as`, `!`, a template or a URL wrapper (or, for a
 * helper, at all): not a transport's path, not a call's argument, not returned, not a const that
 * is followed as its own function. It is listed as untraced; no catch decides it.
 */
function unreadUse(at: ts.Node, helper: boolean): boolean {
  if (transportAround(at)) return false;
  let n = helper ? helperCall(at) : at;
  let wrapped = helper;
  for (;;) {
    const top = climbPath(n);
    for (let m = n; m !== top; m = m.parent) if (reshapes(m.parent) || ts.isTemplateSpan(m.parent)) wrapped = true;
    const parent = top.parent;
    if (parent && ts.isCallExpression(parent) && parent.arguments.includes(top as ts.Expression) && PATH_WRAPPERS.has(calleeName(parent))) {
      wrapped = true;
      n = parent;
      continue;
    }
    if (!wrapped || !parent) return wrapped;
    if (ts.isCallExpression(parent) && parent.arguments.includes(top as ts.Expression)) return false;
    if (ts.isReturnStatement(parent) || isFunctionLike(parent) && (parent as ts.ArrowFunction).body === top) return false;
    // Left as a statement it sends nothing, unless it is assigned to a name.
    if (ts.isExpressionStatement(parent)) return ts.isBinaryExpression(top) && top.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    return !(ts.isVariableDeclaration(parent) && parent.initializer === top && (ts.isCallExpression(top) || isFunctionLike(top)));
  }
}

const isAssignment = (node: ts.Node): boolean => ts.isBinaryExpression(node)
  && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

/**
 * Round 10 (review 8 LOW-1, fail closed): a path held in a name or an object inside a function.
 * - 'followed': the whole value of a function-local `const` (read through a conditional whose
 *   branches are both read), used by name: each use is read as the path written there
 *   (literalTexts), so this one isn't.
 * - 'unread': a `let` or `var`, a name or property assigned (`u = '/api/…'`), a destructured
 *   const, a conditional with a branch that can't be read, a const never used, an object's
 *   property (`const cfg = { url: '/api/…' }`, `{ u }`). Listed.
 * - null: anything else, read as before.
 */
function heldPath(node: ts.Node): 'followed' | 'unread' | null {
  const top = climbPath(node);
  for (let m: ts.Node = node; m !== top.parent && m; m = m.parent) if (isAssignment(m)) return 'unread';
  const parent = top.parent;
  if (!parent) return null;
  if (ts.isVariableDeclaration(parent) && parent.initializer === top) {
    const statement = parent.parent?.parent;
    if (statement && ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent)) return null; // a top-level const: followed as its own unit
    const name = ts.isIdentifier(parent.name) ? parent.name : null;
    if (!name || !isConstList(parent) || readableTexts(top) === null) return 'unread';
    let used = false;
    const visit = (n: ts.Node) => {
      if (used) return;
      if (ts.isIdentifier(n) && n !== name && n.text === name.text && localConst(n) === parent) used = true;
      ts.forEachChild(n, visit);
    };
    if (statement?.parent) visit(statement.parent);
    return used ? 'followed' : 'unread';
  }
  // Held in an object the trace doesn't read into.
  if (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) return 'unread';
  return null;
}

/** /api/ text the trace can't follow to a function: each must be declared (round 6, fail closed). */
export function untracedApiText(): Untraced[] {
  return frontend().untraced;
}

/** What happens to a refusal at a call in a unit (review 4 MEDIUM-1, round 6): the catch around
 * this call registers its line ('keeps'), throws it on to the unit's callers ('passes'), or
 * neither ('drops', which must be declared). */
export type Outcome = 'keeps' | 'passes' | 'drops';

const isStoreAction = (unit: Unit) => unit.file.startsWith('store/') && (ts.isPropertyAssignment(unit.node) || ts.isMethodDeclaration(unit.node));

/** `const x = useStore((s) => s.action)`: only a name for the action, followed to its calls. */
function isSelector(unit: Unit): boolean {
  if (!ts.isVariableDeclaration(unit.node) || !unit.node.initializer || !ts.isCallExpression(unit.node.initializer)) return false;
  const call = unit.node.initializer;
  const callee = call.expression.getText();
  const [arg] = call.arguments;
  return /(?:^|\.)use[A-Z]\w*$/.test(callee) && !!arg && isFunctionLike(arg)
    && ts.isPropertyAccessExpression((arg as ts.ArrowFunction).body);
}

function throwsIn(handler: ts.Node): boolean {
  let found = false;
  const visit = (node: ts.Node) => {
    if (found || (node !== handler && (isFunctionLike(node) || ts.isFunctionDeclaration(node)))) return;
    if (ts.isThrowStatement(node)) found = true;
    ts.forEachChild(node, visit);
  };
  if (isFunctionLike(handler)) ts.forEachChild((handler as ts.ArrowFunction).body, visit); else visit(handler);
  return found;
}

/** Whether `node` calls (by name) a function of `file` that keeps its line: `keeper(…)`,
 * `get().keeper(…)`, `state.keeper(…)`; never a global's method of the same name (`console.error`). */
function callsKeeper(file: string, node: ts.Node, except: string): boolean {
  const keepers = keepersIn(file);
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) && !(ts.isIdentifier(callee.expression) && GLOBALS.has(callee.expression.text)) ? callee.name.text : null;
      if (name && name !== except && keepers.has(name)) found = true;
      if (storeKeeper(file, n)) found = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** `useGraphStore.getState().notify(…)`: an imported store's action whose own body registers (round
 * 7: Create's Generate line goes through graphStore's notify). */
function storeKeeper(file: string, call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !ts.isCallExpression(callee.expression)) return false;
  const getState = callee.expression.expression;
  if (!ts.isPropertyAccessExpression(getState) || getState.name.text !== 'getState' || !ts.isIdentifier(getState.expression)) return false;
  const store = getState.expression.text;
  for (const [module, taken] of frontend().imports.get(file) ?? []) {
    if (!taken.names.has(store) || keepersBuilding.has(module)) continue;
    if (keepersIn(module).has(callee.name.text)) return true;
  }
  return false;
}
const keepersBuilding = new Set<string>();
const GLOBALS = new Set(['console', 'window', 'document', 'Promise', 'JSON', 'Object', 'Math', 'Array']);

function handlerOutcome(unit: Unit, handler: ts.Node): Outcome {
  if (marked(handler) || callsKeeper(unit.file, handler, unit.name)) return 'keeps';
  return throwsIn(handler) ? 'passes' : 'drops';
}

/** Calls that answer a refusal with a Response instead of throwing it: a catch around them sees
 * only a lost connection, so the function's own handling of `!res.ok` is what's read. */
const ANSWERS_WITH_RESPONSE = new Set(['fetch', 'apiFetch', 'graphMutationFetch']);
function answersWithResponse(at: ts.Node): boolean {
  return transportAround(at) !== null;
}

/** The fetch, apiFetch or graphMutationFetch call `at` is the path of: the path itself, or (round 8,
 * review 6 gates LOW-4) a call that makes it (`apiFetch(presetsPath(), …)`), whose Response is the
 * transport's, not the helper's. */
function transportAround(at: ts.Node): ts.CallExpression | null {
  // Round 9 (review 7 LOW-2): a method helper (`paths.presets()`), and a call around the path
  // that isn't a transport (`String(x)`, `backendUrl(x)`): the transport's path is what counts.
  // Round 11 (review 9 LOW-3): a const read off a namespace (`apiFetch(paths.PRESETS_PATH)`) is
  // the property access.
  const start = climbPath(at);
  const called = helperCall(start);
  let n = climbPath(called === start ? helperName(start) : called);
  for (;;) {
    const call = n.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(n as ts.Expression)) return null;
    if (ANSWERS_WITH_RESPONSE.has(calleeName(call))) return call;
    n = climbPath(call);
  }
}

/** The call around a path literal (or the node itself when it is a call). */
function callAround(at: ts.Node): ts.CallExpression | null {
  if (ts.isCallExpression(at)) return at;
  const transport = transportAround(at);
  if (transport) return transport;
  const n = climbPath(at);
  if (n.parent && ts.isCallExpression(n.parent) && n.parent.arguments.includes(n as ts.Expression)) return n.parent;
  if (n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n) return n.parent;
  if (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n && ts.isCallExpression(n.parent.parent)) return n.parent.parent;
  return null;
}

/** Whether the unit hands the call's own value back (`return call(…)`, an arrow whose body is the
 * call, or `const r = await call(…); … return r`): a Response it returns goes to its callers. */
function returnsCall(unit: Unit, call: ts.Node): boolean {
  for (let n: ts.Node = call; n.parent && n !== unit.node; n = n.parent) {
    if (ts.isReturnStatement(n.parent)) return true;
    if (isFunctionLike(n.parent) && (n.parent as ts.ArrowFunction).body === n) return n.parent === unitBody(unit);
    if (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent) || ts.isConditionalExpression(n.parent)) continue;
    if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
      const name = n.parent.name.text;
      let returned = false;
      const visit = (node: ts.Node) => {
        if (ts.isReturnStatement(node) && node.expression && ts.isIdentifier(node.expression) && node.expression.text === name) returned = true;
        if (!returned) ts.forEachChild(node, visit);
      };
      visit(unit.node);
      return returned;
    }
    break;
  }
  return false;
}

/** The function node a unit stands for (its declaration, or the function a const holds). */
function unitBody(unit: Unit): ts.Node {
  if (ts.isVariableDeclaration(unit.node) && unit.node.initializer) {
    const init = unit.node.initializer;
    if (isFunctionLike(init)) return init;
    if (ts.isCallExpression(init)) { const fn = init.arguments.find((arg) => isFunctionLike(arg)); if (fn) return fn; }
  }
  if (ts.isPropertyAssignment(unit.node)) return unit.node.initializer;
  return unit.node;
}

/** The name the call's Response is bound to: `const res = await call(…)`, or a `.then((res) => …)`
 * on it; with the callback that reads it. */
function responseBinding(call: ts.Node): { name: string; scope: ts.Node } | null {
  let n: ts.Node = call;
  while (n.parent && (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent) || ts.isConditionalExpression(n.parent))) n = n.parent;
  if (ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
    let scope: ts.Node = n.parent;
    while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
    return { name: n.parent.name.text, scope };
  }
  // `res = await call(…)` into a `let res` declared further out: the branches on it are in the
  // block that declares it.
  if (ts.isBinaryExpression(n.parent) && n.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && n.parent.right === n && ts.isIdentifier(n.parent.left)) {
    const name = n.parent.left.text;
    for (let scope: ts.Node | undefined = n.parent.parent; scope; scope = scope.parent) {
      if (!ts.isBlock(scope)) continue;
      const declares = scope.statements.some((st) => ts.isVariableStatement(st)
        && st.declarationList.declarations.some((decl) => ts.isIdentifier(decl.name) && decl.name.text === name));
      if (declares) return { name, scope };
      if (isFunctionLike(scope.parent)) break;
    }
    return null;
  }
  if (ts.isPropertyAccessExpression(n.parent) && n.parent.expression === n && n.parent.name.text === 'then'
    && ts.isCallExpression(n.parent.parent)) {
    const handler = n.parent.parent.arguments[0];
    if (handler && isFunctionLike(handler)) {
      const param = (handler as ts.ArrowFunction).parameters[0];
      if (param && ts.isIdentifier(param.name)) return { name: param.name.text, scope: handler };
    }
  }
  return null;
}

/** Whether every failure branch on the Response a call answers with throws: a function that returns
 * it only once it is ok hands its callers a throw, not a Response to read. */
function throwsOnFailure(call: ts.Node): boolean {
  const bound = responseBinding(call);
  const branches = bound ? failureBranches(bound.name, bound.scope) : [];
  return branches.length > 0 && branches.every((group) => group.some((branch) => throwsIn(branch)));
}

/** The failure branches of a Response named `name` in `scope`: `if (!r.ok) {…}`, the else of
 * `if (r.ok) {…} else {…}`, and the statements after `if (r.ok) return …`. */
function failureBranches(name: string, scope: ts.Node): ts.Node[][] {
  const out: ts.Node[][] = [];
  const okOf = (expr: ts.Expression): 'ok' | 'not' | null => {
    let e = expr;
    while (ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isPropertyAccessExpression(e) && e.name.text === 'ok' && ts.isIdentifier(e.expression) && e.expression.text === name) return 'ok';
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return okOf(e.operand) === 'ok' ? 'not' : null;
    return null;
  };
  const visit = (node: ts.Node) => {
    if (ts.isIfStatement(node)) {
      const test = okOf(node.expression);
      if (test === 'not') out.push([node.thenStatement]);
      if (test === 'ok') {
        if (node.elseStatement) out.push([node.elseStatement]);
        else if (ts.isBlock(node.parent) || ts.isSourceFile(node.parent)) {
          const statements = (node.parent as ts.Block).statements;
          const rest = statements.slice(statements.indexOf(node) + 1);
          if (rest.length > 0) out.push([...rest]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return out;
}

/**
 * What happens to a refusal at a call in a unit (review 4 MEDIUM-1, round 6; review 5 MEDIUM-1
 * and gates-security LOW-1, round 7):
 * - A call that answers with a Response (fetch, apiFetch, graphMutationFetch, or a function that
 *   returns one): the unit returns it to its callers ('passes'), or each failure branch on it
 *   (`!res.ok`) registers its line there (a marker, or a direct call to a function whose own
 *   body registers: 'keeps'), throws it to a catch (read as below), or neither ('drops'). An
 *   unchecked Response drops.
 * - Otherwise the catch around this call registers ('keeps'), throws on ('passes'), or neither.
 * - No catch: awaited or returned, it goes to the unit's callers ('passes'); left to itself, it
 *   drops. Never the unit-wide guess of old.
 */
export function outcomeAt(unit: Unit, at: ts.Node, responds = false): Outcome {
  if (unit.constant || isSelector(unit)) return 'passes';
  const transport = transportAround(at);
  const call = transport ?? callAround(at);
  if (call && (responds || transport)) {
    if (returnsCall(unit, call)) return 'passes';
    const bound = responseBinding(call);
    const branches = bound ? failureBranches(bound.name, bound.scope) : [];
    if (branches.length === 0) return 'drops';
    let result: Outcome = 'keeps';
    for (const group of branches) {
      const keeps = group.some((branch) => marked(branch) || callsKeeper(unit.file, branch, unit.name));
      const thrower = group.find((branch) => throwsIn(branch));
      const here: Outcome = keeps ? 'keeps' : thrower ? catchOutcome(unit, thrower, true) : 'drops';
      if (here === 'drops') return 'drops';
      if (here === 'passes') result = 'passes';
    }
    return result;
  }
  return catchOutcome(unit, at);
}

/** The catches around `at`, inside out: a catch that throws on hands it to the next one out, in
 * this unit or its callers. */
function catchOutcome(unit: Unit, at: ts.Node, throwing = false): Outcome {
  let thrown = false;
  for (let n: ts.Node = at; n.parent && n !== unit.node; n = n.parent) {
    const parent = n.parent;
    let handler: ts.Node | null = null;
    if (ts.isTryStatement(parent) && parent.tryBlock === n && parent.catchClause) handler = parent.catchClause.block;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === n && ts.isCallExpression(parent.parent)
      && parent.parent.expression === parent) {
      const [first, second] = parent.parent.arguments;
      if (parent.name.text === 'catch' && first) handler = first;
      if (parent.name.text === 'then' && second) handler = second;
    }
    if (!handler) continue;
    const outcome = handlerOutcome(unit, handler);
    if (outcome !== 'passes') return outcome;
    thrown = true;
  }
  if (runnerKeeps(unit, at)) return 'keeps';
  if (thrown) return 'passes';
  // No catch around it: thrown from the unit's own body, or awaited or returned there, the
  // refusal goes to whoever calls this unit; left in a promise nobody holds, it drops.
  return escapes(unit, at, throwing) ? 'passes' : 'drops';
}

/** Whether `at` sits in a callback handed to a same-file runner (`run(async () => …)`) that
 * awaits that callback inside a try whose catch registers the line (round 7). */
function runnerKeeps(unit: Unit, at: ts.Node): boolean {
  const body = unitBody(unit);
  for (let n: ts.Node = at; n.parent && n !== body; n = n.parent) {
    const call = n.parent;
    // A callback, or the helper itself handed over by name (`act(checkKreaConnection)`).
    if (!(isFunctionLike(n) || n === at && ts.isIdentifier(n)) || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
    const index = call.arguments.indexOf(n as ts.Expression);
    if (index < 0) continue;
    const runners = runnersNamed(call.expression);
    return runners.length > 0 && runners.every((runner) => {
      const param = runner.parameters[index]?.name;
      if (!param || !ts.isIdentifier(param)) return false;
      let keeps = false;
      const visit = (node: ts.Node) => {
        if (keeps) return;
        if (ts.isTryStatement(node) && node.catchClause && callsName(node.tryBlock, param.text)
          && handlerOutcome(unit, node.catchClause.block) === 'keeps') keeps = true;
        ts.forEachChild(node, visit);
      };
      visit(runner);
      return keeps;
    });
  }
  return false;
}

/** The runner a name stands for, or, for a component's prop (`{ run }: Props`), the runner every
 * `<Component run={…}>` in the file hands it (none found: none). */
function runnersNamed(name: ts.Identifier): ts.SignatureDeclaration[] {
  const own = runnerNamed(name);
  if (own) return [own];
  for (let n: ts.Node | undefined = name.parent; n; n = n.parent) {
    if (!ts.isFunctionDeclaration(n) || !n.name) continue;
    const prop = n.parameters[0]?.name;
    if (!prop || !ts.isObjectBindingPattern(prop)) return [];
    const bound = prop.elements.find((el) => ts.isIdentifier(el.name) && el.name.text === name.text);
    if (!bound) return [];
    const key = bound.propertyName && ts.isIdentifier(bound.propertyName) ? bound.propertyName.text : name.text;
    const component = n.name.text;
    const passed: (ts.SignatureDeclaration | null)[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName) && node.tagName.text === component) {
        const attr = node.attributes.properties.find((a) => ts.isJsxAttribute(a) && ts.isIdentifier(a.name) && a.name.text === key) as ts.JsxAttribute | undefined;
        const value = attr?.initializer && ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : undefined;
        passed.push(value && ts.isIdentifier(value) ? runnerNamed(value) : null);
      }
      ts.forEachChild(node, visit);
    };
    visit(n.getSourceFile());
    return passed.length > 0 && passed.every(Boolean) ? passed as ts.SignatureDeclaration[] : [];
  }
  return [];
}

/** The function a name is declared as, in a scope around the name (same file). */
function runnerNamed(name: ts.Identifier): ts.SignatureDeclaration | null {
  for (let scope: ts.Node | undefined = name.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of (scope as ts.Block).statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name.text) return statement;
      if (ts.isVariableStatement(statement)) for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.name.text !== name.text || !decl.initializer) continue;
        if (isFunctionLike(decl.initializer)) return decl.initializer as ts.ArrowFunction;
        // `const act = useCallback(async (work) => …, [])`
        if (ts.isCallExpression(decl.initializer) && ts.isIdentifier(decl.initializer.expression) && decl.initializer.expression.text === 'useCallback'
          && decl.initializer.arguments[0] && isFunctionLike(decl.initializer.arguments[0])) return decl.initializer.arguments[0] as ts.ArrowFunction;
      }
    }
  }
  return null;
}

function callsName(node: ts.Node, name: string): boolean {
  let found = false;
  const visit = (child: ts.Node) => {
    if (found) return;
    if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === name) found = true;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/** Whether a refusal at `node` (a throw when `throwing`, else a call's rejection) leaves the unit:
 * through `.then`/`.catch`/`.finally` callbacks to the chain they're on, then out of the unit's
 * body by a throw, an await or a return. */
function escapes(unit: Unit, node: ts.Node, throwing: boolean): boolean {
  const body = unitBody(unit);
  let inline = throwing;
  for (let n: ts.Node = node; n.parent; n = n.parent) {
    if (n === body) return inline;
    // Handed to a child as a prop (`onAccept={accept}`): the child's call meets the refusal.
    if (ts.isJsxAttribute(n)) return false;
    if (ts.isAwaitExpression(n) || ts.isReturnStatement(n)) inline = true;
    if (isFunctionLike(n.parent) && (n.parent as ts.ArrowFunction).body === n) {
      if (n.parent === body) return inline || !ts.isBlock(n);
      // A callback: its rejection rides only on a promise chain it is part of.
      const fn = n.parent;
      const call = fn.parent;
      if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)
        || !/^(?:then|catch|finally)$/.test(call.expression.name.text)) return false;
      inline = false;
      n = fn; // continue from the chain's call
      continue;
    }
    if (ts.isFunctionDeclaration(n) && n !== body) return false;
  }
  return false;
}

/** The functions outside lib/ that send `route`, by `file#name`, each with its unit. A lib
 * helper, a path const, a selector and a function whose catch throws the refusal on are followed
 * to their callers; a lib helper reached by nothing is itself returned (fail closed). */
export function callersOf(route: { method: string; path: string }, extraStarts: string[] = [], stopAt: Set<string> = new Set()): Map<string, Unit> {
  const { files, references, imports, literals, defaults, helpers, composed, heldConsts, wrappedRefs } = frontend();
  const known = new Set(files.map((entry) => entry.file));
  const queue: Unit[] = [];
  const found = new Map<string, Unit>();
  const keep = (id: string, unit: Unit, outcome: Outcome, at: ts.Node = unit.node) => {
    const before = found.get(id);
    found.set(id, { ...unit, outcome: before?.outcome === 'drops' ? 'drops' : outcome, points: [...(before?.points ?? []), at] });
  };
  const reach = (unit: Unit, at: ts.Node, responds = false) => {
    const id = `${unit.file}#${unit.name}`;
    // A function that hands back a Response it got: its callers read `!res.ok` (round 7).
    const call = callAround(at);
    const handsBack = !!call && (responds || answersWithResponse(at)) && returnsCall(unit, call) && !throwsOnFailure(call);
    // A lib helper the ratchet declares as where its route's answer stops (stopAt).
    if (stopAt.has(id)) keep(id, unit, 'drops', at);
    else if (unit.file.startsWith('lib/')) {
      // A lib helper whose branch or catch registers the line (settingsWrites' `fail`) keeps it;
      // any other hands the refusal, or the Response, to its callers.
      if (!handsBack && outcomeAt(unit, at, responds) === 'keeps') keep(id, unit, 'keeps', at); else queue.push({ ...unit, responds: handsBack });
    } else {
      const outcome = outcomeAt(unit, at, responds);
      if (outcome === 'passes') { passed.add(id); queue.push({ ...unit, responds: handsBack }); } else keep(id, unit, outcome, at);
    }
  };
  const passed = new Set<string>();
  for (const literal of literals) {
    if ((literal.method === '*' || literal.method === route.method) && sendsTo(literal.text, route.path)) {
      if (literal.unit.constant) queue.push(literal.unit); else reach(literal.unit, literal.node, literal.wrapped);
    }
  }
  for (const start of extraStarts) {
    const [file, name] = start.split('#');
    const parsed = files.find((entry) => entry.file === file);
    let unit: Unit | null = null;
    const visit = (node: ts.Node) => {
      if (unit) return;
      if (ts.isIdentifier(node) && node.text === name) {
        const candidate = unitOf(file, node);
        if (candidate?.name === name) unit = candidate;
      }
      ts.forEachChild(node, visit);
    };
    if (parsed) visit(parsed.source);
    if (!unit) throw new Error(`no ${start}`);
    reach(unit, (unit as Unit).node);
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const unit = queue.shift()!;
    const id = `${unit.file}#${unit.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    let followed = 0;
    const named = [unit.name];
    // A local name is followed only inside the scope that declares it (round 7: `refused` in
    // one function isn't `refused` in another).
    const scope = unit.wide ? null : declaringScope(unit.node);
    for (const name of named) for (const reference of references.get(name) ?? []) {
      if (!unit.wide && reference.file !== unit.file) continue;
      if (scope && !within(reference.node, scope)) continue;
      const parent = reference.node.parent;
      // `typeof helper` in a type names it; it sends nothing.
      if (ts.isTypeQueryNode(parent)) { followed += 1; continue; }
      // Round 11: a helper's call read as part of a longer path, or a path const read at the
      // local that holds it (or listed): that path, or the local's uses, are the request.
      if ((helpers.has(id) && composed.has(reference.node) || unit.constant && heldConsts.has(reference.node))
        && (reference.file === unit.file || imports.get(reference.file)?.has(unit.file))) { followed += 1; continue; }
      // Another file reaches an exported helper only through an import of its module: by name
      // (`import { helper }`), through a namespace (`api.helper`), an imported object or instance
      // (`styles.save()`), a store's action (`getState().action()`), or a dynamic import.
      // `export { helper as alias } from './x'`: follow the alias from that file.
      if (ts.isExportSpecifier(parent) && parent.propertyName === reference.node) {
        const from = parent.parent.parent.moduleSpecifier;
        if (from && ts.isStringLiteral(from) && resolveModule(reference.file, from.text, known) === unit.file) {
          queue.push({ file: reference.file, name: parent.name.text, wide: true, node: parent });
          followed += 1;
        }
        continue;
      }
      if (reference.file !== unit.file && !reachesThroughImport(imports.get(reference.file)?.get(unit.file), reference.node, isStoreAction(unit))
        && !(isStoreAction(unit) && reachesStoreThroughAlias(imports.get(reference.file), unit.file, imports))) continue;
      // `const { action } = useStore.getState()` (review 5 LOW-7, round 7): the local name is
      // followed to its calls in that file.
      if (ts.isBindingElement(parent) && ((parent.propertyName ?? parent.name) === reference.node) && ts.isIdentifier(parent.name)) {
        queue.push({ file: reference.file, name: parent.name.text, wide: false, node: parent, responds: unit.responds });
        followed += 1;
        continue;
      }
      // `import { helper as alias }`: follow the alias in that file.
      if (ts.isImportSpecifier(parent) && parent.propertyName === reference.node) {
        queue.push({ file: reference.file, name: parent.name.text, wide: false, node: parent });
        followed += 1;
        continue;
      }
      // A helper called with another method word (`requestConnection('GET')`) sends another route.
      const call = parent && ts.isCallExpression(parent) && parent.expression === reference.node ? parent
        : parent && ts.isPropertyAccessExpression(parent) && parent.name === reference.node && ts.isCallExpression(parent.parent)
          && parent.parent.expression === parent ? parent.parent : null;
      const word = call?.arguments.find((argument) => ts.isStringLiteralLike(argument) && HTTP_METHOD.test(argument.text));
      if (word && ts.isStringLiteralLike(word) && word.text !== route.method) continue;
      const caller = unitOf(reference.file, reference.node);
      if (!caller || (caller.file === unit.file && caller.name === unit.name)) continue;
      followed += 1;
      // Round 9: a path helper's call whose use can't be read (listed as untraced) drops here;
      // round 10, so does a helper handed to a call uncalled (`send(presetsPath)`).
      if (helpers.has(id) && (helperPassed(reference.node) || helperCall(reference.node) !== reference.node && unreadUse(reference.node, true))) {
        keep(`${caller.file}#${caller.name}`, caller, 'drops', reference.node);
        continue;
      }
      // Round 13 (review 10 LOW-3): handed to a function that returns the transport's Response:
      // what that call's answer is read as decides it.
      const wrapperCall = wrappedRefs.get(reference.node);
      reach({ ...caller, via: id }, wrapperCall ?? reference.node, unit.responds || !!wrapperCall);
    }
    // A module's default export, imported under another name.
    if (defaults.get(unit.file) === unit.name) {
      for (const [file, from] of imports) for (const local of from.get(unit.file)?.defaults ?? []) {
        queue.push({ file, name: local, wide: false, node: unit.node });
        followed += 1;
      }
    }
    // Fail closed (round 6; round 7, every unit): a function the trace reached and must follow
    // (a lib helper, one whose catch throws on, a store action, a destructured name) but can't
    // follow to any caller (a class built with `new`, a helper passed as a value) is returned,
    // so it must be declared.
    if (followed === 0) keep(id, unit, 'drops');
  }
  for (const id of passed) passedCache.add(id);
  return found;
}

/** The block or function a local unit is declared in (its name's scope). */
function declaringScope(node: ts.Node): ts.Node | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isBlock(n) || ts.isSourceFile(n) || isFunctionLike(n) || ts.isFunctionDeclaration(n)) return ts.isSourceFile(n) ? null : n;
  }
  return null;
}
const within = (node: ts.Node, scope: ts.Node) => node.pos >= scope.pos && node.end <= scope.end && node.getSourceFile() === scope.getSourceFile();

/** Every function the trace followed past (a catch that throws on, a selector): seen, not callers. */
const passedCache = new Set<string>();
export function passedThrough(): Set<string> { return passedCache; }

/** A store reached through modules that import it (`export const useAlias = useA` in b.ts, and
 * round 8, review 6 gates NIT-1: `export const useC = useB` in c.ts), any number of hops. */
function reachesStoreThroughAlias(from: Map<string, Taken> | undefined, store: string, imports: Map<string, Map<string, Taken>>,
  seen = new Set<string>()): boolean {
  if (!from) return false;
  for (const module of from.keys()) {
    if (seen.has(module)) continue;
    seen.add(module);
    if (imports.get(module)?.has(store)) return true;
    if (reachesStoreThroughAlias(imports.get(module), store, imports, seen)) return true;
  }
  return false;
}

function reachesThroughImport(taken: Taken | undefined, node: ts.Identifier, storeAction = false): boolean {
  if (!taken) return false;
  if (taken.dynamic) return true;
  const parent = node.parent;
  if (ts.isElementAccessExpression(parent) && storeAction) return true; // `getState()['action']()`
  // `const { action } = useStore.getState()` (round 8, review 6 gates NIT-1: round 7's follow of the
  // destructured name never ran, as the store's file was only reached through a property).
  if (storeAction && ts.isBindingElement(parent) && (parent.propertyName ?? parent.name) === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    if (storeAction) return true; // `useGraphStore.getState().action()`, `(s) => s.action`
    return ts.isIdentifier(parent.expression) && (taken.namespaces.has(parent.expression.text)
      || taken.names.has(parent.expression.text) || taken.defaults.has(parent.expression.text));
  }
  return taken.names.has(node.text);
}

const MARKED = /^\/\/ clears-on-promote: [\w.-]+/;
/**
 * The `//` comments a marker on a node may be: those inside it and the one that ends its last
 * line. Round 7: never its leading trivia, which holds the line before it (a marker there belongs
 * to the statement it ends, and counted for the next function or branch too). Round 8 (review 6
 * held LOW-5, gates LOW-4): read from the scanner's comment ranges, never the node's text, so a
 * marker's words in a string, a template, a block comment or a JSX comment (`{/* … *\/}`) aren't
 * one. JSX text isn't trivia either: no comment is read at or after it.
 */
function lineComments(node: ts.Node): string[] {
  const source = node.getSourceFile().getFullText();
  const start = node.getStart();
  const found = new Map<number, string>();
  const add = (ranges: ts.CommentRange[] | undefined) => {
    for (const range of ranges ?? []) {
      if (range.kind === ts.SyntaxKind.SingleLineCommentTrivia && range.pos >= start) found.set(range.pos, source.slice(range.pos, range.end));
    }
  };
  const jsxText = (n: ts.Node) => n.kind === ts.SyntaxKind.JsxText || n.kind === ts.SyntaxKind.JsxTextAllWhiteSpaces;
  const texts: ts.Node[] = [];
  const walk = (n: ts.Node) => {
    if (jsxText(n)) { texts.push(n); return; }
    add(ts.getLeadingCommentRanges(source, n.pos));
    add(ts.getTrailingCommentRanges(source, n.end));
    for (const child of n.getChildren()) walk(child);
  };
  walk(node);
  // A "comment" the scan found inside JSX text is the text itself.
  for (const pos of [...found.keys()]) if (texts.some((text) => pos >= text.pos && pos < text.end)) found.delete(pos);
  return [...found.values()];
}
const marked = (node: ts.Node): boolean => lineComments(node).some((comment) => MARKED.test(comment));

/** The functions in `file` whose own body registers a line (a marked call). */
const keepersCache = new Map<string, Set<string>>();
function keepersIn(file: string): Set<string> {
  const cached = keepersCache.get(file);
  if (cached) return cached;
  const parsed = frontend().files.find((entry) => entry.file === file);
  if (!parsed) return new Set();
  keepersBuilding.add(file);
  const units = new Map<string, ts.Node[]>();
  const visit = (node: ts.Node) => {
    const name = ts.isFunctionDeclaration(node) && node.name ? node.name.text
      : (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isMethodDeclaration(node)) && ts.isIdentifier(node.name)
        && (!('initializer' in node) || !node.initializer || isFunctionLike(node.initializer) || ts.isCallExpression(node.initializer))
        && (ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ('initializer' in node && !!node.initializer)) ? node.name.text : null;
    if (name) units.set(name, [...(units.get(name) ?? []), node]);
    ts.forEachChild(node, visit);
  };
  visit(parsed.source);
  // Review 5 MEDIUM-1 (round 7): a keeper registers in its own body. A function that calls one
  // anywhere isn't (the call may be on another path); one whose body always makes that call, as
  // a statement of its own body or as an arrow's whole body, is, when every function of that
  // name in the file does.
  const keepers = new Set<string>();
  for (const [name, nodes] of units) if (nodes.some(marked)) keepers.add(name);
  const alwaysCalls = (node: ts.Node): boolean => {
    const fn = ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) ? node.initializer : node;
    if (!fn || !isFunctionLike(fn) && !ts.isFunctionDeclaration(fn) && !ts.isMethodDeclaration(fn)) return false;
    const body = (fn as ts.FunctionLikeDeclaration).body;
    if (!body) return false;
    const direct = ts.isBlock(body)
      ? body.statements.flatMap((st) => ts.isExpressionStatement(st) ? [st.expression] : ts.isReturnStatement(st) && st.expression ? [st.expression] : [])
      : [body];
    return direct.some((expression) => {
      let e: ts.Expression = expression;
      while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e) || ts.isVoidExpression(e)) e = e.expression;
      if (!ts.isCallExpression(e)) return false;
      const callee = e.expression;
      const called = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      return !!called && keepers.has(called) || storeKeeper(file, e);
    });
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, nodes] of units) if (!keepers.has(name) && nodes.every(alwaysCalls)) { keepers.add(name); grew = true; }
  }
  keepersBuilding.delete(file);
  keepersCache.set(file, keepers);
  return keepers;
}

/** Whether a function registers in its own body, or calls a same-file function whose own body
 * does (one level). Kept for the ratchets' declarations; outcomeAt reads the branch or catch. */
export function keepsLine(unit: Unit): boolean {
  return registersInBody(unit) || callsKeeper(unit.file, unit.node, unit.name);
}

/** Whether a function registers a line with the mechanism in its own body (a marked call). */
export function registersInBody(unit: Unit): boolean {
  return marked(unit.node);
}

/**
 * Round 9 (review 7 NIT-2): what a socket's person-only refusal lacks in `file`, read from the
 * syntax tree. None when the file opens a WebSocket whose URL ends in `path` (written there, or
 * made by a call written with it: `backendWebSocketUrl('/ws/chat').then((url) => …)`), and in
 * that socket's message handler a branch on `<event>.code === PERSON_REQUIRED_CODE` (or a const
 * set to that comparison) makes a marked registration call (or calls a same-file keeper).
 */
export function socketRefusalGaps(file: string, path: string): string[] {
  const parsed = frontend().files.find((entry) => entry.file === file);
  if (!parsed) return [`${file} isn't there`];
  const sockets: { name: string; scope: ts.Node }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'WebSocket'
      && node.arguments?.[0] && socketUrlEndsIn(node.arguments[0], path)) {
      const holder = node.parent;
      const name = ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name) ? holder.name.text
        : ts.isBinaryExpression(holder) && holder.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(holder.left) ? holder.left.text : null;
      if (name) sockets.push({ name, scope: enclosingFunction(node) ?? parsed.source });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed.source);
  if (sockets.length === 0) return [`opens no WebSocket to ${path}`];
  const handlers: ts.Node[] = [];
  for (const { name, scope } of sockets) {
    const find = (node: ts.Node) => {
      // `socket.onmessage = (ev) => …`, `socket.addEventListener('message', (ev) => …)`
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)
        && node.left.name.text === 'onmessage' && ts.isIdentifier(node.left.expression) && node.left.expression.text === name
        && isFunctionLike(node.right)) handlers.push(node.right);
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addEventListener'
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === name
        && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'message'
        && node.arguments[1] && isFunctionLike(node.arguments[1])) handlers.push(node.arguments[1]);
      ts.forEachChild(node, find);
    };
    find(scope);
  }
  if (handlers.length === 0) return [`its socket to ${path} has no message handler`];
  const branches: ts.Statement[] = [];
  for (const handler of handlers) {
    const codeChecks = new Set<string>();
    const walkHandler = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && comparesRefusalCode(node.initializer)) codeChecks.add(node.name.text);
      if (ts.isIfStatement(node)) {
        let test: ts.Expression = node.expression;
        while (ts.isParenthesizedExpression(test)) test = test.expression;
        if (comparesRefusalCode(test) || ts.isIdentifier(test) && codeChecks.has(test.text)) branches.push(node.thenStatement);
      }
      ts.forEachChild(node, walkHandler);
    };
    walkHandler(handler);
  }
  if (branches.length === 0) return ['its message handler has no branch on the refusal\'s code'];
  const registers = (branch: ts.Node): boolean => {
    let found = false;
    const look = (node: ts.Node) => {
      if (found) return;
      if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && marked(node)) found = true;
      ts.forEachChild(node, look);
    };
    look(branch);
    return found || callsKeeper(file, branch, '');
  };
  return branches.some(registers) ? [] : ['its branch on the refusal\'s code registers no line'];
}

/** `x.code === PERSON_REQUIRED_CODE`, either way round, `===` or `==`. */
function comparesRefusalCode(node: ts.Node): boolean {
  if (!ts.isBinaryExpression(node) || ![ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken].includes(node.operatorToken.kind)) return false;
  const isCode = (side: ts.Expression) => ts.isPropertyAccessExpression(side) && side.name.text === 'code';
  const isConst = (side: ts.Expression) => ts.isIdentifier(side) && side.text === 'PERSON_REQUIRED_CODE';
  return isCode(node.left) && isConst(node.right) || isConst(node.left) && isCode(node.right);
}

/** A socket URL that ends in `path`: written as such, or the parameter of a `.then` on a call
 * written with it, or a const set to one of those. */
function socketUrlEndsIn(node: ts.Expression, path: string): boolean {
  let e: ts.Expression = node;
  while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (literalTexts(e).some((text) => text.endsWith(path))) return true;
  if (ts.isCallExpression(e)) return e.arguments.some((arg) => literalTexts(arg).some((text) => text.endsWith(path)));
  if (!ts.isIdentifier(e)) return false;
  for (let scope: ts.Node | undefined = e.parent; scope; scope = scope.parent) {
    if (isFunctionLike(scope)) {
      const fn = scope as ts.ArrowFunction;
      const param = fn.parameters.find((p) => ts.isIdentifier(p.name) && p.name.text === (e as ts.Identifier).text);
      if (param) {
        const call = fn.parent;
        return fn.parameters.indexOf(param) === 0 && ts.isCallExpression(call) && call.arguments[0] === fn
          && ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === 'then'
          && socketUrlEndsIn(call.expression.expression, path);
      }
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const decl of statement.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === e.text && decl.initializer) return socketUrlEndsIn(decl.initializer, path);
        }
      }
    }
  }
  return false;
}

// ---------- round 11: from a sending unit to the controls that reach it ----------

/** A JSX attribute whose handler reaches a person-only request, and how it is locked (null: it
 * isn't). */
export interface ControlSite { file: string; line: number; tag: string; attribute: string; locked: string | null;
  /** The attribute's value as written (whitespace folded), to name the site without its line. */
  handler: string;
  /** The functions between the control and the send, nearest the control first. */
  via: string[] }
export interface LockReach {
  sites: ControlSite[];
  /** Where the walk ends with no control: a function nothing calls (an export src doesn't use),
   * a component's render or effect, a hook's body: `file#name`, or `file:line` (`<Tag>` when it is
   * rendered), with the chain to the send. */
  open: { at: string; via: string[] }[];
  /** Where the walk stopped at a lock before any control (an early return, a guard, work held
   * for the promote). */
  held: { at: string; locked: string; via: string[] }[];
}

interface Step { file: string; name: string; wide: boolean; node: ts.Node; locked: string | null; via: string[];
  /** Only references read off this name (`props.onConfirm`: 'props'). */
  propsOf?: string; scope?: ts.Node;
  /** Only `.name` reads (a hook's returned member) in files that import `file`. */
  member?: boolean }

/** A name that holds a lock: a const set by a `use…Lock(…)` hook (usePersonLock, useNoteLock), or a
 * prop or parameter named `lock`, `…Lock` or `gate` (a lock handed down: KreaSignInRow's `lock`). */
function isLock(expression: ts.Expression, depth = 0): boolean {
  let e = expression;
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  if (ts.isPropertyAccessExpression(e)) return /(?:^l|L)ock$|^gate$/.test(e.name.text);
  if (!ts.isIdentifier(e)) return false;
  const name = e.text;
  for (let scope: ts.Node | undefined = e.parent; scope; scope = scope.parent) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
          let init = declaration.initializer;
          while (ts.isParenthesizedExpression(init)) init = init.expression;
          // `const dismissLock = ask ? sharedLock : ownLock`, `const lock = rowLock`
          if (depth < 4 && ts.isConditionalExpression(init)) return isLock(init.whenTrue, depth + 1) && isLock(init.whenFalse, depth + 1);
          if (depth < 4 && (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init))) return isLock(init, depth + 1);
          return ts.isCallExpression(init) && /^use\w*Lock$/.test(calleeName(init));
        }
      }
    }
    if (isFunctionLike(scope) || ts.isFunctionDeclaration(scope)) {
      for (const param of (scope as ts.FunctionLikeDeclaration).parameters) {
        const names = ts.isIdentifier(param.name) ? [param.name.text]
          : ts.isObjectBindingPattern(param.name) ? param.name.elements.flatMap((el) => ts.isIdentifier(el.name) ? [el.name.text] : []) : [];
        if (names.includes(name)) return /(?:^l|L)ock$|^gate$/.test(name);
      }
    }
  }
  return false;
}
/** The lock read as `<lock>.locked` in `node`, not under a `!` (or under one, `negated`). */
function lockedRead(node: ts.Node, negated: boolean): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node) => {
    if (found) return;
    // `<lock>.locked`, or a const set to it (`const tabHeld = connectLock.locked`).
    const value = ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) ? constValue(n, n.text) : null;
    // Also a lock's control props honoured by hand: `confirm?.['aria-disabled']` (PromptDialog).
    const read = ts.isPropertyAccessExpression(n) && n.name.text === 'locked' && isLock(n.expression) ? n.expression
      : value && ts.isPropertyAccessExpression(value) && value.name.text === 'locked' && isLock(value.expression) ? value.expression
        : ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === 'aria-disabled' ? n.expression : null;
    if (read) {
      let up: ts.Node = n;
      while (ts.isParenthesizedExpression(up.parent)) up = up.parent;
      const isNegated = ts.isPrefixUnaryExpression(up.parent) && up.parent.operator === ts.SyntaxKind.ExclamationToken;
      if (isNegated === negated) found = read.getText();
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}
const exits = (statement: ts.Statement): boolean => ts.isReturnStatement(statement) || ts.isThrowStatement(statement)
  || ts.isBlock(statement) && statement.statements.length > 0 && exits(statement.statements[statement.statements.length - 1]);

/** How the code from `at` up to `boundary` holds a lock: `<lock>.guard(…)` around it, an
 * `if (<lock>.locked) return` before it, or an `if (!<lock>.locked)` or `<lock>.locked ? … :`
 * around it. Null: nothing does. */
const PROMOTE_RUNNERS = new Set(['retryOnPromote', 'whenPerson', 'afterPersonRefusal', 'onPersonPromoted']);
function lockAround(at: ts.Node, boundary: ts.Node | undefined): string | null {
  // Up to the unit's own function, and one step past it: `const save = lock.guard((x) => …)`.
  for (let n: ts.Node = at; n.parent; n = n.parent) {
    const parent = n.parent;
    if (ts.isCallExpression(parent) && parent.arguments.includes(n as ts.Expression) && ts.isPropertyAccessExpression(parent.expression)
      && parent.expression.name.text === 'guard' && isLock(parent.expression.expression)) return `${parent.expression.expression.getText()}.guard`;
    // Work held for the promote runs only on a tab connected as the person.
    if (ts.isCallExpression(parent) && parent.arguments.includes(n as ts.Expression) && PROMOTE_RUNNERS.has(calleeName(parent))) return `${calleeName(parent)}()`;
    if (n === boundary) break;
    if (ts.isBlock(parent) || ts.isSourceFile(parent)) {
      const before = (parent.statements as ts.NodeArray<ts.Statement>).slice(0, parent.statements.indexOf(n as ts.Statement));
      for (const statement of before) {
        const lock = ts.isIfStatement(statement) && exits(statement.thenStatement) ? lockedRead(statement.expression, false) : null;
        if (lock) return `${lock}.locked return`;
      }
    }
    if (ts.isIfStatement(parent) && parent.thenStatement === n) { const lock = lockedRead(parent.expression, true); if (lock) return `!${lock}.locked`; }
    if (ts.isIfStatement(parent) && parent.elseStatement === n) { const lock = lockedRead(parent.expression, false); if (lock) return `${lock}.locked else`; }
    if (ts.isConditionalExpression(parent) && parent.whenFalse === n) { const lock = lockedRead(parent.condition, false); if (lock) return `${lock}.locked ?`; }
    if (ts.isConditionalExpression(parent) && parent.whenTrue === n) { const lock = lockedRead(parent.condition, true); if (lock) return `!${lock}.locked ?`; }
  }
  return null;
}
/** A name bound by a function's parameters (a prop) around `at`. */
function isLockParam(id: ts.Identifier): boolean {
  for (let scope: ts.Node | undefined = id.parent; scope; scope = scope.parent) {
    if (!isFunctionLike(scope) && !ts.isFunctionDeclaration(scope)) continue;
    for (const param of (scope as ts.FunctionLikeDeclaration).parameters) {
      if (ts.isIdentifier(param.name) && param.name.text === id.text) return true;
      if (ts.isObjectBindingPattern(param.name) && param.name.elements.some((el) => ts.isIdentifier(el.name) && el.name.text === id.text)) return true;
    }
  }
  return false;
}
/** A const's value, where `name` is declared in a block around `at` (null: none). */
function constValue(at: ts.Node, name: string): ts.Expression | null {
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const declaration = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
      if (declaration) return declaration.initializer ?? null;
    }
  }
  return null;
}
/** `<lock>.control(…)`, or a const set to one (`const lockProps = lock.control()`), or what a
 * component was handed for it: a prop named `lock` that is the control's props (`{...lock}`) or
 * its `control` (`{...lock(describedBy)}`). */
function controlCall(expression: ts.Expression): string | null {
  let e: ts.Expression | null = expression;
  const handed = (id: ts.Expression) => ts.isIdentifier(id) && /(?:^l|L)ock(?:Props)?$/.test(id.text) && constValue(id, id.text) === null && isLockParam(id);
  if (handed(e)) return `{...${e.getText()}}`;
  if (ts.isCallExpression(e) && handed(e.expression)) return `{...${e.expression.getText()}()}`;
  if (ts.isIdentifier(e)) e = constValue(e, e.text);
  if (e && ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'control'
    && isLock(e.expression.expression)) return `${e.expression.expression.getText()}.control()`;
  return null;
}
/** Round 11: a lock taken only while a condition holds (`{...(cond ? lock.control() : {})}`
 * with `onClick={cond ? lock.guard(f) : () => f()}`): the spread's branch is `<lock>.control()`,
 * and a handler on the same element is a conditional on the same condition whose branch on the
 * same side is `<lock>.guard(…)` of the same lock. What the other side sends is the code's own
 * claim (DeferredRunNotice: the approval is released only when nothing is left). */
function pairedControl(element: ts.JsxOpeningLikeElement, spread: ts.Expression): string | null {
  let e = spread;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isConditionalExpression(e)) return null;
  const condition = e.condition.getText();
  for (const [side, branch] of [['whenTrue', e.whenTrue], ['whenFalse', e.whenFalse]] as const) {
    const control = controlCall(branch);
    if (!control || !control.endsWith('.control()')) continue;
    const lock = control.slice(0, -'.control()'.length);
    for (const property of element.attributes.properties) {
      if (!ts.isJsxAttribute(property) || !property.initializer || !ts.isJsxExpression(property.initializer)) continue;
      let handler = property.initializer.expression;
      while (handler && ts.isParenthesizedExpression(handler)) handler = handler.expression;
      if (!handler || !ts.isConditionalExpression(handler) || handler.condition.getText() !== condition) continue;
      const guarded = handler[side];
      if (ts.isCallExpression(guarded) && ts.isPropertyAccessExpression(guarded.expression) && guarded.expression.name.text === 'guard'
        && guarded.expression.expression.getText() === lock && isLock(guarded.expression.expression)) return `${lock}.control() when ${condition}`;
    }
  }
  return null;
}
/** How a JSX element holds a lock itself: it spreads `<lock>.control(…)`, or its `disabled`
 * reads `<lock>.locked`. */
function elementLock(element: ts.JsxOpeningLikeElement): string | null {
  for (const property of element.attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) {
      const control = controlCall(property.expression) ?? pairedControl(element, property.expression);
      if (control) return control;
    } else if (property.name.getText() === 'data-person-lock') {
      return 'data-person-lock';
    } else if (ts.isIdentifier(property.name) && property.name.text === 'disabled' && property.initializer
      && ts.isJsxExpression(property.initializer) && property.initializer.expression) {
      const lock = lockedRead(property.initializer.expression, false);
      if (lock) return `disabled={${lock}.locked}`;
    }
  }
  return null;
}

/** The function a component's tag names (same file, or imported by name or as the default):
 * its declaration, or the function a const holds (through memo(), forwardRef()). */
function componentNamed(tag: ts.Identifier): { file: string; fn: ts.SignatureDeclaration } | null {
  const source = tag.getSourceFile();
  const own = (file: string, src: ts.SourceFile, name: string): { file: string; fn: ts.SignatureDeclaration } | null => {
    for (const statement of src.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return { file, fn: statement };
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name || !declaration.initializer) continue;
        let init: ts.Expression = declaration.initializer;
        while (ts.isCallExpression(init) && init.arguments[0]) init = init.arguments[0];
        return isFunctionLike(init) ? { file, fn: init as ts.ArrowFunction } : null;
      }
    }
    return null;
  };
  const file = fileOf(source);
  const local = own(file, source, tag.text);
  if (local) return local;
  const bound = importOf(source, tag.text);
  if (bound?.name) {
    const target = currentFiles?.get(bound.module);
    return target ? own(bound.module, target, bound.name) : null;
  }
  // A default import.
  if (!currentFiles) return null;
  const known = new Set(currentFiles.keys());
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.importClause?.name?.text !== tag.text) continue;
    const module = resolveModule(file, statement.moduleSpecifier.text, known);
    const name = module ? frontend().defaults.get(module) : undefined;
    const target = module ? currentFiles.get(module) : undefined;
    return module && name && target ? own(module, target, name) : null;
  }
  return null;
}

/** Whether `id` names something imported from `store` (or from a module that leads to it). */
function importedFrom(id: ts.Identifier, store: string, imports: Map<string, Map<string, Taken>>): boolean {
  const source = id.getSourceFile();
  // The store's own hook, in its own file.
  if (fileOf(source) === store) return source.statements.some((st) => ts.isVariableStatement(st)
    && st.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === id.text));
  const bound = importOf(source, id.text);
  if (!bound) return false;
  return bound.module === store || !!imports.get(bound.module)?.has(store) || reachesStoreThroughAlias(imports.get(bound.module), store, imports);
}
/** Whether a reference reads a store's action off that store: `useX.getState().action`,
 * `useX((s) => s.action)`, `const { action } = useX()` (or `useX.getState()`), `getState()['action']`,
 * or off a const that holds the state (`const state = useX.getState(); state.action()`). */
function storeRead(reference: ts.Identifier, store: string, imports: Map<string, Map<string, Taken>>): boolean {
  const parent = reference.parent;
  let host: ts.Expression | undefined;
  if (ts.isPropertyAccessExpression(parent) && parent.name === reference) host = parent.expression;
  else if (ts.isElementAccessExpression(parent) && parent.argumentExpression === reference) host = parent.expression;
  else if (ts.isBindingElement(parent) && (parent.propertyName ?? parent.name) === reference && ts.isVariableDeclaration(parent.parent.parent)) host = parent.parent.parent.initializer;
  else if (ts.isImportSpecifier(parent)) return false;
  else return false;
  const fromHost = (expression: ts.Expression | undefined, depth: number): boolean => {
    let e = expression;
    while (e && (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e))) e = e.expression;
    if (!e || depth > 3) return false;
    if (ts.isCallExpression(e)) {
      const callee = e.expression;
      // In the store's own file: zustand's `get().action()`.
      if (ts.isIdentifier(callee) && callee.text === 'get' && fileOf(reference.getSourceFile()) === store) return true;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'getState' && ts.isIdentifier(callee.expression)) return importedFrom(callee.expression, store, imports);
      return ts.isIdentifier(callee) && importedFrom(callee, store, imports);
    }
    if (!ts.isIdentifier(e)) return false;
    const name = e.text;
    for (let n: ts.Node | undefined = e.parent; n; n = n.parent) {
      if (isFunctionLike(n)) {
        const fn = n as ts.ArrowFunction;
        if (fn.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) {
          const call = fn.parent;
          return ts.isCallExpression(call) && call.arguments[0] === fn && ts.isIdentifier(call.expression) && importedFrom(call.expression, store, imports);
        }
      }
      if (ts.isBlock(n) || ts.isSourceFile(n)) {
        for (const statement of n.statements) {
          if (!ts.isVariableStatement(statement)) continue;
          const declaration = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
          if (declaration) return fromHost(declaration.initializer, depth + 1);
        }
      }
    }
    return false;
  };
  return fromHost(host, 0);
}

/**
 * Round 11 (review 9 lock-sweep LOW-3): from the points where units send a person-only route
 * (callersOf's `points`) to every JSX attribute whose handler reaches them, through each
 * function's callers (by name, imports, store actions and selectors, as callersOf follows them),
 * a prop handed to a component (into that component's use of it), and a member a hook returns
 * (`krea.signIn`). Each site says how it is locked: `<lock>.guard(…)` around the call, an early
 * `if (<lock>.locked) return` on the way, the element's `{...<lock>.control()}`, or nothing.
 */
export function lockReach(points: { file: string; node: ts.Node }[]): LockReach {
  const { references, imports } = frontend();
  const sites: ControlSite[] = [];
  const open = new Map<string, string[]>();
  const held: { at: string; locked: string; via: string[] }[] = [];
  const queue: Step[] = [];
  const seen = new Set<string>();

  const visitPoint = (file: string, at: ts.Node, locked: string | null, via: string[]) => {
    const unit = unitOf(file, at);
    const boundary = unit ? unitBody(unit) : undefined;
    const here = locked ?? lockAround(at, boundary);
    // A handler in a JSX attribute inside this unit.
    let attribute: ts.JsxAttribute | null = null;
    for (let n: ts.Node | undefined = at; n && n !== boundary; n = n.parent) if (ts.isJsxAttribute(n)) { attribute = n; break; }
    if (attribute) {
      const element = attribute.parent.parent;
      const tag = element.tagName;
      const line = element.getSourceFile().getLineAndCharacterOfPosition(element.getStart()).line + 1;
      const name = attribute.name.getText();
      const lock = here ?? elementLock(element);
      const custom = ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text);
      if (!lock && custom) {
        // A prop handed to a component: its use of the prop is the control.
        const component = componentNamed(tag as ts.Identifier);
        const param = component?.fn.parameters[0]?.name;
        if (component && param && ts.isObjectBindingPattern(param)) {
          const element = param.elements.find((el) => (el.propertyName ?? el.name).getText() === name && ts.isIdentifier(el.name));
          if (element) { queue.push({ file: component.file, name: (element.name as ts.Identifier).text, wide: false, node: element, locked: null, via: [`${file}:${line} <${tag.getText()} ${name}>`, ...via] }); return; }
        } else if (component && param && ts.isIdentifier(param)) {
          queue.push({ file: component.file, name, wide: false, node: param, locked: null, propsOf: param.text, scope: component.fn, via: [`${file}:${line} <${tag.getText()} ${name}>`, ...via] });
          return;
        }
      }
      const handler = (attribute.initializer?.getText() ?? '').replace(/\s+/g, ' ').slice(0, 120);
      sites.push({ file, line, tag: tag.getText(), attribute: name, locked: lock, via, handler });
      return;
    }
    // Held behind a lock on the way: whatever control reaches it from here is locked.
    if (here) { held.push({ at: `${file}:${at.getSourceFile().getLineAndCharacterOfPosition(at.getStart()).line + 1}`, locked: here, via }); return; }
    // Rendered (`<Panel />`): it runs on render, not from a control.
    if ((ts.isJsxOpeningElement(at.parent) || ts.isJsxSelfClosingElement(at.parent)) && at.parent.tagName === at) {
      open.set(`${file}:${at.getSourceFile().getLineAndCharacterOfPosition(at.getStart()).line + 1} <${at.getText()}>`, via);
      return;
    }
    // A member of an object a function returns (a hook's `{ signIn, check }`).
    const property = at.parent && (ts.isShorthandPropertyAssignment(at.parent) || ts.isPropertyAssignment(at.parent) && at.parent.initializer === at) ? at.parent : null;
    if (property && ts.isObjectLiteralExpression(property.parent)) {
      const object = climbPath(property.parent);
      const fn = enclosingFunction(object);
      const returned = !!fn && (ts.isReturnStatement(object.parent) && enclosingFunction(object.parent) === fn || object.parent === fn && (fn as ts.ArrowFunction).body === object);
      if (returned) { queue.push({ file, name: property.name.getText(), wide: true, node: property, locked: here, member: true, via }); return; }
    }
    if (!unit) {
      // A store's action put back under its own name (`setState({ x: wrap(methods.x) })`): the
      // same action, whose callers are already followed by that name.
      let n: ts.Node = at;
      while (n.parent && !ts.isPropertyAssignment(n.parent) && !ts.isStatement(n.parent)) n = n.parent;
      if (n.parent && ts.isPropertyAssignment(n.parent) && n.parent.name.getText() === at.getText()) return;
      open.set(`${file}:${at.getSourceFile().getLineAndCharacterOfPosition(at.getStart()).line + 1}`, via);
      return;
    }
    // Sent while a component renders or a hook runs (an effect, a load on open): no control.
    if (/^(?:[A-Z]|use[A-Z])/.test(unit.name)) { open.set(`${file}#${unit.name}`, via); return; }
    // A function a hook (or any non-store function) returns in an object (`disconnect: () => …`):
    // its callers read it off the result.
    if ((ts.isPropertyAssignment(unit.node) || ts.isMethodDeclaration(unit.node)) && !isStoreAction(unit) && ts.isObjectLiteralExpression(unit.node.parent)) {
      const object = climbPath(unit.node.parent);
      const fn = enclosingFunction(object);
      if (fn && (ts.isReturnStatement(object.parent) && enclosingFunction(object.parent) === fn || object.parent === fn && (fn as ts.ArrowFunction).body === object)) {
        queue.push({ file, name: unit.name, wide: true, node: unit.node, locked: here, member: true, via: [`${file}#${unit.name}`, ...via] });
        return;
      }
    }
    queue.push({ file, name: unit.name, wide: unit.wide, node: unit.node, locked: here, via: [`${file}#${unit.name}`, ...via] });
  };

  for (const point of points) visitPoint(point.file, point.node, null, []);
  while (queue.length > 0) {
    const step = queue.shift()!;
    const id = `${step.file}#${step.name}`;
    const key = `${id}${step.member ? '.member' : ''}@${step.node.pos}|${step.locked ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const unitLike: Unit = { file: step.file, name: step.name, wide: step.wide, node: step.node };
    const scope = step.scope ?? (step.wide ? null : declaringScope(step.node));
    let followed = 0;
    for (const reference of references.get(step.name) ?? []) {
      const parent = reference.node.parent;
      if (ts.isTypeQueryNode(parent) || reference.node === step.node || ts.isJsxAttribute(parent) && parent.name === reference.node) continue;
      if (step.member) {
        // `x.member` or `const { member } = …` in a file that imports the hook's file (or in it).
        if (reference.file !== step.file && !imports.get(reference.file)?.has(step.file)) continue;
        if (ts.isPropertyAccessExpression(parent) && parent.name === reference.node) { followed += 1; visitPoint(reference.file, reference.node, step.locked, step.via); continue; }
        if (ts.isBindingElement(parent) && (parent.propertyName ?? parent.name) === reference.node && ts.isIdentifier(parent.name)) {
          followed += 1;
          queue.push({ file: reference.file, name: parent.name.text, wide: false, node: parent, locked: step.locked, via: step.via });
        }
        continue;
      }
      if (!step.wide && reference.file !== step.file) continue;
      if (scope && !within(reference.node, scope)) continue;
      // `words.reject` isn't the local `reject`.
      if (!step.wide && !step.propsOf && ts.isPropertyAccessExpression(parent) && parent.name === reference.node) continue;
      if (step.propsOf) {
        if (!(ts.isPropertyAccessExpression(parent) && parent.name === reference.node && ts.isIdentifier(parent.expression) && parent.expression.text === step.propsOf)) continue;
        followed += 1;
        visitPoint(reference.file, parent, step.locked, step.via);
        continue;
      }
      if (ts.isExportSpecifier(parent) && parent.propertyName === reference.node) {
        queue.push({ file: reference.file, name: parent.name.text, wide: true, node: parent, locked: step.locked, via: step.via });
        followed += 1;
        continue;
      }
      // A store's action is read off that store (callersOf takes any `.action` its importers
      // read, which is safe for a caller list but names unrelated controls here).
      if (isStoreAction(unitLike) ? !storeRead(reference.node, step.file, imports)
        : reference.file !== step.file && !reachesThroughImport(imports.get(reference.file)?.get(step.file), reference.node)) continue;
      if (ts.isBindingElement(parent) && (parent.propertyName ?? parent.name) === reference.node && ts.isIdentifier(parent.name)) {
        queue.push({ file: reference.file, name: parent.name.text, wide: false, node: parent, locked: step.locked, via: step.via });
        followed += 1;
        continue;
      }
      if (ts.isImportSpecifier(parent) && parent.propertyName === reference.node) {
        queue.push({ file: reference.file, name: parent.name.text, wide: false, node: parent, locked: step.locked, via: step.via });
        followed += 1;
        continue;
      }
      if (ts.isImportSpecifier(parent) || ts.isImportClause(parent)) continue;
      const caller = unitOf(reference.file, reference.node);
      if (caller && caller.file === step.file && caller.name === step.name && caller.node === step.node) continue;
      followed += 1;
      visitPoint(reference.file, reference.node, step.locked, step.via);
    }
    if (followed === 0) open.set(id, step.via.slice(1));
  }
  // One site once: unlocked if any way to it is.
  const merged = new Map<string, ControlSite>();
  for (const site of sites) {
    const key = `${site.file}:${site.line} <${site.tag}> ${site.attribute}`;
    const before = merged.get(key);
    if (!before || before.locked && !site.locked) merged.set(key, site);
  }
  return { sites: [...merged.values()], open: [...open].map(([at, via]) => ({ at, via })).sort((a, b) => a.at.localeCompare(b.at)), held };
}
