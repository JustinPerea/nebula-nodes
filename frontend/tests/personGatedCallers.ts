/**
 * PR #204 round 5 (review 3 MEDIUM-1): the structural half of the "clears on promote" ratchet.
 * It finds, without a hand-written map:
 *
 * 1. Every backend route behind the person gate: a route in backend/main.py or backend/routes/
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
  const script = join(__dirname, 'personGateRoutes.py');
  const out = files
    ? execFileSync('python3', ['-I', script, '--stdin'], { input: JSON.stringify({ files }), encoding: 'utf8' })
    : execFileSync('python3', ['-I', script, BACKEND], { encoding: 'utf8' });
  const routes = JSON.parse(out) as GatedRoute[];
  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

// ---------- frontend ----------

export interface Unit {
  file: string; name: string; wide: boolean; node: ts.Node; via?: string; constant?: boolean;
  /** Round 6 (review 4 MEDIUM-1): what the catch on this call does with a refusal, at the worst
   * of the unit's calls on the route: 'keeps' (registers), 'drops' (must be declared). */
  outcome?: Outcome;
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

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `\uE000${span.literal.text}`).join('');
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  // Round 6 (review 4 LOW-1): '/api/' + 'presets', `${BASE}/api/…` + id.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = literalText(node.left);
    const right = literalText(node.right);
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
      const text = literalText(node);
      if (text !== null && text.includes('/api/')) {
        const path = apiPath(text);
        const unit = unitOf(file, node);
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        if (path === null || !unit) untraced.push({ file, line, text: text.replace(/\uE000/g, '${…}') });
        else literals.push({ text: path, method: methodOf(node), unit, node });
        return; // the parts of a `+` are read with it
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { files, references, imports, literals, untraced, defaults };
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
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}
const GLOBALS = new Set(['console', 'window', 'document', 'Promise', 'JSON', 'Object', 'Math', 'Array']);

function handlerOutcome(unit: Unit, handler: ts.Node): Outcome {
  if (MARKED.test(handler.getFullText()) || callsKeeper(unit.file, handler, unit.name)) return 'keeps';
  return throwsIn(handler) ? 'passes' : 'drops';
}

/** Calls that answer a refusal with a Response instead of throwing it: a catch around them sees
 * only a lost connection, so the function's own handling of `!res.ok` is what's read. */
const ANSWERS_WITH_RESPONSE = new Set(['fetch', 'apiFetch', 'graphMutationFetch']);
function answersWithResponse(at: ts.Node): boolean {
  let n: ts.Node = at;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isBinaryExpression(n.parent) || ts.isTemplateSpan(n.parent))) n = n.parent;
  const call = n.parent;
  if (!call || !ts.isCallExpression(call) || !call.arguments.includes(n as ts.Expression)) return false;
  const callee = ts.isIdentifier(call.expression) ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : '';
  return ANSWERS_WITH_RESPONSE.has(callee);
}

export function outcomeAt(unit: Unit, at: ts.Node): Outcome {
  if (unit.constant || isSelector(unit)) return 'passes';
  // A Response's refusal reaches a catch only when the try around it throws it (`if (!res.ok)
  // throw await requestError(…)`); otherwise the function's own `!res.ok` handling is what's read.
  if (answersWithResponse(at)) {
    let tryBlock: ts.Node | null = null;
    for (let n: ts.Node = at; n.parent && n !== unit.node; n = n.parent) {
      if (ts.isTryStatement(n.parent) && n.parent.tryBlock === n) { tryBlock = n; break; }
    }
    if (!tryBlock || !throwsIn(tryBlock)) return keepsLine(unit) ? 'keeps' : 'drops';
  }
  // A catch that throws it on hands it to the next catch out, in this unit or its callers.
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
  if (thrown) return 'passes';
  if (keepsLine(unit)) return 'keeps';
  // No catch around it: a store action that awaits or returns the call hands its refusal to
  // whoever calls the action (`getState().action()`, a selector), and is followed there.
  return isStoreAction(unit) && awaitedIn(unit, at) ? 'passes' : 'drops';
}

