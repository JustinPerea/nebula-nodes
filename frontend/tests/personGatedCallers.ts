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

interface GateScan { routes: GatedRoute[]; unreadable: UnreadableRouteForm[] }
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

/** A top-level `const NAME = '…'` of the node's file, by name: what a placeholder holds. */
function constantText(node: ts.Node): string | null {
  if (!ts.isIdentifier(node)) return null;
  const source = node.getSourceFile();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === node.text && declaration.initializer
        && (ts.isStringLiteral(declaration.initializer) || ts.isNoSubstitutionTemplateLiteral(declaration.initializer))) {
        return declaration.initializer.text;
      }
    }
  }
  return null;
}

/** A literal's texts: one, or, for a template whose placeholder picks between two strings
 * (`/api/${kind === 'moodboard' ? 'moodboards' : 'characters'}/…`), one per choice (round 7). */
function literalTexts(node: ts.Node): string[] {
  if (ts.isTemplateExpression(node)) {
    let out = [node.head.text];
    for (const span of node.templateSpans) {
      let e: ts.Expression = span.expression;
      while (ts.isParenthesizedExpression(e)) e = e.expression;
      const choices = ts.isConditionalExpression(e) && [e.whenTrue, e.whenFalse].every((b) => ts.isStringLiteral(b) || ts.isNoSubstitutionTemplateLiteral(b))
        ? [e.whenTrue, e.whenFalse].map((b) => (b as ts.StringLiteral).text)
        : [constantText(span.expression) ?? '\uE000'];
      out = out.flatMap((head) => choices.map((choice) => head + choice + span.literal.text));
    }
    return out;
  }
  const text = literalText(node);
  return text === null ? [] : [text];
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  // Round 7 (gates-security LOW-1): a placeholder that names a top-level string const is its text
  // (`${API}presets` with `const API = '/api/'`).
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `${constantText(span.expression) ?? '\uE000'}${span.literal.text}`).join('');
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  // Round 6 (review 4 LOW-1): '/api/' + 'presets', `${BASE}/api/…` + id.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left) ?? constantText(node.left);
    const right = literalText(node.right) ?? constantText(node.right);
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
  /** Every /api/ literal in a function, read once. */
  literals: { text: string; method: string; unit: Unit; node: ts.Node }[];
  /** /api/ text the trace can't follow (round 6, fail closed). */
  untraced: { file: string; line: number; text: string }[];
  /** A module's default export: the name of the function it is. */
  defaults: Map<string, string>;
}
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
  const savedKeepers = new Map(keepersCache);
  cache = build(Object.entries(sources).map(([file, text]) => ({ file,
    source: ts.createSourceFile(join(SRC, file), text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS) })));
  keepersCache.clear();
  try { return fn(); } finally {
    cache = saved;
    keepersCache.clear();
    for (const [key, value] of savedKeepers) keepersCache.set(key, value);
  }
}

function frontend(): Frontend {
  if (cache) return cache;
  cache = build(walk(SRC, /\.(ts|tsx)$/).map((path) => ({
    file: relative(SRC, path),
    source: ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
      path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
  })));
  return cache;
}

function build(files: Parsed[]): Frontend {
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
  const literals: { text: string; method: string; unit: Unit; node: ts.Node }[] = [];
  const untraced: { file: string; line: number; text: string }[] = [];
  for (const { file, source } of files) {
    const visit = (node: ts.Node) => {
      const texts = literalTexts(node);
      if (texts.some((text) => text.includes('/api/'))) for (const text of texts) {
        const path = apiPath(text);
        const unit = unitOf(file, node);
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        // Round 7 (gates-security LOW-1): a path whose first segment is a placeholder
        // (`/api/${kind}/…`) could be any route, and a string that is only the /api/ prefix is
        // joined to one somewhere the trace can't read: both are listed, never skipped.
        const unplaced = path !== null && (/^\/api\/\uE000/.test(path) || /^\/api\/?$/.test(path));
        // `new OfflineRefusal('POST', '/api/…')` names the request a refusal stands for; it
        // sends nothing (round 7: no longer a caller to follow).
        if (describesOnly(node)) return;
        if (path === null || !unit || unplaced) untraced.push({ file, line, text: text.replace(/\uE000/g, '${…}') });
        else literals.push({ text: path, method: methodOf(node), unit, node });
      }
      if (texts.some((text) => text.includes('/api/'))) return; // the parts of a `+` are read with it
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files, references, imports, literals, untraced, defaults };
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
 * a template, and either branch of a conditional (`want ? '/a' : '/b'`). */
function climbPath(at: ts.Node): ts.Node {
  let n: ts.Node = at;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isBinaryExpression(n.parent) || ts.isTemplateSpan(n.parent)
    || ts.isConditionalExpression(n.parent) && n.parent.condition !== n)) n = n.parent;
  return n;
}

