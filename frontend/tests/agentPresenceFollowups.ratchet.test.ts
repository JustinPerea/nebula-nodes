import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { gatedGraphActions } from '../src/store/graphStore';

/**
 * Follow-ups to PR #195, two static ratchets.
 *
 * 1. Review 23 L-4: round 23's ratchet (round23Surfaces.test.tsx gatedUses)
 *    saw `(s) => s.X`, `getState().X`, `store.X` and `lifecycle.X` only, and
 *    missed `const graph = useGraphStore.getState(); graph.X()`, destructures,
 *    useShallow, a bare `s => s.X` and `const { X } = useGraphStore()`
 *    (review 23 ratchet.facts B-F); EditorView's keys and the chat's Apply
 *    and /clear slipped through. Now any name of a gated action (EDIT_GATES,
 *    gatedGraphActions) anywhere in a file that imports useGraphStore counts,
 *    in every form, comments and string literals aside. Each such file reads
 *    the canvas lock (useCanvasLock / refuseCanvasEdit), or names the locked
 *    surfaces it hands its controls to, or is on ALLOWLIST with the reason it
 *    has no control of its own that edits.
 *
 * 2. GM r24 item 2: one disabled rule app-wide. A disabled button is neutral
 *    grey whatever the reason, and its tooltip gives the reason; never orange
 *    but disabled. Every button-like rule that fills with the accent (orange)
 *    is covered by the one shared disabled rule (styles/disabled-buttons.css,
 *    imported by App.tsx).
 */

const SRC = join(__dirname, '../src');
const walk = (dir: string, match: RegExp): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path, match) : match.test(name) && !/\.test\./.test(name) ? [path] : [];
});

/** Fix round 1 of PR #200 (review L-5): the source read by the TypeScript
 * parser, not by regexes. Comments and string literals are no code (a
 * `/*` inside `accept="image/*"` hid 315 lines of Inspector.tsx from the
 * old regex, and `title="Don't"` hid the rest of its line); identifiers in
 * every form count, and so does bracket access by a string
 * (`s['executeGraph']`). */
const parsed = new Map<string, ts.SourceFile>();
function parse(source: string, file = 'x.tsx'): ts.SourceFile {
  const key = `${file}\u0000${source}`;
  let root = parsed.get(key);
  if (!root) {
    root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
    parsed.set(key, root);
  }
  return root;
}
const named = new WeakMap<ts.Node, string[]>();
function identifiers(node: ts.Node): string[] {
  const cached = named.get(node);
  if (cached) return cached;
  const names = identifiersOf(node);
  named.set(node, names);
  return names;
}
function identifiersOf(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current) || ts.isPrivateIdentifier(current)) names.push(current.text);
    else if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) names.push(current.argumentExpression.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

const GATED = new Set(gatedGraphActions());

/** Every gated action a file names, in any form. */
function gatedNames(source: string, file?: string): string[] {
  return [...new Set(identifiers(parse(source, file)).filter((name) => GATED.has(name)))];
}

/** Names a file may reach the graph store by: useGraphStore, and every name
 * a module re-exports it under (`export { useGraphStore as useG }`,
 * `export const useG = useGraphStore`), so a re-exported hook counts. */
function storeNames(files: Array<{ file: string; source: string }>): Set<string> {
  const names = new Set(['useGraphStore']);
  for (let grown = true; grown;) {
    grown = false;
    for (const { file, source } of files) {
      const visit = (node: ts.Node) => {
        if (ts.isExportSpecifier(node) && names.has((node.propertyName ?? node.name).text) && !names.has(node.name.text)) {
          names.add(node.name.text); grown = true;
        }
        if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
          for (const declaration of node.declarationList.declarations) {
            if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isIdentifier(declaration.initializer)
              && names.has(declaration.initializer.text) && !names.has(declaration.name.text)) {
              names.add(declaration.name.text); grown = true;
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(parse(source, file));
    }
  }
  return names;
}

const READS_LOCK = /\buseCanvasLock\(|\brefuseCanvasEdit\(/;

/** Files that hand every control that acts to locked components (rendered
 * in round23Surfaces' SURFACES). */
const DELEGATES: Record<string, string> = {
  'components/cinema-studio/CinemaStudioView.tsx': 'its controls are CinemaShotsRail and CinemaShotPanel, which read the lock',
  'components/create-studio/CreateView.tsx': 'its controls are CreateComposer and ResultCard, which read the lock',
};

/** Files that name a gated action but have no control of their own that edits. */
const ALLOWLIST: Record<string, string> = {
  'lib/chatCanvasClear.ts': "the chat's /clear; ChatPanel refuses it with refuseCanvasEdit before calling",
  'lib/cinemaMotion.ts': "Send to motion's local node; called from CinemaShotPanel, whose Send to motion takes the lock",
  'lib/cinemaUploads.ts': "a Cinema reference upload writing its scene; started from CinemaSharedControls and CinemaShotPanel, whose attach and Retry buttons take the lock",
  'store/canvasProposalsStore.ts': "a proposal's Accept and its run; ProposalBar's buttons take the lock, the store gate refuses them, and Accept is fenced (proposal_canvas_replaced)",
  'store/uiStore.ts': "opening the trim editor makes or finds its edit node: VideoEditAction's button takes the lock (EditNode's Open Editor opens its own node read-only, openEditNode, which writes nothing); and selection changes; no control",
};

/** Fix round 2 of PR #200 (review 2, L-5): G's holes closed.
 * - Every `on[A-Z]*` attribute is a handler (onDragEnd, onKeyPress,
 *   onClickCapture, onContextMenu, onPaste, a component's own `onRun` or
 *   `onPick`), and so is a spread that isn't the lock (`{...handlers}`).
 * - Only the lock puts a control in it: `lock.act()`, `lock.mark`,
 *   `lock.title()`, `lock.locked`, `{...lock}`, or a value that comes from
 *   one (a local read from useCanvasLock, a prop named `lock`, `canvasLock`
 *   or `locked`). An attribute that merely says "lock" (`data-lock`,
 *   `aria-label="… locked …"`, `title="lock screen"`, `confirm={{}}`,
 *   `readOnly={false}`, `disabled={locked}` with an unrelated `locked`) does
 *   not, on the control or on an ancestor.
 * - A handler is followed through the file's own functions, destructures
 *   and assignments (`ref.current = …`), and one level into a function
 *   imported from a relative module (a helper, a hook's return value).
 * - A local named like a gated action (`const undo = () => setText(prev)`)
 *   is the local, not the store's action. */
const CONTROL_TAGS = new Set(['button', 'input', 'select', 'textarea']);
const isHandlerName = (name: string) => /^on[A-Z]/.test(name);
const LOCK_FACTORIES = new Set(['useCanvasLock', 'canvasLockNow', 'canvasLockOf']);
const LOCK_MEMBERS = new Set(['act', 'mark', 'title', 'locked']);
/** A prop handed down from a parent that read the lock. */
const LOCK_PROPS = /^(lock|canvasLock|locked)$/;

type Resolve = (specifier: string, fromFile: string) => { file: string; source: string } | null;

interface Scope {
  root: ts.SourceFile;
  file: string;
  locals: Map<string, ts.Node[]>;
  imports: Map<string, { specifier: string; imported: string }>;
  /** `export default …`: the function or expression (fix round 3, review 3 LOW-6). */
  defaultExport: ts.Node | null;
  /** `export { a as b } from './x'` and `export * from './x'`: b → (./x, a); '*' → every star module. */
  reexports: Map<string, { specifier: string; imported: string }[]>;
}

const scopes = new Map<string, Scope>();
function scopeOf(source: string, file: string): Scope {
  const key = `${file}\u0000${source}`;
  const cached = scopes.get(key);
  if (cached) return cached;
  const root = parse(source, file);
  const locals = new Map<string, ts.Node[]>();
  const imports = new Map<string, { specifier: string; imported: string }>();
  const add = (name: string, node: ts.Node) => locals.set(name, [...(locals.get(name) ?? []), node]);
  let defaultExport: ts.Node | null = null;
  const reexports = new Map<string, { specifier: string; imported: string }[]>();
  const reexport = (name: string, specifier: string, imported: string) =>
    reexports.set(name, [...(reexports.get(name) ?? []), { specifier, imported }]);
  // `const { a, b } = init`: `a` is its own element and the initializer
  // (never `b`, which another handler may not reach).
  const bindings = (name: ts.BindingName, initializer: ts.Node | undefined, element?: ts.BindingElement) => {
    if (ts.isIdentifier(name)) { if (element) add(name.text, element); if (initializer) add(name.text, initializer); return; }
    for (const inner of name.elements) if (!ts.isOmittedExpression(inner)) bindings(inner.name, initializer, inner);
  };
  const rootName = (node: ts.Expression): string | null => {
    let at: ts.Expression = node;
    while (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at)) at = at.expression;
    return ts.isIdentifier(at) ? at.text : null;
  };
  const collect = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) add(node.name.text, node);
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
      && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) defaultExport = node;
    if (ts.isExportAssignment(node)) defaultExport = node.expression;
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (!node.exportClause) reexport('*', specifier, '*');
      else if (ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) reexport(element.name.text, specifier, (element.propertyName ?? element.name).text);
      }
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name)) { if (node.initializer) add(node.name.text, node.initializer); }
      else bindings(node.name, node.initializer);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const name = rootName(node.left);
      if (name) add(name, node.right);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause) {
      const specifier = node.moduleSpecifier.text;
      if (node.importClause.name) imports.set(node.importClause.name.text, { specifier, imported: 'default' });
      const bound = node.importClause.namedBindings;
      if (bound && ts.isNamedImports(bound)) {
        for (const element of bound.elements) imports.set(element.name.text, { specifier, imported: (element.propertyName ?? element.name).text });
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(root);
  const scope = { root, file, locals, imports, defaultExport, reexports };
  scopes.set(key, scope);
  return scope;
}

/** An identifier that names something (a reference), not a member name, a
 * binding's own name or an object key. */
function isReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
  if ((ts.isBindingElement(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)
    || ts.isFunctionDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent)) && parent.name === id) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === id) return false;
  if (ts.isJsxAttribute(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent)) return false;
  return true;
}

/** The exported function `name` of a module, as a node to follow, with the
 * module it is in: a function, or an object of methods (`runner.go()`); a
 * store (`create(…)`) is reached by its members already. Fix round 3 of PR
 * #200 (review 3 LOW-6): a default export, and a re-export (`export { a }
 * from './a'`, `export * from`), which is no level of its own. */
