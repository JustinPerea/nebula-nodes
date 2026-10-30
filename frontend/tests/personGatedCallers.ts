/**
 * PR #204 round 5 (review 3 MEDIUM-1): the structural half of the "clears on promote" ratchet.
 * It finds, without a hand-written map:
 *
 * 1. Every backend route behind the person gate: a route in backend/main.py or backend/routes/
 *    whose handler reaches a gate form (`require_person(`, `_person_only_refusal(`,
 *    `stop_refusal(`, or a `Depends(person_only)` route) directly or through main.py's own
 *    helpers (`_check_style_write` → `_refuse_agent_billing_change` → `_person_only_refusal`).
 * 2. Every frontend caller of such a route: a string or template literal that is the route's
 *    path, sent with the route's method (a call's `method:`; none is GET; one it can't read
 *    counts as any), followed through lib/ helpers (who calls the helper, and who calls that)
 *    to the first function outside lib/: the store action or component that keeps the line.
 *
 * Read with the TypeScript parser (no type checking): names, not types, so a helper is found by
 * its name wherever it is called or passed.
 */
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

interface PyFunction { body: string[]; decorators: string[] }

function pyFunctions(file: string): Map<string, PyFunction> {
  const out = new Map<string, PyFunction>();
  let current: PyFunction | null = null;
  let pending: string[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('@')) { pending.push(line.trim()); current = null; continue; }
    const def = /^(?:async )?def ([A-Za-z_]\w*)\(/.exec(line);
    if (def) {
      current = { body: [], decorators: pending };
      out.set(def[1], current);
      pending = [];
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith('#') && !line.startsWith(')')) { current = null; pending = []; }
    if (current) current.body.push(line);
  }
  return out;
}

const GATE_FORM = /\b(?:require_person|_person_only_refusal|stop_refusal)\(/;
const code = (line: string) => !/^\s*#/.test(line) && !/^\s*(?:from|import) /.test(line);

/** The functions in one file that reach a gate form, directly or through that file's own functions. */
function gatedIn(functions: Map<string, PyFunction>, seed: (fn: PyFunction) => boolean): Set<string> {
  const gated = new Set([...functions].filter(([, fn]) => seed(fn) || fn.body.some((line) => code(line) && GATE_FORM.test(line)))
    .map(([name]) => name));
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, fn] of functions) {
      if (gated.has(name)) continue;
      if (fn.body.some((line) => code(line) && [...gated].some((other) => new RegExp(`\\b${other}\\(`).test(line)))) {
        gated.add(name);
        grew = true;
      }
    }
  }
  return gated;
}

export interface GatedRoute { method: string; path: string; handler: string }

/** Every backend route behind the person gate, as `METHOD /path`. */
export function gatedRoutes(): GatedRoute[] {
  const routes: GatedRoute[] = [];
  const main = pyFunctions(join(BACKEND, 'main.py'));
  const mainGated = gatedIn(main, () => false);
  for (const [name, fn] of main) {
    for (const decorator of fn.decorators) {
      const route = /^@app\.(get|post|put|patch|delete)\("([^"]+)"/.exec(decorator);
      if (route && mainGated.has(name)) routes.push({ method: route[1].toUpperCase(), path: route[2], handler: `main.${name}` });
    }
  }
  for (const file of walk(join(BACKEND, 'routes'), /\.py$/)) {
    const prefix = /APIRouter\(prefix="([^"]*)"/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
    const functions = pyFunctions(file);
    const gated = gatedIn(functions, (fn) => fn.decorators.some((d) => /Depends\(person_only\)/.test(d)));
    const module = file.split('/').pop()!.replace(/\.py$/, '');
    for (const [name, fn] of functions) {
      for (const decorator of fn.decorators) {
        const route = /^@router\.(get|post|put|patch|delete)\("([^"]*)"/.exec(decorator);
        if (route && gated.has(name)) routes.push({ method: route[1].toUpperCase(), path: prefix + route[2], handler: `${module}.${name}` });
      }
    }
  }
  return routes.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

// ---------- frontend ----------

interface Unit { file: string; name: string; wide: boolean; node: ts.Node; via?: string }

const isFunctionLike = (node: ts.Node | undefined): boolean => !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

/** The nearest named function around `node`: a declaration, a const bound to a function (or a
 * call that wraps one: a hook, useCallback), an object's method or function property. */
function unitOf(file: string, node: ts.Node): Unit | null {
  for (let n: ts.Node | undefined = node; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return { file, name: n.name.text, wide: ts.isSourceFile(n.parent), node: n };
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return { file, name: n.name.text, wide: true, node: n };
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && isFunctionLike(n.initializer)) {
      return { file, name: n.name.text, wide: true, node: n };
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (isFunctionLike(n.initializer) || ts.isCallExpression(n.initializer))) {
      const statement = n.parent?.parent;
      return { file, name: n.name.text, wide: !!statement && ts.isSourceFile(statement.parent), node: n };
    }
  }
  return null;
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `\uE000${span.literal.text}`).join('');
  return null;
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