/** Whether the call at `at` is awaited or returned by the unit itself (not by a callback in it). */
function awaitedIn(unit: Unit, at: ts.Node): boolean {
  for (let n: ts.Node = at; n.parent && n !== unit.node; n = n.parent) {
    if (ts.isAwaitExpression(n) || ts.isReturnStatement(n)) return true;
    if (isFunctionLike(n) && n.parent !== unit.node) return !!(n as ts.ArrowFunction).body && false;
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
  const reach = (unit: Unit, at: ts.Node) => {
    const id = `${unit.file}#${unit.name}`;
    // A lib helper that registers its own line (settingsWrites) is where the line is kept.
    // So is a lib helper the ratchet declares as where its route's answer stops (stopAt).
    if (stopAt.has(id)) keep(id, unit, 'drops');
    else if (unit.file.startsWith('lib/')) { if (keepsLine(unit)) keep(id, unit, 'keeps'); else queue.push(unit); }
    else {
      const outcome = outcomeAt(unit, at);
      if (outcome === 'passes') { passed.add(id); queue.push(unit); } else keep(id, unit, outcome);
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
    for (const name of named) for (const reference of references.get(name) ?? []) {
      if (!unit.wide && reference.file !== unit.file) continue;
      const parent = reference.node.parent;
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
      if (reference.file !== unit.file && !reachesThroughImport(imports.get(reference.file)?.get(unit.file), reference.node, isStoreAction(unit))) continue;
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
      reach({ ...caller, via: id }, reference.node);
    }
    // A module's default export, imported under another name.
    if (defaults.get(unit.file) === unit.name) {
      for (const [file, from] of imports) for (const local of from.get(unit.file)?.defaults ?? []) {
        queue.push({ file, name: local, wide: false, node: unit.node });
        followed += 1;
      }
    }
    // Fail closed (round 6): a lib helper the trace reached but can't follow to any caller (a
    // class built with `new`, a helper passed as a value) is returned, so it must be declared.
    if (followed === 0 && unit.file.startsWith('lib/') && !passed.has(id)) keep(id, unit, 'drops');
  }
  for (const id of passed) passedCache.add(id);
  return found;
}

/** Every function the trace followed past (a catch that throws on, a selector): seen, not callers. */
const passedCache = new Set<string>();
export function passedThrough(): Set<string> { return passedCache; }

function reachesThroughImport(taken: Taken | undefined, node: ts.Identifier, storeAction = false): boolean {
  if (!taken) return false;
  if (taken.dynamic) return true;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    if (storeAction) return true; // `useGraphStore.getState().action()`, `(s) => s.action`
    return ts.isIdentifier(parent.expression) && (taken.namespaces.has(parent.expression.text)
      || taken.names.has(parent.expression.text) || taken.defaults.has(parent.expression.text));
  }
  return taken.names.has(node.text);
}

const MARKED = /\/\/ clears-on-promote: [\w.-]+/;

/** The functions in `file` whose own body registers a line, and every same-file function that
 * calls one of those (by name), to any depth. */
const keepersCache = new Map<string, Set<string>>();
function keepersIn(file: string): Set<string> {
  const cached = keepersCache.get(file);
  if (cached) return cached;
  const parsed = frontend().files.find((entry) => entry.file === file)!;
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
  const calls = (node: ts.Node): Set<string> => {
    const names = new Set<string>();
    const walkCalls = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        if (ts.isIdentifier(callee)) names.add(callee.text);
        else if (ts.isPropertyAccessExpression(callee)) names.add(callee.name.text); // get().showError(…), state.fail(…)
      }
      ts.forEachChild(n, walkCalls);
    };
    walkCalls(node);
    return names;
  };
  const keepers = new Set<string>();
  for (const [name, nodes] of units) if (nodes.some((node) => MARKED.test(node.getFullText()))) keepers.add(name);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, nodes] of units) {
      if (keepers.has(name)) continue;
      if (nodes.some((node) => [...calls(node)].some((callee) => keepers.has(callee)))) { keepers.add(name); grew = true; }
    }
  }
  keepersCache.set(file, keepers);
  return keepers;
}

/** Whether a function keeps its line with the mechanism: it registers in its own body, or calls
 * (by name) a function in its file that does. A heuristic: it can't tell which branch calls
 * (outcomeAt reads the catch around one call). */
export function keepsLine(unit: Unit): boolean {
  return registersInBody(unit) || callsKeeper(unit.file, unit.node, unit.name);
}

/** Whether a function registers a line with the mechanism in its own body (a marked call). */
export function registersInBody(unit: Unit): boolean {
  return MARKED.test(unit.node.getFullText());
}