function exportedTarget(scope: Scope, name: string, resolve: Resolve, hops = 0): { node: ts.Node; scope: Scope } | null {
  if (hops > 4) return null;
  const callable = (node: ts.Node) => ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)
    || ts.isObjectLiteralExpression(node) || ts.isClassDeclaration(node);
  if (name === 'default' && scope.defaultExport) {
    const value = scope.defaultExport;
    if (ts.isIdentifier(value)) return exportedTarget(scope, value.text, resolve, hops + 1);
    return callable(value) ? { node: value, scope } : null;
  }
  for (const node of scope.locals.get(name) ?? []) if (callable(node)) return { node, scope };
  for (const { specifier, imported } of [...(scope.reexports.get(name) ?? []), ...(scope.reexports.get('*') ?? [])]) {
    const module = resolve(specifier, scope.file);
    if (!module) continue;
    const found = exportedTarget(scopeOf(module.source, module.file), imported === '*' ? name : imported, resolve, hops + 1);
    if (found) return found;
  }
  // `import { a } from './x'; export { a }`: the import it names.
  const imported = scope.imports.get(name);
  if (imported && imported.specifier.startsWith('.')) {
    const module = resolve(imported.specifier, scope.file);
    if (module) return exportedTarget(scopeOf(module.source, module.file), imported.imported, resolve, hops + 1);
  }
  return null;
}

/** The names the graph store is reached by (storeNames over every source
 * file), set by the L-4 block before G runs. */
let STORE_NAMES = new Set(['useGraphStore']);
const reachesGraphStore = (source: string, file: string) => identifiers(parse(source, file)).some((name) => STORE_NAMES.has(name));

/** How many imports deep a handler is followed: a helper that calls a
 * helper (review 3 LOW-6 "two levels"). */
const IMPORT_DEPTH = 2;

/** The names a node reaches: identifiers it names (members included),
 * through the file's own definitions and one level into imported functions. */
/** `ownNames`: whether names the file itself spells count. A file that never
 * names the graph store has no gated action of its own (a moodboard's own
 * undo is no canvas undo); only what it reaches through an import into a
 * module that does name the store counts (review 3 LOW-6). */
function reachOf(node: ts.Node, scope: Scope, resolve: Resolve | undefined, seen: Set<string>, depth = 0, ownNames = true): Set<string> {
  const names = new Set<string>();
  const visit = (current: ts.Node) => {
    // Nested JSX is an element of its own, checked on its own (a render prop
    // that returns <Row onClick={…}/> is that row's, not the outer's).
    if (current !== node && (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current))) return;
    if (ts.isIdentifier(current)) {
      const name = current.text;
      const local = scope.locals.get(name);
      if (local && isReference(current)) {
        const key = `${scope.file}#${name}`;
        if (!seen.has(key)) { seen.add(key); for (const inner of local) for (const reached of reachOf(inner, scope, resolve, seen, depth, ownNames)) names.add(reached); }
        return;
      }
      const imported = scope.imports.get(name);
      const module = imported && resolve && imported.specifier.startsWith('.') ? resolve(imported.specifier, scope.file) : null;
      if (ownNames || (module && reachesGraphStore(module.source, module.file))) names.add(name);
      if (imported && module && depth < IMPORT_DEPTH && isReference(current)) {
        const target = exportedTarget(scopeOf(module.source, module.file), imported.imported, resolve!);
        const key = target ? `${target.scope.file}#${imported.imported}` : '';
        // Followed whatever the module; inside it, its own names count only if
        // it names the graph store (a helper that calls a store helper counts
        // through that one).
        if (target && !seen.has(key)) {
          seen.add(key);
          const own = reachesGraphStore(target.scope.root.text, target.scope.file);
          for (const reached of reachOf(target.node, target.scope, resolve, seen, depth + 1, own)) names.add(reached);
        }
      }
      return;
    }
    if (ownNames && ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) names.add(current.argumentExpression.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

/** A value that is the canvas lock: a call of its hook, a local read from
 * one, or a prop named for it. */
function isLockValue(expression: ts.Node, scope: Scope, seen: Set<string> = new Set()): boolean {
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) return isLockValue(expression.expression, scope, seen);
  if (ts.isCallExpression(expression)) return ts.isIdentifier(expression.expression) && LOCK_FACTORIES.has(expression.expression.text);
  if (ts.isPropertyAccessExpression(expression)) return LOCK_PROPS.test(expression.name.text) && !LOCK_MEMBERS.has(expression.name.text)
    || (LOCK_PROPS.test(expression.name.text) && /^props$/.test(expression.expression.getText(scope.root)));
  if (!ts.isIdentifier(expression)) return false;
  const definitions = scope.locals.get(expression.text);
  if (!definitions) return LOCK_PROPS.test(expression.text) && !scope.imports.has(expression.text);
  const key = expression.text;
  if (seen.has(key)) return false;
  seen.add(key);
  return definitions.some((definition) => {
    // `const { locked } = lock` / `const { lock } = props`: the element
    // itself names nothing; its initializer decides.
    if (ts.isBindingElement(definition)) return false;
    if (LOCK_PROPS.test(key) && /^props\b/.test(definition.getText(scope.root))) return true;
    return isLockValue(definition, scope, seen) || isLockExpression(definition, scope, seen);
  });
}

/** An expression that carries the lock: `lock.act()`, `lock.mark`,
 * `lock.title()`, `lock.locked`, `{...lock}`, or a local made of one. */
function isLockExpression(expression: ts.Node, scope: Scope, seen: Set<string> = new Set()): boolean {
  let found = false;
  const visit = (current: ts.Node) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(current) && LOCK_MEMBERS.has(current.name.text) && isLockValue(current.expression, scope, seen)) { found = true; return; }
    if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && LOCK_FACTORIES.has(current.expression.text)) { found = true; return; }
    if (ts.isIdentifier(current) && isReference(current) && isLockValue(current, scope, seen)) { found = true; return; }
    if (ts.isFunctionLike(current)) return;
    ts.forEachChild(current, visit);
  };
  visit(expression);
  return found;
}

/** Names a parent may hand a control's disabled state down by (review 3
 * LOW-6, "too strict": `disabled={readOnly}` from a parent prop). Only as a
 * prop (no local of that name), and only for `disabled`. */
const DISABLED_PROPS = /^(locked|readOnly|disabled|isLocked)$/;

/** Which locked states an expression is truthy in (fix round 3 of PR #200,
 * review 3 LOW-6): FOLLOWING, OFFLINE, or both (LOCKED). `lock.locked`, `x ||
 * lock.locked`, a local or memo made of one and a prop handed down are
 * LOCKED; `lock.offline` covers offline only, so a Run that is `disabled`
 * offline and `aria-disabled` while following is locked by the two together.
 * `!lock.locked`, `lock.locked && false` and `busy && lock.locked` cover
 * nothing. */
const FOLLOWING = 1;
const OFFLINE = 2;
const LOCKED = FOLLOWING | OFFLINE;
const LOCK_STATES: Record<string, number> = { locked: LOCKED, following: FOLLOWING, offline: OFFLINE };
function lockCoverage(expression: ts.Node, scope: Scope, seen: Set<string> = new Set()): number {
  const again = (node: ts.Node) => lockCoverage(node, scope, seen);
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression) || ts.isAsExpression(expression)) return again(expression.expression);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return LOCKED;
  if (ts.isPrefixUnaryExpression(expression)) {
    const inner = expression.operand;
    return expression.operator === ts.SyntaxKind.ExclamationToken && ts.isPrefixUnaryExpression(inner)
      && inner.operator === ts.SyntaxKind.ExclamationToken ? again(inner.operand) : 0;
  }
  if (ts.isBinaryExpression(expression)) {
    const op = expression.operatorToken.kind;
    if (op === ts.SyntaxKind.BarBarToken) return again(expression.left) | again(expression.right);
    if (op === ts.SyntaxKind.QuestionQuestionToken) return again(expression.left);
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return again(expression.left) & again(expression.right);
    return 0;
  }
  if (ts.isConditionalExpression(expression)) {
    return (again(expression.whenTrue) & again(expression.whenFalse))
      | (expression.whenTrue.kind === ts.SyntaxKind.TrueKeyword ? again(expression.condition) : 0);
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const callee = expression.expression.text;
    const first = expression.arguments[0];
    if (callee === 'Boolean' && first) return again(first);
    if ((callee === 'useMemo' || callee === 'useCallback') && first && (ts.isArrowFunction(first) || ts.isFunctionExpression(first))) {
      return ts.isBlock(first.body) ? 0 : again(first.body);
    }
    return 0;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const name = expression.name.text;
    if (LOCK_STATES[name] && isLockValue(expression.expression, scope)) return LOCK_STATES[name];
    return DISABLED_PROPS.test(name) && /^props$/.test(expression.expression.getText(scope.root)) ? LOCKED : 0;
  }
  if (!ts.isIdentifier(expression)) return 0;
  const key = expression.text;
  const definitions = scope.locals.get(key);
  if (!definitions) return DISABLED_PROPS.test(key) && !scope.imports.has(key) ? LOCKED : 0;
  if (seen.has(key)) return 0;
  seen.add(key);
  return definitions.reduce((mask, definition) => {
    if (ts.isBindingElement(definition)) {
      // `const { locked } = lock`: the lock's own `locked` (or `offline`, `following`).
      const declared = definition.parent?.parent;
      const member = (definition.propertyName ?? definition.name).getText(scope.root);
      return mask | (LOCK_STATES[member] && declared && ts.isVariableDeclaration(declared) && declared.initializer
        && isLockValue(declared.initializer, scope) ? LOCK_STATES[member] : 0);
    }
    // The initializer of `const { locked } = lock` is the lock itself, no boolean.
    if (definition.parent && ts.isVariableDeclaration(definition.parent) && !ts.isIdentifier(definition.parent.name)) return mask;
    return mask | again(definition);
  }, 0);
}

/** The `lock.act(…)` spread (or a local made of it): the lock's own
 * attributes, no handler. */
function isActSpread(expression: ts.Node, scope: Scope, seen: Set<string> = new Set()): boolean {
  if (ts.isParenthesizedExpression(expression)) return isActSpread(expression.expression, scope, seen);
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
    && expression.expression.name.text === 'act' && isLockValue(expression.expression.expression, scope)) return true;
  if (!ts.isIdentifier(expression) || seen.has(expression.text)) return false;
  seen.add(expression.text);
  const definitions = scope.locals.get(expression.text) ?? [];
  return definitions.length > 0 && definitions.every((definition) => !ts.isBindingElement(definition) && isActSpread(definition, scope, seen));
}

/** Which locked states a spread covers: `{...lock.act(…)}` (or a local made
 * of it), an object whose `disabled`/`aria-disabled`/`readOnly` is truthy
 * when locked (`const shared = { disabled: readOnly, onChange }`), and on a
 * component the lock itself (`{...lock}`). `{...lock.mark}` only marks
 * (data-*): none. */