/** What one file takes from one module: names it imports, namespaces (`* as api`), or a
 * dynamic `import()` (any name). */
interface Taken { names: Set<string>; namespaces: Set<string>; dynamic: boolean }

let cache: {
  files: Parsed[];
  references: Map<string, { file: string; node: ts.Identifier }[]>;
  imports: Map<string, Map<string, Taken>>;
  /** Every /api/ literal in a function, read once. */
  literals: { text: string; method: string; unit: Unit }[];
} | null = null;

/** A relative module specifier, as a file under src. */
function resolveModule(from: string, specifier: string, known: Set<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = join(from.split('/').slice(0, -1).join('/'), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

function frontend() {
  if (cache) return cache;
  const files = walk(SRC, /\.(ts|tsx)$/).map((path) => ({
    file: relative(SRC, path),
    source: ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
      path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
  }));
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
    if (!into.has(module)) into.set(module, { names: new Set(), namespaces: new Set(), dynamic: false });
    return into.get(module)!;
  };
  // `export { name } from './other'`: an import of `name` from this file is one from ./other.
  const reexports = new Map<string, string>();
  for (const { file, source } of files) {
    for (const statement of source.statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const module = resolveModule(file, statement.moduleSpecifier.text, known);
      if (!module || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) reexports.set(`${file}#${element.name.text}`, module);
    }
  }
  const imports = new Map<string, Map<string, Taken>>();
  for (const { file, source } of files) {
    const into = new Map<string, Taken>();
    imports.set(file, into);
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const module = resolveModule(file, node.moduleSpecifier.text, known);
        const clause = node.importClause;
        if (module && clause?.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) taken(into, module).namespaces.add(clause.namedBindings.name.text);
          else for (const element of clause.namedBindings.elements) {
            const name = (element.propertyName ?? element.name).text;
            taken(into, reexports.get(`${module}#${name}`) ?? module).names.add(name);
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
  const literals: { text: string; method: string; unit: Unit }[] = [];
  for (const { file, source } of files) {
    const visit = (node: ts.Node) => {
      const text = literalText(node);
      if (text !== null && text.startsWith('/api/')) {
        const unit = unitOf(file, node);
        if (unit) literals.push({ text, method: methodOf(node), unit });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  cache = { files, references, imports, literals };
  return cache;
}

/** The functions outside lib/ that send `route`, by `file#name`, each with its unit. */
export function callersOf(route: { method: string; path: string }, extraStarts: string[] = [], stopAt: Set<string> = new Set()): Map<string, Unit> {
  const { files, references, imports, literals } = frontend();
  const queue: Unit[] = [];
  const found = new Map<string, Unit>();
  const reach = (unit: Unit) => {
    // A lib helper that registers its own line (settingsWrites) is where the line is kept.
    // So is a lib helper the ratchet declares as where its route's answer stops (stopAt).
    if (unit.file.startsWith('lib/') && !keepsLine(unit) && !stopAt.has(`${unit.file}#${unit.name}`)) queue.push(unit);
    else found.set(`${unit.file}#${unit.name}`, unit);
  };
  for (const literal of literals) {
    if ((literal.method === '*' || literal.method === route.method) && sendsTo(literal.text, route.path)) reach(literal.unit);
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
    reach(unit);
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const unit = queue.shift()!;
    const id = `${unit.file}#${unit.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const reference of references.get(unit.name) ?? []) {
      if (!unit.wide && reference.file !== unit.file) continue;
      const parent = reference.node.parent;
      // Another file reaches an exported helper only through an import of its module: by name
      // (`import { helper }`), through a namespace (`api.helper`), or a dynamic import.
      if (reference.file !== unit.file && !reachesThroughImport(imports.get(reference.file)?.get(unit.file), reference.node)) continue;
      // `import { helper as alias }`: follow the alias in that file.
      if (ts.isImportSpecifier(parent) && parent.propertyName === reference.node) {
        queue.push({ file: reference.file, name: parent.name.text, wide: false, node: parent });
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
      reach({ ...caller, via: id });
    }
  }
  return found;
}

function reachesThroughImport(taken: Taken | undefined, node: ts.Identifier): boolean {
  if (!taken) return false;
  if (taken.dynamic) return true;
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    return ts.isIdentifier(parent.expression) && taken.namespaces.has(parent.expression.text);
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
 * (by name) a function in its file that does. A heuristic: it can't tell which branch calls. */
export function keepsLine(unit: Unit): boolean {
  return registersInBody(unit) || [...keepersIn(unit.file)].some((keeper) => keeper !== unit.name && new RegExp(`\\b${keeper}\\(`).test(unit.node.getText()));
}

/** Whether a function registers a line with the mechanism in its own body (a marked call). */
export function registersInBody(unit: Unit): boolean {
  return MARKED.test(unit.node.getFullText());
}