/** /api/ text the trace can't follow to a function: each must be declared (round 6, fail closed). */
export function untracedApiText(): { file: string; line: number; text: string }[] {
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
  const n = climbPath(at);
  const call = n.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(n as ts.Expression)) return false;
  const callee = ts.isIdentifier(call.expression) ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';
  return ANSWERS_WITH_RESPONSE.has(callee);
}

/** The call around a path literal (or the node itself when it is a call). */
function callAround(at: ts.Node): ts.CallExpression | null {
  if (ts.isCallExpression(at)) return at;
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
  const call = callAround(at);
  if (call && (responds || answersWithResponse(at))) {
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
  const { files, references, imports, literals, defaults } = frontend();
  const known = new Set(files.map((entry) => entry.file));
  const queue: Unit[] = [];
  const found = new Map<string, Unit>();
  const keep = (id: string, unit: Unit, outcome: Outcome) => {
    const before = found.get(id)?.outcome;
    found.set(id, { ...unit, outcome: before === 'drops' ? 'drops' : outcome });
  };
  const reach = (unit: Unit, at: ts.Node, responds = false) => {
    const id = `${unit.file}#${unit.name}`;
    // A function that hands back a Response it got: its callers read `!res.ok` (round 7).
    const call = callAround(at);
    const handsBack = !!call && (responds || answersWithResponse(at)) && returnsCall(unit, call) && !throwsOnFailure(call);
    // A lib helper the ratchet declares as where its route's answer stops (stopAt).
    if (stopAt.has(id)) keep(id, unit, 'drops');
    else if (unit.file.startsWith('lib/')) {
      // A lib helper whose branch or catch registers the line (settingsWrites' `fail`) keeps it;
      // any other hands the refusal, or the Response, to its callers.
      if (!handsBack && outcomeAt(unit, at, responds) === 'keeps') keep(id, unit, 'keeps'); else queue.push({ ...unit, responds: handsBack });
    } else {
      const outcome = outcomeAt(unit, at, responds);
      if (outcome === 'passes') { passed.add(id); queue.push({ ...unit, responds: handsBack }); } else keep(id, unit, outcome);
    }
  };
  const passed = new Set<string>();
  for (const literal of literals) {
    if ((literal.method === '*' || literal.method === route.method) && sendsTo(literal.text, route.path)) {
      if (literal.unit.constant) queue.push(literal.unit); else reach(literal.unit, literal.node);
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
      reach({ ...caller, via: id }, reference.node, unit.responds);
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

/** A store reached through a module that imports it (`export const useAlias = useA` in b.ts):
 * one hop (gates-security LOW-1, round 7). */
function reachesStoreThroughAlias(from: Map<string, Taken> | undefined, store: string, imports: Map<string, Map<string, Taken>>): boolean {
  if (!from) return false;
  for (const module of from.keys()) if (imports.get(module)?.has(store)) return true;
  return false;
}

function reachesThroughImport(taken: Taken | undefined, node: ts.Identifier, storeAction = false): boolean {
  if (!taken) return false;
  if (taken.dynamic) return true;
  const parent = node.parent;
  if (ts.isElementAccessExpression(parent) && storeAction) return true; // `getState()['action']()`
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    if (storeAction) return true; // `useGraphStore.getState().action()`, `(s) => s.action`
    return ts.isIdentifier(parent.expression) && (taken.namespaces.has(parent.expression.text)
      || taken.names.has(parent.expression.text) || taken.defaults.has(parent.expression.text));
  }
  return taken.names.has(node.text);
}

const MARKED = /\/\/ clears-on-promote: [\w.-]+/;
/** A node's own text and the comment that ends its last line: what a marker on it may be.
 * Round 7: never its leading trivia, which holds the line before it (a marker there belongs to
 * the statement it ends, and counted for the next function or branch too). */
function ownText(node: ts.Node): string {
  const source = node.getSourceFile().getFullText();
  const trailing = ts.getTrailingCommentRanges(source, node.getEnd()) ?? [];
  return node.getText() + trailing.map((range) => source.slice(range.pos, range.end)).join(' ');
}
const marked = (node: ts.Node): boolean => MARKED.test(ownText(node));

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