function spreadCoverage(expression: ts.Node, scope: Scope, component: boolean, seen: Set<string> = new Set()): number {
  if (ts.isParenthesizedExpression(expression)) return spreadCoverage(expression.expression, scope, component, seen);
  if (isActSpread(expression, scope)) return LOCKED;
  if (component && isLockValue(expression, scope)) return LOCKED;
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.reduce((mask, property) => {
      if (ts.isSpreadAssignment(property)) return mask | spreadCoverage(property.expression, scope, component, seen);
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return mask;
      const name = property.name.getText(scope.root).replace(/^['"]|['"]$/g, '');
      if (!/^(disabled|aria-disabled|readOnly)$/.test(name)) return mask;
      return mask | lockCoverage(ts.isPropertyAssignment(property) ? property.initializer : property.name, scope);
    }, 0);
  }
  if (!ts.isIdentifier(expression)) return 0;
  const key = expression.text;
  if (seen.has(key)) return 0;
  seen.add(key);
  return (scope.locals.get(key) ?? []).reduce((mask, definition) =>
    mask | (ts.isBindingElement(definition) ? 0 : spreadCoverage(definition, scope, component, seen)), 0);
}

/** Which locked states an attribute puts the control in: the lock's spread,
 * `disabled` or `aria-disabled` (and a text field's `readOnly`) truthy when
 * locked, or, on a component, the lock handed down (`lock={lock}`,
 * `locked={lock.locked}`, `readOnly`, `disabled`, a `disable…` prop). An
 * attribute that only mentions the lock (`className`, `title`, `aria-label`,
 * `data-*`, `key`, `disabled={!lock.locked}`) puts it in none (review 3
 * LOW-6). */
function lockAttribute(attribute: ts.JsxAttributeLike, scope: Scope, tag = ''): number {
  const component = /^[A-Z]/.test(tag);
  if (ts.isJsxSpreadAttribute(attribute)) return spreadCoverage(attribute.expression, scope, component);
  const name = attribute.name.getText(scope.root);
  if (isHandlerName(name)) return 0;
  const value = attribute.initializer;
  if (!value || !ts.isJsxExpression(value) || !value.expression) return 0;
  if (name === 'disabled' || name === 'aria-disabled') return lockCoverage(value.expression, scope);
  if (name === 'readOnly' && (component || tag === 'input' || tag === 'textarea')) return lockCoverage(value.expression, scope);
  if (component && /^(lock|canvasLock)$/.test(name)) return isLockValue(value.expression, scope) ? LOCKED : 0;
  if (component && (name === 'locked' || /^disable[A-Z]/.test(name))) return lockCoverage(value.expression, scope);
  return 0;
}

/** An attribute that hands a component (or a control) a callback without
 * `on`: `action={() => run()}`, `items={[{ select: () => run() }]}`, or a
 * function by name (review 3 LOW-6). */
function handsCallback(attribute: ts.JsxAttribute, scope: Scope): boolean {
  const name = attribute.name.getText(scope.root);
  if (isHandlerName(name) || /^(ref|key|className|style)$/.test(name)) return false;
  const value = attribute.initializer;
  if (!value || !ts.isJsxExpression(value) || !value.expression) return false;
  let found = false;
  const visit = (current: ts.Node) => {
    if (found || ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current)) return;
    if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) { found = true; return; }
    if (ts.isIdentifier(current) && isReference(current)) {
      const local = scope.locals.get(current.text);
      if (local?.some((node) => ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) { found = true; return; }
      if (GATED.has(current.text) || (scope.imports.get(current.text)?.specifier.startsWith('.') && /^[a-z]/.test(current.text))) { found = true; return; }
    }
    ts.forEachChild(current, visit);
  };
  visit(value.expression);
  return found;
}

/** Review 23 G, review 1 of PR #200 L-5 G, review 2 L-5: in a file that
 * reads the lock, a control whose handler reaches a gated action (directly,
 * through the file's own functions, or one level into an imported one) must
 * carry the lock itself or sit in an element that does (a locked fieldset).
 * A non-control element (a drag handle) may refuse in its handler instead
 * (refuseCanvasEdit). */
function unlockedControls(source: string, file: string, resolve?: Resolve): string[] {
  const scope = scopeOf(source, file);
  const { root } = scope;
  const ownNames = reachesGraphStore(source, file);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties;
      const tag = node.tagName.getText(root);
      const handlers = attributes.filter((attribute) => (ts.isJsxAttribute(attribute)
        && (isHandlerName(attribute.name.getText(root)) || handsCallback(attribute, scope)))
        || (ts.isJsxSpreadAttribute(attribute) && !isActSpread(attribute.expression, scope)));
      const reached = new Set<string>();
      for (const handler of handlers) for (const name of reachOf(handler, scope, resolve, new Set(), 0, ownNames)) reached.add(name);
      const hits = [...reached].filter((name) => GATED.has(name));
      if (hits.length > 0) {
        // Its own attributes and a disabled <fieldset> around it, together
        // (only a fieldset disables what it holds; review 3 LOW-6: a <div
        // title={lock.title()}> around a button disables nothing).
        let covered = attributes.reduce((mask, attribute) => mask | lockAttribute(attribute, scope, tag), 0);
        for (let up: ts.Node | undefined = node.parent; up && covered !== LOCKED; up = up.parent) {
          if (ts.isJsxElement(up) && up.openingElement !== node && up.openingElement.tagName.getText(root) === 'fieldset') {
            for (const attribute of up.openingElement.attributes.properties) {
              if (ts.isJsxAttribute(attribute) && attribute.name.getText(root) === 'disabled') covered |= lockAttribute(attribute, scope, 'fieldset');
            }
          }
        }
        const own = covered === LOCKED;
        const refusesInHandler = !CONTROL_TAGS.has(tag) && /^[a-z]/.test(tag) && (reached.has('refuseCanvasEdit') || reached.has('refuseEditWhileFollowing'));
        if (!own && !refusesInHandler) {
          const { line } = root.getLineAndCharacterOfPosition(node.getStart(root));
          // A component: the file it comes from, so a locked component is
          // known by its file, never its name (review 3 LOW-6).
          const head = tag.split('.')[0];
          const from = !/^[A-Z]/.test(tag) ? null : scope.locals.has(head) ? file
            : scope.imports.get(head) && resolve ? resolve(scope.imports.get(head)!.specifier, file)?.file ?? null : null;
          found.push(`${file}:${line + 1} <${tag}> ${hits.sort().join(', ')}${from ? ` [${from}]` : ''}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** A relative import of a source file, for G's one level into imported functions. */
const resolveSource: Resolve = (specifier, fromFile) => {
  const base = join(SRC, fromFile, '..', specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    try {
      if (statSync(candidate).isFile()) return { file: relative(SRC, candidate), source: readFileSync(candidate, 'utf8') };
    } catch { /* not this one */ }
  }
  return null;
};

/** Controls the check above finds that are covered another way (the
 * reason): `file <tag>` for one control, `file: action` for every control of
 * the file that reaches that action only that way. */
const CONTROL_ALLOWLIST: Record<string, string> = {
  'components/CommandPalette.tsx <input>': "the palette's search field: Enter runs the chosen command, and each command that edits is locked in buildCommands (round23Surfaces' CommandPalette)",
  'components/panels/ChatPanel.tsx: clearBackendNodes': "the chat's /clear (lib/chatCanvasClear, one level in): the chat itself stays usable while following or offline, and /clear is refused whole with refuseCanvasEdit before it clears (agentPresenceFollowups.surfaces)",
  'components/panels/AssetsPanel.tsx: undo': "`deleting.undo()` is the asset library's own undo of a deleted style (useAssetDelete), not the canvas's",
  // Fix round 3 of PR #200 (review 3 LOW-6): the forms G reads now (a
  // spread's handlers, `disabled` that must be truthy when locked) find these.
  'components/CommandPalette.tsx <button>': "a palette row: a command that edits (`cmd.acts`) spreads lock.act() and takes its `disabled` (`act ? act.disabled : …`, which G can't follow); round23Surfaces' CommandPalette renders them locked",
  'components/Canvas.tsx <ReactFlow>': "React Flow's change, connect and paste handlers: the store's edit gate (EDIT_GATES) refuses each while following or offline, and the canvas is read-only (data-read-only, nodesDraggable/nodesConnectable off); round20/round23 tests",
  'components/cinema-studio/CinemaShotPanel.tsx: addLocalCinemaMotionNode': "Send to motion: disabled while locked (`… || readOnly` under the not-ready branch; ready, it only views the node it made); agentPresenceFollowups.r1 renders it locked offline",
  'components/create-studio/CreateView.tsx <ResultsGallery>': "its Delete is ResultCard's button, which spreads lock.act() (ResultCard.tsx)",
};

/** Components that take the lock themselves for the gated handler they are
 * given (a menu's rows, a modal's Save): the call site needs no lock. Each
 * one's file reads the lock, and a render test shows it locked
 * (agentPresenceFollowups.r2 L-5). */
const LOCKED_COMPONENTS: Record<string, { file: string; via?: string[]; reason: string }> = {
  AssetItem: { file: 'components/panels/AssetsPanel.tsx', reason: 'Add to canvas and the drag take the lock (round 23)' },
  ProviderSwitcher: { file: 'components/nodes/ProviderSwitcher.tsx', reason: 'every provider row, fix and switch row takes the lock (fix round 2 of PR #200)' },
  // DeferredPanels' MaskPainterModal renders the real one from its lazy chunk.
  MaskPainterModal: { file: 'components/panels/MaskPainterModal.tsx', via: ['components/DeferredPanels.tsx'],
    reason: 'Save Mask, the tools and the strokes take the lock (fix rounds 2 and 3 of PR #200)' },
  // Fix round 3 (review 3 LOW-6): G now checks CinemaStudioView and CreateView
  // (files that never read the lock); these are the delegates DELEGATES names.
  CinemaSharedControls: { file: 'components/cinema-studio/CinemaSharedControls.tsx', reason: 'every scene control takes the lock (round 23, fix round 1 of PR #200)' },
  CinemaShotsRail: { file: 'components/cinema-studio/CinemaShotsRail.tsx', reason: '+ Add shot, the arrows, × and the drag take the lock (fix round 2 of PR #200)' },
  CinemaShotPanel: { file: 'components/cinema-studio/CinemaShotPanel.tsx', reason: 'Generate, the stepper, the variations and the prompt take the lock' },
  CreateComposer: { file: 'components/create-studio/CreateComposer.tsx', reason: 'Generate and the fields take the lock (round 23)' },
  ForgetRecoveryConfirm: { file: 'components/panels/ForgetRecoveryConfirm.tsx', reason: 'Forget takes the lock (fix round 2 of PR #200)' },
};

const allowed = (line: string) => {
  const match = /^(.*?):\d+ <([\w.]+)> (.*?)(?: \[(.*)\])?$/.exec(line);
  if (!match) return false;
  const [, file, tag, hits, from] = match;
  if (CONTROL_ALLOWLIST[`${file} <${tag}>`]) return true;
  const locked = LOCKED_COMPONENTS[tag];
  if (locked && from && [locked.file, ...(locked.via ?? [])].includes(from)
    && READS_LOCK.test(readFileSync(join(SRC, locked.file), 'utf8'))) return true;
  return hits.split(', ').every((hit) => CONTROL_ALLOWLIST[`${file}: ${hit}`]);
};

// Parsing every source file is slow under load: a generous limit.
describe('L-4: every file that reaches a gated action reads the canvas lock', { timeout: 120_000 }, () => {
  const files = walk(SRC, /\.tsx?$/).filter((path) => !path.endsWith('store/graphStore.ts'))
    .map((path) => ({ path, file: relative(SRC, path), source: readFileSync(path, 'utf8') }));
  const stores = storeNames(files);
  STORE_NAMES = stores;
  const reachesStore = (source: string, file: string) => identifiers(parse(source, file)).some((name) => stores.has(name));

  it('the scan sees every form review 23 and review 1 of PR #200 listed', () => {
    const forms: Record<string, string> = {
      A_selector: 'const run = useGraphStore((s) => s.executeGraph);',
      B_getState_alias: 'const graph = useGraphStore.getState(); graph.executeGraph();',
      C_destructure: 'const { executeGraph } = useGraphStore.getState();',
      D_shallow: 'useGraphStore(useShallow((s) => ({ run: s.executeGraph })));',
      E_bare_arrow: 'useGraphStore(s => s.executeGraph);',
      F_hook_destructure: 'const { executeGraph } = useGraphStore();',
      H_bracket: "const run = useGraphStore((s) => s['executeGraph']);",
      L_quote_before: 'const x = <button title="Don\'t" onClick={() => useGraphStore.getState().executeGraph()} />;',
      M_glob_in_string: 'const x = <input accept="image/*" />;\nconst run = useGraphStore((s) => s.executeGraph);\n/* a comment */',
    };
    for (const [form, line] of Object.entries(forms)) expect(gatedNames(line), form).toContain('executeGraph');
    expect(gatedNames('// undo the last step\nconst offer = \'redo\';')).toEqual([]);
    expect(gatedNames('/* executeGraph */ const label = "executeGraph";')).toEqual([]);
  });

  it('a re-exported store counts (J): a file that reaches it by another name is checked', () => {
    const fake = [
      { file: 'lib/storeAlias.ts', source: "export { useGraphStore as useG } from '../store/graphStore';" },
      { file: 'lib/storeAlias2.ts', source: "import { useG } from './storeAlias';\nexport const useH = useG;" },
    ];
    const names = storeNames(fake);
    expect([...names]).toEqual(expect.arrayContaining(['useGraphStore', 'useG', 'useH']));
  });

  it('each reads the lock, names its locked delegates, or is allowlisted with a reason', () => {
    const missing = files.flatMap(({ file, source }) => {
      if (!reachesStore(source, file)) return [];
      const uses = gatedNames(source, file);
      if (uses.length === 0) return [];
      if (READS_LOCK.test(source) || DELEGATES[file] || ALLOWLIST[file]) return [];
      return [`${file}: ${uses.join(', ')}`];
    });
    expect(missing).toEqual([]);
  });

  it('G: in a file that reads the lock, every control that reaches a gated action carries the lock', () => {
    const probe = 'const lock = useCanvasLock();\nconst run = useGraphStore((s) => s.executeGraph);\n'
      + 'export const A = () => <><button {...lock.act()} onClick={run}>Run</button><button onClick={() => run()}>New</button></>;';
    expect(unlockedControls(probe, 'probe.tsx')).toEqual(['probe.tsx:3 <button> executeGraph']);
    // Fix round 3 (review 3 LOW-6): every .tsx, not only those that read the
    // lock (a file that never reads it can still call a gated helper).
    const found = files.filter(({ path }) => path.endsWith('.tsx'))
      .flatMap(({ file, source }) => unlockedControls(source, file, resolveSource))
      .filter((line) => !allowed(line));
    expect(found).toEqual([]);
  });

  // Fix round 3 of PR #200: review 3's G corpus (r3/fe/ratchet3.probe.test.ts,
  // ratchet3.facts.json "bypass"): the 16 forms that slipped, and the ones
  // that were too strict.
  it('G corpus (review 3, LOW-6): each of the 17 forms is caught; parent props and lock locals stay quiet', () => {
    const head = 'const lock = useCanvasLock();\nconst run = useGraphStore((s) => s.executeGraph);\n';
    const modules: Record<string, string> = {
      'lib/runAll.ts': 'export function runAll() { useGraphStore.getState().executeGraph(); }',
      'lib/barrel.ts': "export { runAll } from './runAll';",
      'lib/runDefault.ts': 'export default function runDefault() { useGraphStore.getState().executeGraph(); }',
      'lib/outer.ts': "import { runAll } from './runAll';\nexport function outer() { runAll(); }",
      'lib/runConst.ts': 'export const runConst = function () { useGraphStore.getState().executeGraph(); };',
      'lib/runObj.ts': 'export const runner = { go() { useGraphStore.getState().executeGraph(); } };',
    };
    const resolve: Resolve = (specifier) => {
      const file = `lib/${specifier.replace(/^.*\//, '')}.ts`;
      return modules[file] ? { file, source: modules[file] } : null;
    };
    const forms: Record<string, string> = {
      r_reexport_barrel: "import { runAll } from '../lib/barrel';\nexport const A = () => <button onClick={() => runAll()}>Run</button>;",
      s_default_export: "import runDefault from '../lib/runDefault';\nexport const A = () => <button onClick={() => runDefault()}>Run</button>;",
      t_two_levels: "import { outer } from '../lib/outer';\nexport const A = () => <button onClick={() => outer()}>Run</button>;",
      t2_exported_const_fn: "import { runConst } from '../lib/runConst';\nexport const A = () => <button onClick={() => runConst()}>Run</button>;",
      t3_imported_object_method: "import { runner } from '../lib/runObj';\nexport const A = () => <button onClick={() => runner.go()}>Run</button>;",
      u_non_on_prop: 'export const A = () => <MenuItem action={() => run()} />;',
      u2_render_prop: 'export const A = () => <Menu items={[{ label: "Run", select: () => run() }]} />;',
      v_classname_lock: 'export const A = () => <button className={lock.locked ? "dim" : ""} onClick={() => run()}>Run</button>;',
      w_title_only: 'export const A = () => <button title={lock.title("Run")} onClick={() => run()}>Run</button>;',
      w2_aria_only: 'export const A = () => <button aria-label={lock.locked ? "Run (locked)" : "Run"} onClick={() => run()}>Run</button>;',
      x_inverted: 'export const A = () => <button disabled={!lock.locked} onClick={() => run()}>Run</button>;',
      x2_and_false: 'export const A = () => <button disabled={lock.locked && false} onClick={() => run()}>Run</button>;',
      y_ancestor_title: 'export const A = () => <div title={lock.title("x")}><button onClick={() => run()}>Run</button></div>;',
      y2_ancestor_classname: 'export const A = () => <section className={lock.locked ? "ro" : ""}><button onClick={() => run()}>Run</button></section>;',
      z_mark_only: 'export const A = () => <button {...lock.mark} onClick={() => run()}>Run</button>;',
      aa_data_attr_locked: 'export const A = () => <button data-x={lock.locked} onClick={() => run()}>Run</button>;',
      ab_key_prop: 'export const A = () => <button key={String(lock.locked)} onClick={() => run()}>Run</button>;',
    };
    expect(Object.keys(forms)).toHaveLength(17);
    const missed = Object.entries(forms).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`, resolve).length !== 1)
      .map(([form]) => form);
    expect(missed, 'forms G lets through').toEqual([]);
    const quiet: Record<string, string> = {
      readOnly_prop_from_parent: 'export const A = ({ readOnly }: { readOnly: boolean }) => <button disabled={readOnly} onClick={() => run()}>Run</button>;',
      disabled_prop_named_disabled: 'export const A = ({ disabled }: { disabled: boolean }) => <button disabled={disabled} onClick={() => run()}>Run</button>;',
      local_readonly: 'const readOnly = lock.locked;\nexport const A = () => <button disabled={readOnly} onClick={() => run()}>Run</button>;',
      memo_locked: 'const off = useMemo(() => lock.locked, [lock]);\nexport const A = () => <button disabled={off} onClick={() => run()}>Run</button>;',
      act_via_local: 'const acts = lock.act();\nexport const A = () => <button {...acts} onClick={() => run()}>Run</button>;',
      aria_disabled: 'export const A = () => <div role="button" aria-disabled={lock.locked || undefined} onClick={() => run()} />;',
      destructured_locked: 'const { locked } = lock;\nexport const A = () => <button disabled={locked} onClick={() => run()}>Run</button>;',
      locked_fieldset: 'export const A = () => <fieldset disabled={busy || lock.locked}><button onClick={() => run()}>Run</button></fieldset>;',
      render_prop_row_locked: 'export const A = () => <List render={() => <button {...lock.act()} onClick={() => run()}>Run</button>} />;',
    };
    const loud = Object.entries(quiet).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`, resolve).length !== 0)
      .map(([form]) => form);
    expect(loud, 'locked or harmless controls G flags').toEqual([]);
  });

  it('a locked component is known by the file it comes from, never its name (review 3 LOW-6)', () => {
    const real = "import { MaskPainterModal } from './MaskPainterModal';\n"
      + 'const run = useGraphStore((s) => s.updateNodeData);\nexport const A = () => <MaskPainterModal onSave={() => run()} />;';
    const local = 'const MaskPainterModal = (p: { onSave: () => void }) => <div />;\n'
      + 'const run = useGraphStore((s) => s.updateNodeData);\nexport const A = () => <MaskPainterModal onSave={() => run()} />;';
    const resolve: Resolve = (specifier, fromFile) => resolveSource(specifier, fromFile);
    const [fromReal] = unlockedControls(real, 'components/panels/Inspector.tsx', resolve);
    const [fromLocal] = unlockedControls(local, 'components/panels/NewThing.tsx', resolve);
    expect(fromReal).toMatch(/\[components\/panels\/MaskPainterModal\.tsx\]$/);
    expect(allowed(fromReal)).toBe(true);
    expect(allowed(fromLocal)).toBe(false);
    expect(allowed('components/NewThing.tsx:3 <ProviderSwitcher> clearGraph')).toBe(false);
  });

  it('a file that never reads the lock is checked too (review 3: a button calling an allowlisted helper)', () => {
    const noLock = "import { clearBackendNodes } from '../lib/chatCanvasClear';\n"
      + 'export const A = () => <button onClick={() => void clearBackendNodes()}>Clear</button>;';
    expect(unlockedControls(noLock, 'components/NoLock.tsx', resolveSource)).toEqual(['components/NoLock.tsx:2 <button> clearBackendNodes']);
  });

  // Fix round 2 of PR #200: review 2's G corpus (ratchet.facts G-CASES),
  // every form the old check let through, and the controls that stay quiet.
  it('G corpus (review 2, L-5): each of the 17 bypass forms is caught; a real lock, a fenced control and a shadowing local are not', () => {
    const head = 'const lock = useCanvasLock();\nconst run = useGraphStore((s) => s.executeGraph);\n';
    const modules: Record<string, string> = {
      'lib/runAll.ts': 'export function runAll() { useGraphStore.getState().executeGraph(); }',
      'lib/useRunner.ts': 'export const useRunner = () => ({ go: () => useGraphStore.getState().executeGraph() });',
    };
    const resolve: Resolve = (specifier) => {
      const file = `lib/${specifier.replace(/^.*\//, '')}.ts`;
      return modules[file] ? { file, source: modules[file] } : null;
    };
    const bypasses: Record<string, string> = {
      a_data_lock: 'export const A = () => <button data-lock onClick={() => run()}>Run</button>;',
      b_label_locked: 'export const A = () => <button aria-label="Run (locked while busy)" onClick={() => run()}>Run</button>;',
      c_readonly_false: 'export const A = () => <input readOnly={false} onChange={() => run()} />;',
      d_confirm_prop: 'export const A = () => <button confirm={{}} onClick={() => run()}>Run</button>;',
      e_custom_prop_name: 'export const A = () => <Toolbar onRun={() => run()} />;',
      f_drag_end: 'export const A = () => <div draggable onDragEnd={() => run()} />;',
      g_keypress: 'export const A = () => <input onKeyPress={() => run()} />;',
      h_capture: 'export const A = () => <button onClickCapture={() => run()}>Run</button>;',
      i_context_menu: 'export const A = () => <div onContextMenu={() => run()} />;',
      j_paste: 'export const A = () => <textarea onPaste={() => run()} />;',
      k_spread_handlers: 'const handlers = { onClick: () => run() };\nexport const A = () => <button {...handlers}>Run</button>;',
      l_imported_helper: "import { runAll } from '../lib/runAll';\nexport const A = () => <button onClick={() => runAll()}>Run</button>;",
      m_hook_return: "import { useRunner } from '../lib/useRunner';\nconst { go } = useRunner();\nexport const A = () => <button onClick={go}>Run</button>;",
      n_ref_assigned: 'const ref = { current: () => {} };\nref.current = () => run();\nexport const A = () => <button onClick={() => ref.current()}>Run</button>;',
      o_lock_unrelated_classname: 'export const A = () => <button className="clock" title="lock screen" onClick={() => run()}>Run</button>;',
      p_disabled_false_by_lock_name: 'const locked = false;\nexport const A = () => <button disabled={locked} onClick={() => run()}>Run</button>;',
      q_fieldset_any_lock: 'export const A = () => <div data-x="lock"><button onClick={() => run()}>Run</button></div>;',
    };
    expect(Object.keys(bypasses)).toHaveLength(17);
    const missed = Object.entries(bypasses).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`, resolve).length !== 1)
      .map(([form]) => form);
    expect(missed, 'forms G lets through').toEqual([]);
    const quiet: Record<string, string> = {
      act: 'export const A = () => <button {...lock.act()} onClick={() => run()}>Run</button>;',
      locked: 'export const A = () => <button disabled={busy || lock.locked} {...lock.mark} onClick={() => run()}>Run</button>;',
      local_from_lock: 'const locked = lock.locked;\nexport const A = () => <button disabled={locked} onClick={() => run()}>Run</button>;',
      prop: 'export const A = ({ locked }: { locked: boolean }) => <button disabled={locked} onClick={() => run()}>Run</button>;',
      passed_down: 'export const A = () => <Toolbar lock={lock} onRun={() => run()} />;',
      fieldset: 'export const A = () => <fieldset disabled={lock.locked}><button onClick={() => run()}>Run</button></fieldset>;',
      shadow_undo: 'const undo = () => setText(prev);\nexport const A = () => <button onClick={() => undo()}>Undo typing</button>;',
      no_gated: 'export const A = () => <button onClick={() => setOpen(true)}>Open</button>;',
    };
    const loud = Object.entries(quiet).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`, resolve).length !== 0)
      .map(([form]) => form);
    expect(loud, 'locked or harmless controls G flags').toEqual([]);
  });

  it('a component that takes the lock itself reads it (fix round 2 of PR #200)', () => {
    for (const [tag, { file, reason }] of Object.entries(LOCKED_COMPONENTS)) {
      expect(reason.trim(), tag).not.toBe('');
      expect(readFileSync(join(SRC, file), 'utf8'), `${tag} (${file})`).toMatch(READS_LOCK);
    }
  });

  it('the lists stay true: every entry still names a gated action, has a reason, and an allowlisted file has no lock to read', () => {
    for (const [file, reason] of Object.entries({ ...DELEGATES, ...ALLOWLIST })) {
      expect(reason.trim(), file).not.toBe('');
      const source = readFileSync(join(SRC, file), 'utf8');
      expect(gatedNames(source, file), `${file} no longer names a gated action: drop it from the list`).not.toEqual([]);
    }
  });

  // EditNode's Open Editor (review 1 L-5) left the list in fix round 2
  // (review 2 L-6): it opens its own editor, read-only, and writes nothing.
  it('review 23\'s two misses read the lock now', () => {
    for (const file of ['components/editor/EditorView.tsx', 'components/panels/ChatPanel.tsx', 'components/video-editor/useRemotionKeyboard.ts']) {
      expect(readFileSync(join(SRC, file), 'utf8'), file).toMatch(READS_LOCK);
    }
  });
});

// ── 2. GM r24 item 2 and PR #200 answer 6: one disabled colour treatment ──

const SHARED = 'styles/disabled-buttons.css';
/** A resting fill that reads as a filled button: the accent, danger, error,
 * the white of a white primary, or another solid colour (light, or clearly
 * coloured). Dark greys (#2a2a2a) and translucent surfaces are no fill. */
const FILL_TOKEN = /background(?:-color)?\s*:\s*var\(--(?:sr-accent|sr-error|sr-danger|sr-ink|sr-ink-bold|an-ink)\s*[,)]/i;
/** CSS's named colours (review 3 LOW-6: whitesmoke, orange …). */
const NAMED_COLORS = new Map(('aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32').split(' ').map((pair) => pair.split(':') as [string, string]));

/** `name(args)` at the start of `value`, parens balanced. */
function leadingCall(value: string): { name: string; args: string; rest: string } | null {
  const m = /^([a-z-]+)\(/i.exec(value);
  if (!m) return null;
  let depth = 1; let at = m[0].length;
  for (; at < value.length && depth > 0; at += 1) {
    if (value[at] === '(') depth += 1;
    else if (value[at] === ')') depth -= 1;
  }
  return { name: m[1].toLowerCase(), args: value.slice(m[0].length, at - 1), rest: value.slice(at) };
}
/** Top-level comma (or space) separated parts. */
function topParts(value: string, by: ',' | ' '): string[] {
  const parts: string[] = [];
  let depth = 0; let start = 0;
  for (let at = 0; at < value.length; at += 1) {
    const ch = value[at];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && (by === ',' ? ch === ',' : /\s/.test(ch))) { parts.push(value.slice(start, at)); start = at + 1; }
  }
  parts.push(value.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}
const UNKNOWN_COLOR = 'unknown-color';
const encode = (c: number) => 255 * Math.max(0, Math.min(1, c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
/** OKLab to sRGB (Björn Ottosson's matrices). */
function oklabToRgb(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return { r: encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: encode(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s) };
}

/** Fix round 2 of PR #200 (review 2, M-3 and L-5): the colour forms a
 * fill is written in: hex, rgb()/rgba() (comma or space syntax, alpha as a
 * number or %), hsl()/hsla(), and a gradient's first stop. Fix round 3
 * (review 3 LOW-6): every named colour, currentColor, color-mix() (by its
 * percentages, mixed in sRGB), oklch() and oklab(); a custom property that
 * no sheet gives a value (Nebula sets it at run time) is an unknown colour,
 * counted as a fill. lab()/lch()/color() are not read (no sheet uses them). */
function parseColor(raw: string): { r: number; g: number; b: number; a: number } | null {
  const value = raw.trim().toLowerCase();
  if (value.startsWith(UNKNOWN_COLOR) || /^currentcolor\b/.test(value)) return { r: 200, g: 200, b: 200, a: 1 };
  if (/^transparent\b/.test(value)) return { r: 0, g: 0, b: 0, a: 0 };
  const word = /^[a-z]+/.exec(value)?.[0];
  if (word && NAMED_COLORS.has(word) && !/^[a-z]+\(/.test(value)) return parseColor(`#${NAMED_COLORS.get(word)}`);
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
    const a = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  const call = leadingCall(value);
  if (!call) return null;
  const alphaOf = (part: string | undefined) => (part === undefined ? 1 : part.endsWith('%') ? Number.parseFloat(part) / 100 : Number.parseFloat(part));
  if (call.name === 'color-mix') {
    const [, ...stops] = topParts(call.args, ',');
    if (stops.length !== 2) return null;
    const mixed = stops.map((stop) => {
      const pct = /\s([\d.]+)%\s*$/.exec(stop);
      return { color: parseColor(pct ? stop.slice(0, pct.index) : stop), weight: pct ? Number.parseFloat(pct[1]) / 100 : null };
    });
    if (mixed.some((m) => !m.color)) return null;
    let [p, q] = mixed.map((m) => m.weight);
    if (p === null && q === null) { p = 0.5; q = 0.5; } else if (p === null) p = 1 - q!; else if (q === null) q = 1 - p;
    const total = p! + q!;
    const [A, B] = [mixed[0].color!, mixed[1].color!];
    const wa = (p! / total) * A.a; const wb = (q! / total) * B.a;
    const alpha = (wa + wb) * Math.min(1, total);
    const mix = (x: number, y: number) => (wa + wb > 0 ? (x * wa + y * wb) / (wa + wb) : 0);
    return { r: mix(A.r, B.r), g: mix(A.g, B.g), b: mix(A.b, B.b), a: alpha };
  }
  const parts = call.args.replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
  const num = (part: string | undefined, scale: number) => (part === undefined ? NaN
    : part.endsWith('%') ? Number.parseFloat(part) / 100 * scale : Number.parseFloat(part));
  if (call.name === 'oklch' || call.name === 'oklab') {
    const L = num(parts[0], 1);
    const alpha = alphaOf(parts[3]);
    let a = num(parts[1], 0.4); let b = num(parts[2], 0.4);
    if (call.name === 'oklch') { const h = Number.parseFloat(parts[2]) * Math.PI / 180; const c = a; a = c * Math.cos(h); b = c * Math.sin(h); }
    if ([L, a, b, alpha].some(Number.isNaN)) return null;
    return { ...oklabToRgb(L, a, b), a: alpha };
  }
  const alpha = alphaOf(parts[3]);
  if (call.name === 'rgb' || call.name === 'rgba') {
    const [r, g, b] = [0, 1, 2].map((at) => num(parts[at], 255));
    return [r, g, b, alpha].some(Number.isNaN) ? null : { r, g, b, a: alpha };
  }
  if (call.name !== 'hsl' && call.name !== 'hsla') return null;
  const h = parts[0]?.endsWith('turn') ? Number.parseFloat(parts[0]) * 360 : Number.parseFloat(parts[0]);
  const sat = num(parts[1], 1); const light = num(parts[2], 1);
  if ([h, sat, light, alpha].some(Number.isNaN)) return null;
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: alpha };
}

/** Every custom property a sheet gives a value (the dark theme's first), for
 * a fill written with one. */
let fillTokenCache: Map<string, string> | null = null;
function fillTokens(): Map<string, string> {
  if (fillTokenCache) return fillTokenCache;
  const tokens = new Map(cssTokens());
  for (const path of walk(SRC, /\.css$/)) {
    for (const { body } of cssRules(readFileSync(path, 'utf8'))) {
      for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) if (!tokens.has(m[1])) tokens.set(m[1], m[2].trim());
    }
  }
  fillTokenCache = tokens;
  return tokens;
}
/** var() resolved: a sheet's value, else its fallback, else an unknown colour. */
function resolveFill(value: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 8) return value;
  return value.replace(/var\((--[\w-]+)\s*(?:,\s*((?:[^()]|\((?:[^()]|\([^()]*\))*\))*))?\)/g, (_m, name: string, fallback?: string) =>
    resolveFill(tokens.get(name) ?? fallback ?? UNKNOWN_COLOR, tokens, depth + 1));
}
/** A background value's colour: a gradient's first stop (any layer), else
 * the colour of its last layer (where the shorthand puts it). */
function backgroundColor(value: string): { r: number; g: number; b: number; a: number } | null {
  const layers = topParts(value, ',');
  for (const layer of layers) {
    for (const token of topParts(layer, ' ')) {
      const call = leadingCall(token);
      if (!call || !/gradient$/.test(call.name)) continue;
      for (const arg of topParts(call.args, ',')) {
        const color = parseColor(topParts(arg, ' ')[0] ?? '');
        if (color) return color;
      }
    }
  }
  for (const layer of [...layers].reverse()) {
    for (const token of topParts(layer, ' ')) {
      const color = parseColor(token);
      if (color) return color;
    }
  }
  return null;
}
function solidFill(body: string): boolean {
  if (FILL_TOKEN.test(body) || /background(?:-image)?\s*:[^;]*gradient\([^;]*var\(--(?:sr-accent|sr-error|sr-danger|sr-ink)\s*[,)]/i.test(body)) return true;
  const declared = /(?:^|;)\s*background(?:-color|-image)?\s*:\s*([^;]+)/i.exec(body)?.[1]?.replace(/!important/i, '').trim().toLowerCase() ?? '';
  if (!declared) return false;
  const color = backgroundColor(resolveFill(declared, fillTokens()));
  // At half alpha or under: a translucent surface, no fill.
  if (!color || color.a <= 0.5) return false;
  const { r, g, b } = color;
  return Math.max(r, g, b) - Math.min(r, g, b) > 60 || (r + g + b) / 3 > 150;
}
/** A class that names a control a person presses. */
const BUTTONISH = /(?:button|btn|action|generate|send|download|start|export|render|cta|confirm|submit|apply|primary|open|save|new|back|danger|accept)\b/i;
/** Filled button-like classes the shared rule leaves alone, and why (the sweep list). */
const NOT_COVERED: Record<string, string> = {
  'commons-button': "the Commons' own light theme: a grey of white over its pale fill would vanish; it gets its own neutral in the app-wide sweep",
  'commons-button--primary': "the Commons' own light theme (as commons-button)",
  // Fix round 2 of PR #200: the fill parser now reads gradients; this one
  // matches BUTTONISH by its "back" ("fallback").
  'mesh-modal__fallback': "a <div> (MeshPreview's preview-unavailable panel), not a control",
};

/** A selector list split on its top-level commas, each `:is()`/`:where()`
 * list expanded into its alternatives (fix round 3 of PR #200, review 3
 * LOW-6: `.toast:is(.a, .b) .toast__undo` is two selectors that style
 * `.toast__undo`, never `.a`). */
function selectorsOf(selector: string): string[] {
  const top: string[] = [];
  let depth = 0; let start = 0;
  for (let at = 0; at < selector.length; at += 1) {
    const ch = selector[at];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) { top.push(selector.slice(start, at)); start = at + 1; }
  }
  top.push(selector.slice(start));
  const expand = (one: string, guard = 0): string[] => {
    const m = /:(?:is|where)\(/.exec(one);
    if (!m || guard > 6) return [one.trim()];
    let depthIn = 1; let end = m.index + m[0].length;
    for (; end < one.length && depthIn > 0; end += 1) {
      if (one[end] === '(') depthIn += 1;
      else if (one[end] === ')') depthIn -= 1;
    }
    const inner = one.slice(m.index + m[0].length, end - 1);
    return selectorsOf(inner).flatMap((alt) => expand(one.slice(0, m.index) + alt + one.slice(end), guard + 1));
  };
  return top.map((one) => one.trim()).filter(Boolean).flatMap((one) => expand(one));
}

function cssRules(css: string): Array<{ selector: string; body: string }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }));
}

/** The class a selector styles: its last compound's last class. */
function subjectClass(selector: string): string | null {
  const last = selector.replace(/:not\([^)]*\)/g, '').trim().split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
  const classes = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  return classes.length ? classes[classes.length - 1] : null;
}

/** A rule's state: resting, or a state (hover, focus, disabled …). */
const STATE = /:(hover|focus|active|disabled|checked)|\[aria-(disabled|pressed|selected|checked|expanded)|\[data-|--selected|--active|::/;

function filledButtons(): Array<{ file: string; className: string }> {
  const found: Array<{ file: string; className: string }> = [];
  for (const path of walk(SRC, /\.css$/)) {
    const file = relative(SRC, path);
    if (file === SHARED) continue;
    for (const { selector, body } of cssRules(readFileSync(path, 'utf8'))) {
      if (!solidFill(body)) continue;
      for (const one of selectorsOf(selector)) {
        // The legacy look (body:not(.app-slava-restraint)) is never shown.
        if (STATE.test(one) || /:not\(\.app-slava-restraint\)/.test(one)) continue;
        const className = subjectClass(one);
        if (className && BUTTONISH.test(className) && !NOT_COVERED[className]) found.push({ file, className });
      }
    }
  }
  return found;
}

/**
 * Disabled looks of their own, outside the shared file, that the app-wide
 * sweep still has to fold in (GM answer 6: "otherwise it goes on the sweep
 * list"). This list only shrinks: a new button style with a disabled look of
 * its own fails below until it is in the shared rule (or, with a reason, here).
 */
const SWEEP_LATER = new Set([
  'App.css: provider-recovery-status button',
  'components/agent-notes/agentNotes.css: agent-notes-btn',
  'styles/asset-move.css: asset-move__item',
  'styles/asset-move.css: asset-move__trigger',
  'styles/asset-proposals.css: asset-proposal__button',
  'styles/asset-trash.css: asset-trash__button',
  'styles/batch-node.css: batch-carousel button',
  'styles/canvas-next-steps.css: connection-popup__item',
  'styles/canvas-toolbar.css: toolbar__action',
  'styles/canvas-toolbar.css: toolbar__button',
  'styles/character-studio.css: character-def__ref-add',
  'styles/character-studio.css: character-palette__new',
  'styles/character-studio.css: character-rail__new',
  'styles/character-studio.css: character-test__run',
  'styles/chat-model-picker.css: chat-model-picker__trigger',
  'styles/commons-evaluation.css: evaluation-workspace button',
  'styles/commons.css: commons-button',
  'styles/commons.css: commons-fieldset button',
  'styles/commons.css: commons-link',
  'styles/create-gallery.css: create-composer button',
  'styles/create-gallery.css: result-card button',
  'styles/create-gallery.css: results-gallery button',
  'styles/moodboard-studio.css: moodboard-analysis button',
  'styles/moodboard-studio.css: moodboard-rail__new',
  'styles/nodes.css: model-node button',
  'styles/panels.css: chat-panel__connect-btn',
  'styles/panels.css: context-menu__item',
  'styles/paper-source-node.css: paper-source-node button',
  'styles/personal-agents.css: permission-card button',
  'styles/project-home.css: project-home button',
  'styles/prompt-dialog.css: prompt-dialog button',
  'styles/run-history.css: run-history button',
  'styles/run-history.css: run-history__action',
  'styles/run-history.css: run-history__replay',
  'styles/settings.css: settings-label__action',
  'styles/settings.css: settings-switch',
  'styles/settings.css: settings__button',
  'styles/slava-restraint.css: canvas-tabs__btn',
  'styles/slava-restraint.css: context-menu__item',
  'styles/slava-restraint.css: editor-transport__btn',
  'styles/slava-restraint.css: editor-transport__range',
  'styles/world-preview.css: world-modal__button',
]);

describe('GM r24 item 2 and PR #200 answer 6: a disabled button is neutral grey whatever the reason', { timeout: 120_000 }, () => {
  const shared = readFileSync(join(SRC, SHARED), 'utf8');
  const rules = cssRules(shared);
  // The two list rules (fix round 3 added smaller ones for no-label buttons beside them).
  const filledRule = rules.find(({ selector, body }) => /:disabled/.test(selector) && /background:\s*var\(--sr-disabled-fill/.test(body)
    && /\.create-composer__generate\b/.test(selector));
  const unfilledRule = rules.find(({ selector, body }) => /:disabled/.test(selector) && /background:\s*transparent/.test(body)
    && /\.selection-toolbar__button\b/.test(selector));
  // A modifier (`__button--primary`) is covered with its block's button (`__button`): both classes are on it.
  const covered = (className: string) => [className, className.replace(/--[\w-]+$/, '')].some((name) =>
    [filledRule, unfilledRule].some((rule) => new RegExp(`\\.${name}(?![\\w-])`).test(rule?.selector ?? '')));

  it('two rules, one colour: a grey fill for filled buttons, unfilled for ghost and outline; no accent; no extra opacity', () => {
    expect(filledRule).toBeDefined();
    expect(unfilledRule).toBeDefined();
    for (const rule of [filledRule!, unfilledRule!]) {
      expect(rule.body).not.toMatch(/--sr-accent|--sr-error|--sr-danger|#ff5a1f/i);
      expect(rule.selector).toMatch(/:disabled/);
      expect(rule.selector).toMatch(/\[aria-disabled=['"]?true/);
      expect(rule.body).toMatch(/opacity:\s*1\s*!important/);
      expect(rule.body).toMatch(/color:\s*var\(--sr-disabled-ink/);
    }
    // The unfilled rule comes first: a filled style wins for a button that has both classes.
    expect(shared.indexOf('background: transparent !important')).toBeLessThan(shared.indexOf('background: var(--sr-disabled-fill'));
  });

  it('it is loaded app-wide (App.tsx imports it, after the shared styles)', () => {
    const app = readFileSync(join(SRC, 'App.tsx'), 'utf8');
    expect(app).toMatch(/import '\.\/styles\/disabled-buttons\.css';/);
    expect(app.indexOf('disabled-buttons.css')).toBeGreaterThan(app.indexOf('slava-restraint.css'));
  });

  it('the fill parser reads every colour form (review 2 SOLIDFILL): rgb(), rgba(), hsl(), gradients; translucent surfaces are no fill', () => {
    const fills: Record<string, boolean> = {
      'background: #ff5a1f;': true, 'background: rgb(255, 90, 31);': true, 'background: rgba(255,90,31,1);': true,
      'background: rgb(255 255 255 / 0.9);': true, 'background: hsl(16 100% 56%);': true, 'background: hsla(16, 100%, 56%, 0.9);': true,
      'background: linear-gradient(#ff5a1f, #e14a10);': true, 'background-image: linear-gradient(var(--sr-accent), var(--sr-accent));': true,
      'background: linear-gradient(180deg, rgba(255,255,255,0.95), #ddd);': true, 'background: white;': true,
      'background: var(--sr-accent) !important;': true,
      'background: rgba(255, 255, 255, 0.04);': false, 'background: rgb(255 255 255 / 0.05);': false, 'background: #2a2a2a;': false,
      'background: transparent;': false, 'background: none;': false, 'background: var(--sr-surface-control);': false,
    };
    const wrong = Object.entries(fills).filter(([body, want]) => solidFill(body) !== want).map(([body]) => body);
    expect(wrong).toEqual([]);
  });

  // Fix round 3 (review 3 LOW-6, ratchet3.facts.json "colour"): its false
  // positives and misses, and :is() lists split at their top-level commas.
  it('the fill parser (review 3): suffixed tokens and half-alpha white are no fill; color-mix, oklch, named colours, layers are', () => {
    const fills: Record<string, boolean> = {
      'background: var(--sr-accent-soft);': false, 'background: var(--sr-ink-faint);': false, 'background: var(--sr-accent-hover-soft);': false,
      'background: rgba(255, 255, 255, 0.5);': false,
      'background: color-mix(in srgb, var(--sr-accent) 92%, transparent);': true, 'background: color-mix(in srgb, #ff5a1f 90%, black);': true,
      'background: color-mix(in srgb, var(--sr-accent) 10%, transparent);': false,
      'background: oklch(70% 0.19 40);': true, 'background: oklch(20% 0.02 40);': false, 'background: whitesmoke;': true, 'background: orange;': true,
      'background: url(x.png), #ff5a1f;': true, 'background: linear-gradient(in oklab, #ff5a1f, #e14a10);': true,
      'background-color: var(--node-category-color);': true, 'background: currentColor;': true,
      'background: #ff5a1f url(x.png) no-repeat;': true, 'background: rgb(255 90 31 / 90%);': true, 'background-color: rgb(255 90 31 / .9);': true,
      'BACKGROUND: #FF5A1F;': true, 'background: hsl(0.05turn 100% 56%);': true, 'background: #fa0f;': true,
      'background: transparent linear-gradient(#ff5a1f, #e14a10);': true, 'background: black;': false, 'background: navy;': true,
    };
    const wrong = Object.entries(fills).filter(([body, want]) => solidFill(body) !== want).map(([body]) => body);
    expect(wrong).toEqual([]);
  });

  it(':is() lists are split at top-level commas (review 3: `.toast:is(.a, .b) .toast__undo` styles the undo)', () => {
    expect(selectorsOf('.toast:is(.a, .b) .toast__undo').map(subjectClass)).toEqual(['toast__undo', 'toast__undo']);
    expect(selectorsOf('.x:is(.primary, .y), .z')).toEqual(['.x.primary', '.x.y', '.z']);
    expect(selectorsOf(':is(.a, .b):is(:disabled, [aria-disabled])').length).toBe(4);
  });

  it('every filled button style is covered (accent, danger, white primaries, other solid fills)', () => {
    const found = filledButtons();
    expect(found.map((item) => item.className)).toEqual(expect.arrayContaining(['cinema-shot-panel__action--primary', 'create-composer__generate',
      'project-home__new', 'project-switch-toast__back', 'project-home__danger', 'prompt-dialog__danger', 'mask-painter__save',
      // Review 2 M-3: the toast's white Undo, Redo and Open copy (rgb()), and the board toast's.
      'canvas-undo-notice__action', 'moodboard-board-toast__action']));
    const uncovered = found.filter(({ className }) => !covered(className));
    expect(uncovered.map(({ file, className }) => `${file}: .${className}`)).toEqual([]);
  });

  it('a new button style with a disabled look of its own fails until the shared rule covers it (the sweep list only shrinks)', () => {
    const own = new Set<string>();
    for (const path of walk(SRC, /\.css$/)) {
      const file = relative(SRC, path);
      if (file === SHARED) continue;
      for (const { selector, body } of cssRules(readFileSync(path, 'utf8'))) {
        if (!/opacity|color|background|border/.test(body)) continue;
        for (const one of selectorsOf(selector)) {
          const state = one.replace(/:not\([^)]*\)/g, '');
          if (!/:disabled|\[aria-disabled/.test(state) || /:not\(\.app-slava-restraint\)/.test(one)) continue;
          // A bare `button:disabled` inside a block names the block.
          const subject = subjectClass(state);
          const bare = /(^|\s)button:disabled/.test(state) || /:is\(button/.test(state);
          const blocks = [...state.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
          const name = bare ? `${blocks[blocks.length - 1]?.replace(/__.*$/, '') ?? ''} button`.trim() : subject;
          if (!name || (!bare && (covered(name) || !BUTTONISH.test(name) && !/item|link|trigger|switch|range|preset|new|run|add/.test(name)))) continue;
          if (bare && blocks.length === 0) continue;
          own.add(`${file}: ${name}`);
        }
      }
    }
    const fresh = [...own].filter((entry) => !SWEEP_LATER.has(entry)).sort();
    expect(fresh, 'a disabled look outside styles/disabled-buttons.css').toEqual([]);
    const gone = [...SWEEP_LATER].filter((entry) => !own.has(entry)).sort();
    expect(gone, 'swept: drop these from SWEEP_LATER').toEqual([]);
  });

  // Fix round 2 of PR #200 (review 2 M-1, GM 2026-10-28 answers 2 and 3):
  // one shared grey, so every listed control's enabled look is brighter than
  // it: its label contrast above the grey's, and its disabled outline never
  // brighter than its own enabled edge. Measured on the canvas's black from
  // the stylesheets (tokens resolved), as the live check measures it.
  it('M-1: every listed control is dimmer disabled than enabled (label contrast lower, outline never brighter)', () => {
    const report = disabledLooks();
    const brighter = report.filter((row) => row.problem).map((row) => `${row.className}: ${row.problem}`);
    expect(brighter).toEqual([]);
    // The ones review 2 measured: raised to the normal ink.
    for (const name of ['cinema-shots-rail__add', 'cinema-shots-rail__remove', 'cinema-shared-controls__swatch-add', 'chat__codeblock-apply']) {
      const row = report.find((item) => item.className === name);
      expect(row, name).toBeDefined();
      expect(row!.enabled.label, name).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Fix round 3 of PR #200 (review 3 N-5 and LOW-2): "clearly dimmer" is a
  // floor, and modifiers count; the toolbar's red Delete was 6.9:1 → 6.3:1.
  it('N-5: an unfilled control\'s enabled label is at least 1.5× the grey; the red Delete is measured and clears it', () => {
    const report = disabledLooks();
    const danger = report.find((row) => row.className === 'selection-toolbar__button--danger');
    expect(danger, 'the modifier is measured').toBeDefined();
    expect(danger!.disabled.label).toBeLessThanOrEqual(CLEARLY_DIMMER * danger!.enabled.label);
    expect(report.find((row) => row.className === 'prompt-dialog__destructive')!.enabled.label).toBeGreaterThanOrEqual(danger!.disabled.label * 1.5);
    // On the toolbar's own surface, not black: the live check drew #ff968a at
    // 8.8:1 against the grey's 6.2:1 there (0.70, over the floor).
    const toolbar = cssRules(readFileSync(join(SRC, 'styles/canvas.css'), 'utf8')).find((rule) => rule.selector.trim() === '.selection-toolbar');
    const surface = over(parseColor(/background:\s*([^;]+)/.exec(toolbar!.body)![1])!, CANVAS);
    const red = parseColor(resolveFill('var(--sr-danger-ink)', fillTokens()))!;
    const grey = parseColor(resolveFill('var(--sr-disabled-ink)', fillTokens()))!;
    expect(contrast(over(grey, surface), surface)).toBeLessThanOrEqual(CLEARLY_DIMMER * contrast(over(red, surface), surface));
    for (const [name, reason] of Object.entries(HUE_ONLY_ASKED)) expect(reason.trim(), name).not.toBe('');
  });

  it('M-3: no-label buttons have a disabled look of their own; the selected one keeps a grey mark', () => {
    const shared = cssRules(readFileSync(join(SRC, SHARED), 'utf8'));
    for (const [name, { image, selected }] of Object.entries(NO_LABEL)) {
      const own = shared.filter(({ selector }) => new RegExp(`\\.${name}\\)?:is\\(:disabled`).test(selector));
      expect(own.length, `${name}: a disabled rule`).toBeGreaterThan(0);
      // Never a fill brighter than its resting look, and the edge no brighter than enabled.
      for (const { body } of own) expect(body, name).not.toMatch(/background:\s*var\(--sr-disabled-fill/);
      if (image) {
        const img = shared.find(({ selector }) => selector.includes(name) && /:disabled/.test(selector) && /\simg$/.test(selector.trim()));
        expect(img, `${name}: its image dims`).toBeDefined();
        expect(Number(/opacity:\s*([\d.]+)/.exec(img!.body)?.[1])).toBeLessThanOrEqual(0.55);
        expect(img!.body).toMatch(/filter:\s*grayscale\(1\)/);
      }
      const mark = shared.find(({ selector }) => selected.test(selector) && /:disabled/.test(selector));
      expect(mark, `${name}: the selected one keeps a mark`).toBeDefined();
      expect(mark!.body).toMatch(/border-color:\s*var\(--sr-disabled-ink/);
    }
  });

  it('M-1: the disabled outline is the plain edge (0.06), never the brighter 0.12; M-3: a disabled toast action never changes on hover', () => {
    const tokens = cssTokens();
    expect(parseColor(resolveVar('var(--sr-disabled-edge)', tokens))?.a).toBeCloseTo(0.06, 3);
    for (const name of ['canvas-undo-notice__action', 'moodboard-board-toast__action']) {
      const hovers = walk(SRC, /\.css$/).flatMap((path) => cssRules(readFileSync(path, 'utf8')).flatMap(({ selector }) => selectorsOf(selector)))
        .map((one) => one.trim()).filter((one) => new RegExp(`\\.${name}(?![\\w-])`).test(one) && /:hover/.test(one) && !/disabled-buttons/.test(one));
      expect(hovers.length, name).toBeGreaterThan(0);
      const ungated = hovers.filter((one) => !/:not\(:disabled\)/.test(one) && !/:disabled|aria-disabled/.test(one));
      expect(ungated, `${name}: a hover that lights a disabled button`).toEqual([]);
    }
  });

  it('no per-reason disabled look is left beside it (following or offline only)', () => {
    const perReason = walk(SRC, /\.css$/).flatMap((path) => cssRules(readFileSync(path, 'utf8'))
      .filter(({ selector, body }) => /\[data-(following|offline)-disabled\]/.test(selector) && /background/.test(body) && /generate|primary/.test(selector))
      .map(({ selector }) => `${relative(SRC, path)}: ${selector.replace(/\s+/g, ' ')}`));
    expect(perReason).toEqual([]);
  });
});

// ── Fix round 2 of PR #200: the looks the M-1 test measures ────────────────

/** Custom properties as the dark theme defines them (:root and
 * body.app-slava-restraint; the first definition wins, as the sheets load). */
function cssTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const file of ['styles/slava-restraint.css', SHARED, 'components/agent-notes/agentNotes.css']) {
    for (const { selector, body } of cssRules(readFileSync(join(SRC, file), 'utf8'))) {
      if (!/^(?::root|body\.app-slava-restraint)$/.test(selector.trim()) && !/--an-ink\s*:/.test(body)) continue;
      for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) if (!tokens.has(m[1])) tokens.set(m[1], m[2].trim());
    }
  }
  return tokens;
}
function resolveVar(value: string, tokens: Map<string, string>, depth = 0): string {
  if (depth > 8) return value;
  return value.replace(/var\((--[\w-]+)\s*(?:,\s*((?:[^()]|\([^()]*\))*))?\)/g, (_m, name: string, fallback?: string) =>
    resolveVar(tokens.get(name) ?? fallback ?? 'transparent', tokens, depth + 1)).replace(/\s*!important/, '').trim();
}
type Rgba = { r: number; g: number; b: number; a: number };
const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a),
  b: top.b * top.a + under.b * (1 - top.a), a: 1 });
const luminance = ({ r, g, b }: Rgba) => [r, g, b].map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; })
  .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
const contrast = (a: Rgba, b: Rgba) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const CANVAS: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const NONE: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/** A class's resting look: its block's rules, then its own, the dark theme's last. */
function restingLook(className: string, tokens: Map<string, string>): { color?: string; background?: string; edge?: string } {
  const look: { color?: string; background?: string; edge?: string } = {};
  const names = [className.replace(/--[\w-]+$/, ''), className].filter((name, i, all) => all.indexOf(name) === i);
  const rules: Array<{ slava: boolean; order: number; body: string; name: string }> = [];
  let order = 0;
  for (const path of walk(SRC, /\.css$/)) {
    if (relative(SRC, path) === SHARED) continue;
    for (const { selector, body } of cssRules(readFileSync(path, 'utf8'))) {
      for (const one of selectorsOf(selector)) {
        order += 1;
        if (STATE.test(one) || /:not\(\.app-slava-restraint\)/.test(one)) continue;
        const subject = one.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
        const own = [...subject.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
        const name = names.find((candidate) => own.includes(candidate) && own.every((c) => names.includes(c)));
        if (name) rules.push({ slava: /app-slava-restraint/.test(one), order, body, name });
      }
    }
  }
  rules.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name) || Number(a.slava) - Number(b.slava) || a.order - b.order);
  for (const { body } of rules) {
    for (const declaration of body.split(';')) {
      const m = /^\s*([\w-]+)\s*:\s*(.+?)\s*$/.exec(declaration);
      if (!m) continue;
      const [, property, raw] = m;
      const value = resolveVar(raw, tokens);
      if (property === 'color') look.color = value;
      // A fill Nebula sets at run time (an agent's colour) is a fill (resolveFill).
      else if (property === 'background' || property === 'background-color') look.background = resolveFill(raw.replace(/\s*!important/, ''), fillTokens()).trim();
      else if (property === 'border' || property === 'border-top' || property === 'border-bottom') {
        look.edge = /^(?:none|0|0px)\b/.test(value) ? 'none' : (/(rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}\b|white|transparent)/i.exec(value)?.[1] ?? look.edge);
      } else if (property === 'border-color' && look.edge !== 'none') look.edge = value;
      else if (property === 'border-style' && value === 'none') look.edge = 'none';
    }
  }
  if (!look.color || look.color === 'inherit') {
    // `color: inherit` reads its block's own colour (the toolbar's buttons).
    const block = className.replace(/__.*$/, '');
    if (block !== className) look.color = restingLook(block, tokens).color ?? look.color;
  }
  return look;
}

/** Buttons with no text label (fix round 3 of PR #200, review 3 M-3: the
 * old NO_LABEL list let them skip the check, and the variation looked the
 * same disabled). Each is checked for a disabled look of its own below
 * (noLabelLooks): an image dims (opacity at most the shared grey's 0.55,
 * greyscale), a cell stays unfilled; the selected one keeps a grey mark. */
const NO_LABEL: Record<string, { image: boolean; selected: RegExp }> = {
  'cinema-shot-panel__variation': { image: true, selected: /\.cinema-shot-panel__variation--active/ },
  'remotion-properties-panel__anchor-button': { image: false, selected: /\.remotion-properties-panel__anchor-button\[data-active='true'\]/ },
};
/** "Clearly dimmer" (GM r1 answer 2), fix round 3 of PR #200 (review 3
 * N-5): an enabled label at least 1.5 times the disabled grey's contrast,
 * the floor review 3 suggested. The neutral controls sit near 2× (17.6:1 or
 * 12.5:1 against 6.3:1); a coloured label that greys (the toolbar's red
 * Delete) must clear it by brightness, not by its hue change alone. */
const CLEARLY_DIMMER = 2 / 3;
/** Unfilled controls whose coloured label only changes hue disabled, left
 * for GM (fix round 3 of PR #200): the accent is the brand orange, so
 * lightening it is GM's call. */
const HUE_ONLY_ASKED: Record<string, string> = {
  'prompt-dialog__confirm': 'the accent label (6.7:1) against the grey (6.3:1): GM question, round 3 of PR #200',
};
/** Filled buttons whose enabled label is under the grey's contrast: the fill
 * shows the state (GM r2 answer 6, "Generate shot's contrast: no change; its
 * fill shows the state"). Each still turns from its fill to the grey fill,
 * which the test checks is dimmer. */
const FILL_SHOWS_STATE: Record<string, string> = {
  'create-composer__generate': 'white on the accent (2.9:1): GM r2 answer 6',
  'asset-trash__button--danger': 'white on danger: GM r2 answer 6',
  'project-home__danger': 'white on danger: GM r2 answer 6',
  'prompt-dialog__danger': 'white on danger: GM r2 answer 6',
  // Fix round 3: in the filled rule now (GM r1 answer 2: a filled button keeps its fill, grey).
  'proposal-bar__button--primary': "white on the agent's colour: its fill shows the state (GM r4 answer 3)",
};

function disabledLooks() {
  const tokens = cssTokens();
  const shared = readFileSync(join(SRC, SHARED), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const lists = [...shared.matchAll(/:is\(([^)]*)\):is\(:disabled[^{]*\{([^}]*)\}/g)].map((m) => ({ classes: [...m[1].matchAll(/\.([\w-]+)/g)].map((c) => c[1]), body: m[2] }));
  const ink = parseColor(resolveVar('var(--sr-disabled-ink)', tokens))!;
  const greyFill = parseColor(resolveVar('var(--sr-disabled-fill)', tokens))!;
  const greyEdge = parseColor(resolveVar('var(--sr-disabled-edge)', tokens))!;
  const rows: Array<{ className: string; enabled: { label: number; edge: number }; disabled: { label: number; edge: number }; problem: string | null }> = [];
  const seen = new Set<string>();
  const listed = new Set(lists.flatMap(({ classes }) => classes));
  // Review 3 N-5: a listed class's modifiers (`__button--danger`) are
  // measured too: the shared rule greys them as well.
  const modifiers = (className: string) => {
    const found = new Set<string>();
    for (const path of walk(SRC, /\.css$/)) {
      if (relative(SRC, path) === SHARED) continue;
      for (const { selector } of cssRules(readFileSync(path, 'utf8'))) {
        for (const one of selectorsOf(selector)) {
          if (STATE.test(one.replace(new RegExp(`\\.${className}--[\\w-]+`, 'g'), '')) || /:not\(\.app-slava-restraint\)/.test(one)) continue;
          for (const m of one.matchAll(new RegExp(`\\.(${className}--[\\w-]+)`, 'g'))) if (!listed.has(m[1])) found.add(m[1]);
        }
      }
    }
    return [...found];
  };
  for (const { classes, body } of lists) {
    const filled = /var\(--sr-disabled-fill/.test(/background:[^;]*/.exec(body)?.[0] ?? '');
    const noLabel = (name: string) => Object.keys(NO_LABEL).some((key) => name === key || name.startsWith(`${key}--`));
    for (const className of classes.filter((name) => !noLabel(name) || NO_LABEL[name]).flatMap((name) => [name, ...(noLabel(name) ? [] : modifiers(name))])) {
      if (seen.has(`${filled}${className}`)) continue;
      seen.add(`${filled}${className}`);
      const look = restingLook(className, tokens);
      const fill = look.background && !/^(?:none|transparent)$/.test(look.background) ? parseColor(look.background.replace(/^.*gradient\(\s*(?:[^,]*deg\s*,)?\s*/, '')) ?? NONE : NONE;
      const bg = over(fill, CANVAS);
      const label = look.color ? parseColor(look.color) : null;
      const edgeColor = look.edge && look.edge !== 'none' ? parseColor(look.edge) : null;
      const enabledEdge = edgeColor ? contrast(over(edgeColor, bg), bg) : 1;
      const disabledBg = filled ? over(greyFill, CANVAS) : CANVAS;
      const disabledEdge = !edgeColor ? 1 : filled ? 1 : contrast(over(greyEdge, CANVAS), CANVAS);
      const enabledLabel = label ? contrast(over(label, bg), bg) : 0;
      const disabledLabel = contrast(over(ink, disabledBg), disabledBg);
      let problem: string | null = null;
      // A filled modifier the unfilled rule greys (the toolbar's orange Run):
      // its fill goes, which shows the state (GM r4 answer 3).
      const fillGoes = !filled && fill.a >= 0.5;
      if (!NO_LABEL[className] && !fillGoes) {
        if (!label) problem = `no resting label colour found (${JSON.stringify(look)})`;
        else if (filled && FILL_SHOWS_STATE[className]) {
          if (contrast(bg, CANVAS) <= contrast(disabledBg, CANVAS)) problem = 'its fill is no brighter than the grey fill';
          // The list stays true: only labels that really are under the grey's.
          else if (disabledLabel < enabledLabel) problem = 'its label is brighter than the grey: drop it from FILL_SHOWS_STATE';
        } else if (disabledLabel >= enabledLabel) {
          problem = `disabled label ${disabledLabel.toFixed(2)}:1 is not dimmer than enabled ${enabledLabel.toFixed(2)}:1`;
        } else if (!filled && !HUE_ONLY_ASKED[className] && disabledLabel > CLEARLY_DIMMER * enabledLabel) {
          // A filled button shows its state in the fill (GM r4 answer 3);
          // an unfilled one only by its label.
          problem = `disabled label ${disabledLabel.toFixed(2)}:1 is not clearly dimmer than enabled ${enabledLabel.toFixed(2)}:1 (at most ${(CLEARLY_DIMMER * enabledLabel).toFixed(2)}:1)`;
        }
      }
      if (!problem && !fillGoes && disabledEdge > enabledEdge + 1e-6) problem = `disabled edge ${disabledEdge.toFixed(2)}:1 is brighter than enabled ${enabledEdge.toFixed(2)}:1`;
      rows.push({ className, enabled: { label: enabledLabel, edge: enabledEdge }, disabled: { label: disabledLabel, edge: disabledEdge }, problem });
    }
  }
  return rows;
}
