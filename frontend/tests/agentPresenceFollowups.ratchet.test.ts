import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { gatedGraphActions } from '../src/store/graphStore';
import { type JsxTree, appControls, appCss, appMenuItemFindings, cascadeFindings, controlsIn, controlsInFiles, customProperties, frameFindings, PRESENCE_COLOUR, menuItemFindings, notRedFindings, pressedFindings, ruleFindings, wordFindings, wordKind } from './helpers/destructiveRule';

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

/** Fix round 4 of PR #200 (review 4 LOW-4, "trust by name"): a name a
 * parent hands down is trusted only when it really is a parameter of a
 * function around it (`({ disabled }) => …`, `(props) => … props.locked`),
 * never a global or an undeclared name that happens to be called that. */
/* Fix round 5 (review 5 LOW-3): only a parameter of the component function
 * itself, the outermost function around the name (`memo(…)` and
 * `forwardRef(…)` wrap it without a function of their own), never of a
 * callback inside it: `[false].map((disabled) => …)` and `render={(locked)
 * => …}` name a value the parent never handed down. */
function boundByParam(id: ts.Identifier): boolean {
  const names = (name: ts.BindingName): string[] => ts.isIdentifier(name) ? [name.text]
    : name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : names(element.name));
  let outermost: ts.SignatureDeclaration | null = null;
  for (let up: ts.Node | undefined = id.parent; up; up = up.parent) if (ts.isFunctionLike(up)) outermost = up;
  return !!outermost && outermost.parameters.some((parameter) => names(parameter.name).includes(id.text));
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
  // The file's own definitions it names are followed from a worklist, not by
  // recursion (the merge of PR #198: a long chain of local helpers in a
  // module it reaches overflowed the stack). Same names, same `seen`.
  const queue: ts.Node[] = [node];
  let root = node;
  const visit = (current: ts.Node) => {
    // Nested JSX is an element of its own, checked on its own (a render prop
    // that returns <Row onClick={…}/> is that row's, not the outer's).
    if (current !== root && (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current))) return;
    if (ts.isIdentifier(current)) {
      const name = current.text;
      const local = localsAt(current, scope);
      if (local && isReference(current)) {
        // Each definition once (fix round 25: by the definition, since two
        // functions' same-named locals are two things now).
        for (const definition of local) {
          const key = `${scope.file}#${name}@${definition.pos}`;
          if (!seen.has(key)) { seen.add(key); queue.push(definition); }
        }
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
  for (let at = 0; at < queue.length; at += 1) { root = queue[at]; visit(root); }
  return names;
}

/** Where a file definition is in scope (scopeOf's `locals` entry): the
 * block, loop or catch of a `const`/`let`, the function of a `var`, the
 * block of a function declaration; null for an assignment (`a.b = f`),
 * which counts wherever `a` is named. */
function declaredIn(definition: ts.Node): ts.Node | null {
  if (ts.isFunctionDeclaration(definition)) return definition.parent;
  let up: ts.Node | undefined = definition.parent;
  if (up && ts.isBinaryExpression(up)) return null;
  while (up && (ts.isBindingElement(up) || ts.isObjectBindingPattern(up) || ts.isArrayBindingPattern(up))) up = up.parent;
  if (!up || !ts.isVariableDeclaration(up)) return null;
  const list = up.parent;
  if (!ts.isVariableDeclarationList(list)) return list;
  const blockScoped = (list.flags & ts.NodeFlags.BlockScoped) !== 0;
  for (let at: ts.Node | undefined = list.parent; at; at = at.parent) {
    if (blockScoped ? (ts.isBlock(at) || ts.isSourceFile(at) || ts.isModuleBlock(at) || ts.isCaseBlock(at) || ts.isForStatement(at)
      || ts.isForInStatement(at) || ts.isForOfStatement(at)) : (ts.isFunctionLike(at) || ts.isSourceFile(at))) return at;
  }
  return null;
}

/** Fix round 25 of PR #198 (review 23 NIT-4): the file's definitions of the
 * name `id` reads that are in scope where it is read, the nearest only. The
 * merge's two CONTROL_AT entries came from names shared across functions:
 * StopLine's `track` param took SceneStopLines' `track` local, and
 * projectStore's `const opened = get()` took another function's
 * `const opened = useProjectStore.getState()` (the whole store). A
 * parameter hides the file's same-named locals; a name with no definition
 * in scope is an import when it is one, else every definition, as before. */
function visibleLocals(id: ts.Identifier, scope: Scope): ts.Node[] | undefined {
  const all = scope.locals.get(id.text);
  if (!all) return undefined;
  const depthOf = new Map<ts.Node, number>();
  let param = Infinity;
  let depth = 0;
  for (let up: ts.Node | undefined = id.parent; up; up = up.parent, depth += 1) {
    depthOf.set(up, depth);
    if (param === Infinity && ts.isFunctionLike(up) && up.parameters.some((parameter) => bindingNames(parameter.name).includes(id.text))) param = depth;
  }
  let nearest = Infinity;
  const kept: ts.Node[] = [];
  const assigned: ts.Node[] = [];
  for (const definition of all) {
    const container = declaredIn(definition);
    if (container === null) { assigned.push(definition); continue; }
    const at = depthOf.get(container);
    if (at === undefined || at > nearest) continue;
    if (at < nearest) { nearest = at; kept.length = 0; }
    kept.push(definition);
  }
  if (param !== Infinity && param <= nearest) return assigned;
  if (kept.length > 0) return [...kept, ...assigned];
  return scope.imports.has(id.text) ? undefined : all;
}

/** The definitions a name has where it is read (visibleLocals) for a
 * reference, the file's for anything else; none when a parameter hides
 * them, so a name a parent hands down is a parameter's (boundByParam). */
function localsAt(id: ts.Node, scope: Scope): ts.Node[] | undefined {
  if (!ts.isIdentifier(id) || !isReference(id)) return ts.isIdentifier(id) ? scope.locals.get(id.text) : undefined;
  const visible = visibleLocals(id, scope);
  return visible && visible.length > 0 ? visible : undefined;
}

const bindingNames = (name: ts.BindingName): string[] => ts.isIdentifier(name) ? [name.text]
  : name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));

/** A value that is the canvas lock: a call of its hook, a local read from
 * one, or a prop named for it. */
function isLockValue(expression: ts.Node, scope: Scope, seen: Set<string> = new Set()): boolean {
  if (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)) return isLockValue(expression.expression, scope, seen);
  if (ts.isCallExpression(expression)) return ts.isIdentifier(expression.expression) && LOCK_FACTORIES.has(expression.expression.text);
  if (ts.isPropertyAccessExpression(expression)) return LOCK_PROPS.test(expression.name.text) && !LOCK_MEMBERS.has(expression.name.text)
    && ts.isIdentifier(expression.expression) && (isLockValue(expression.expression, scope, seen)
      || (/^props$/.test(expression.expression.text) && boundByParam(expression.expression)));
  if (!ts.isIdentifier(expression)) return false;
  const definitions = localsAt(expression, scope);
  if (!definitions) return LOCK_PROPS.test(expression.text) && !scope.imports.has(expression.text) && boundByParam(expression);
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
    return DISABLED_PROPS.test(name) && ts.isIdentifier(expression.expression) && /^props$/.test(expression.expression.text)
      && boundByParam(expression.expression) ? LOCKED : 0;
  }
  if (!ts.isIdentifier(expression)) return 0;
  const key = expression.text;
  const definitions = localsAt(expression, scope);
  if (!definitions) return DISABLED_PROPS.test(key) && !scope.imports.has(key) && boundByParam(expression) ? LOCKED : 0;
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
  // PR #198's forms, since the merge: `lockedAction(lock, …)` (lib/canvasLock,
  // lock.act with the offline verb), and a local helper whose body is one
  // (`const runLocked = (…) => lock.act(own, { run })`).
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const callee = expression.expression.text;
    // Fix round 25 (review 23 NIT-4): the canvasLock export by its own name
    // (no alias), whose body the "lockedAction keeps act's lock" test reads.
    const imported = scope.imports.get(callee);
    if (callee === 'lockedAction' && imported?.imported === 'lockedAction' && /\/canvasLock$/.test(imported.specifier)
      && expression.arguments.length > 0 && isLockValue(expression.arguments[0], scope)) return true;
    if (seen.has(callee)) return false;
    seen.add(callee);
    const helpers = localsAt(expression.expression, scope) ?? [];
    return helpers.length > 0 && helpers.every((helper) => (ts.isArrowFunction(helper) || ts.isFunctionExpression(helper))
      && ts.isExpression(helper.body) && isActSpread(helper.body, scope, seen));
  }
  // An `act` prop a parent hands down, spread on the control. Fix round 25
  // (review 23 NIT-4): trusted only when the component is a file-local,
  // unexported function, every place in the file names it is a JSX use, and
  // each of those passes `act` as a lock spread (`act={lock.act()}`).
  if (ts.isIdentifier(expression) && expression.text === 'act' && boundByParam(expression)) return actHandedDown(expression, scope, seen);
  if (!ts.isIdentifier(expression) || seen.has(expression.text)) return false;
  seen.add(expression.text);
  const definitions = localsAt(expression, scope) ?? [];
  return definitions.length > 0 && definitions.every((definition) => !ts.isBindingElement(definition) && isActSpread(definition, scope, seen));
}

/** Whether the `act` param `id` reads is a lock spread at every call site:
 * see isActSpread. */
function actHandedDown(id: ts.Identifier, scope: Scope, seen: Set<string>): boolean {
  let component: ts.Node | null = null;
  for (let up: ts.Node | undefined = id.parent; up; up = up.parent) if (ts.isFunctionLike(up)) component = up;
  if (!component || !ts.isFunctionDeclaration(component) || !component.name) return false;
  if (component.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) || scope.defaultExport === component) return false;
  const name = component.name.text;
  if (seen.has(`<${name}>`)) return false;
  seen.add(`<${name}>`);
  const uses: ts.JsxAttributes[] = [];
  let stray = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name && node !== component!.name) {
      const parent = node.parent;
      if (parent && (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent)) && parent.tagName === node) uses.push(parent.attributes);
      else if (!(parent && ts.isJsxClosingElement(parent))) stray = true;
    }
    if (ts.isExportSpecifier(node) && (node.propertyName ?? node.name).getText(scope.root) === name) stray = true;
    ts.forEachChild(node, visit);
  };
  visit(scope.root);
  return !stray && uses.length > 0 && uses.every((attributes) => attributes.properties.some((attribute) =>
    ts.isJsxAttribute(attribute) && attribute.name.getText(scope.root) === 'act' && !!attribute.initializer
    && ts.isJsxExpression(attribute.initializer) && !!attribute.initializer.expression
    && isActSpread(attribute.initializer.expression, scope, seen)));
}

/** Which locked states a spread covers: `{...lock.act(…)}` (or a local made
 * of it), an object whose `disabled`/`aria-disabled`/`readOnly` is truthy
 * when locked (`const shared = { disabled: readOnly, onChange }`), and on a
 * component the lock itself (`{...lock}`). `{...lock.mark}` only marks
 * (data-*): none. */
function spreadCoverage(expression: ts.Node, scope: Scope, component: boolean, seen: Set<string> = new Set(),
  readOnlyApplies = component): number {
  if (ts.isParenthesizedExpression(expression)) return spreadCoverage(expression.expression, scope, component, seen, readOnlyApplies);
  if (isActSpread(expression, scope)) return LOCKED;
  if (component && isLockValue(expression, scope)) return LOCKED;
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.reduce((mask, property) => {
      if (ts.isSpreadAssignment(property)) return mask | spreadCoverage(property.expression, scope, component, seen, readOnlyApplies);
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return mask;
      const name = property.name.getText(scope.root).replace(/^['"]|['"]$/g, '');
      // aria-disabled blocks no click: ariaCoverage reads it (review 4 LOW-4).
      // readOnly only on a text-like field (review 5 LOW-3: READONLY_TYPES
      // applied to a spread too: `{...{ readOnly }}` on a checkbox).
      if (name !== 'disabled' && !(name === 'readOnly' && readOnlyApplies)) return mask;
      return mask | lockCoverage(ts.isPropertyAssignment(property) ? property.initializer : property.name, scope);
    }, 0);
  }
  if (!ts.isIdentifier(expression)) return 0;
  const key = expression.text;
  if (seen.has(key)) return 0;
  seen.add(key);
  return (localsAt(expression, scope) ?? []).reduce((mask, definition) =>
    mask | (ts.isBindingElement(definition) ? 0 : spreadCoverage(definition, scope, component, seen, readOnlyApplies)), 0);
}

/** Which locked states an attribute puts the control in: the lock's spread,
 * `disabled` or `aria-disabled` (and a text field's `readOnly`) truthy when
 * locked, or, on a component, the lock handed down (`lock={lock}`,
 * `locked={lock.locked}`, `readOnly`, `disabled`, a `disable…` prop). An
 * attribute that only mentions the lock (`className`, `title`, `aria-label`,
 * `data-*`, `key`, `disabled={!lock.locked}`) puts it in none (review 3
 * LOW-6). */
/** Input types readOnly applies to (HTML: text-like and date/number
 * fields); a checkbox, radio, range, colour or file input ignores it (review
 * 4 LOW-4). No `type` is text. */
const READONLY_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'month', 'week', 'time', 'datetime-local']);
function inputType(attributes: ts.NodeArray<ts.JsxAttributeLike> | undefined, scope: Scope): string | null {
  const type = attributes?.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(scope.root) === 'type') as ts.JsxAttribute | undefined;
  if (!type) return 'text';
  const value = type.initializer;
  if (value && ts.isStringLiteral(value)) return value.text;
  if (value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) return value.expression.text;
  return null; // dynamic: not known to be text-like
}

/** Which locked states an attribute puts the control in (fix round 4 of PR
 * #200, review 4 LOW-4, tightened): `disabled` only where it disables (a
 * native control, a fieldset, or a component that takes it), `readOnly` only
 * on a textarea or a text-like input, a component's `lock`, `locked` or
 * `disabled` (never another `disable…` name: `disableRipple`).
 * `aria-disabled` is no lock on its own: ariaCoverage. */
/* Fix round 5 (review 5 LOW-3): a component's `disabled`, `readOnly`,
 * `locked` or `lock` counts only when the component is found (in the file,
 * or a relative import) and reads that prop (or forwards its props onto an
 * element): `<Fancy disabled={lock.locked}>` where Fancy ignores `disabled`
 * locks nothing. `reads` answers for the component at hand. */
type Reads = (prop: string) => boolean;
const LOCK_SPREAD_PROPS = ['lock', 'locked', 'following', 'offline', 'act', 'mark', 'title'];
function lockAttribute(attribute: ts.JsxAttributeLike, scope: Scope, tag = '', attributes?: ts.NodeArray<ts.JsxAttributeLike>,
  reads: Reads = () => false): number {
  const component = /^[A-Z]/.test(tag);
  const disables = component || CONTROL_TAGS.has(tag) || tag === 'fieldset';
  const readOnlyApplies = (component && reads('readOnly')) || tag === 'textarea'
    || (tag === 'input' && READONLY_TYPES.has(inputType(attributes, scope) ?? ''));
  if (ts.isJsxSpreadAttribute(attribute)) {
    if (!disables) return 0;
    if (!component) return spreadCoverage(attribute.expression, scope, false, new Set(), readOnlyApplies);
    // A component's spread: the lock itself (`{...lock}`) when it reads one
    // of the lock's members, `{...lock.act()}` and objects when it reads
    // `disabled` (or `readOnly`).
    if (isLockValue(attribute.expression, scope)) return LOCK_SPREAD_PROPS.some(reads) ? LOCKED : 0;
    return reads('disabled') || readOnlyApplies ? spreadCoverage(attribute.expression, scope, false, new Set(), readOnlyApplies) : 0;
  }
  const name = attribute.name.getText(scope.root);
  if (isHandlerName(name)) return 0;
  const value = attribute.initializer;
  if (!value || !ts.isJsxExpression(value) || !value.expression) return 0;
  if (component && !reads(name)) return 0;
  if (name === 'disabled') return disables ? lockCoverage(value.expression, scope) : 0;
  if (name === 'readOnly' && readOnlyApplies) return lockCoverage(value.expression, scope);
  if (component && /^(lock|canvasLock)$/.test(name)) return isLockValue(value.expression, scope) ? LOCKED : 0;
  // PR #198's notices hand the lock's props down as `act` (SceneClashNotice,
  // SceneStopLines): the child spreads them on its buttons.
  if (component && name === 'act') return isActSpread(value.expression, scope) ? LOCKED : 0;
  if (component && name === 'locked') return lockCoverage(value.expression, scope);
  return 0;
}

/** The definition of the component `tag` names (a local, or the export of a
 * relative import, through re-exports), or null when it can't be found. */
function componentDefinition(tag: string, scope: Scope, resolve: Resolve | undefined): { node: ts.Node; scope: Scope } | null {
  if (tag.includes('.')) return null;
  const local = scope.locals.get(tag);
  if (local?.length) return { node: local[local.length - 1], scope };
  const imported = scope.imports.get(tag);
  if (!imported || !resolve || !imported.specifier.startsWith('.')) return null;
  const module = resolve(imported.specifier, scope.file);
  return module ? exportedTarget(scopeOf(module.source, module.file), imported.imported, resolve) : null;
}

/** Which props a component reads (fix rounds 5 and 6 of PR #200): a name
 * its definition reads (`disabled={disabled}`, `props.disabled`; a
 * destructured name it never uses reads nothing), or every prop it forwards
 * onto an element that takes it (`<button {...props}>`; `{...rest}` forwards
 * all but the names destructured beside it; a `<div>` or `<span>` takes no
 * `disabled`). A wrapper (`memo(Inner)`, `forwardRef(Inner)`) is followed one
 * name in. */
function componentReads(tag: string, scope: Scope, resolve: Resolve | undefined): Reads {
  const found = componentDefinition(tag, scope, resolve);
  if (!found) return () => false;
  const spelled = new Set<string>();
  let forwardsAll = false;
  const forwardedBut: Array<Set<string>> = [];
  const visit = (node: ts.Node, at: Scope, hops: number) => {
    const fn = ts.isFunctionLike(node) ? node : null;
    const param = fn?.parameters[0]?.name;
    // The spreads that forward props: the props parameter, or its rest.
    const whole = param && ts.isIdentifier(param) ? param.text : null;
    let rest: string | null = null;
    const beside = new Set<string>();
    if (param && ts.isObjectBindingPattern(param)) {
      for (const element of param.elements) {
        if (element.dotDotDotToken && ts.isIdentifier(element.name)) rest = element.name.text;
        else beside.add((element.propertyName ?? element.name).getText(at.root));
      }
    }
    const walk = (current: ts.Node) => {
      // A type names no value (`(p: { disabled?: boolean })` reads nothing).
      if (ts.isTypeNode(current)) return;
      if (ts.isIdentifier(current) && current.parent && (isReference(current)
        || (ts.isPropertyAccessExpression(current.parent) && current.parent.name === current))) spelled.add(current.text);
      if (ts.isJsxSpreadAttribute(current) && ts.isIdentifier(current.expression)) {
        const element = current.parent?.parent;
        const target = element && (ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element)) ? element.tagName.getText(at.root) : '';
        const takes = CONTROL_TAGS.has(target) || target === 'fieldset' || /^[A-Z]/.test(target);
        if (takes && current.expression.text === whole) forwardsAll = true;
        if (takes && current.expression.text === rest) forwardedBut.push(beside);
      }
      ts.forEachChild(current, walk);
    };
    walk(node);
    if (hops > 0 && ts.isCallExpression(node)) {
      for (const argument of node.arguments) {
        if (ts.isIdentifier(argument)) {
          const inner = componentDefinition(argument.text, at, resolve);
          if (inner) visit(inner.node, inner.scope, hops - 1);
        } else if (ts.isFunctionLike(argument)) visit(argument, at, hops - 1);
      }
    }
  };
  visit(found.node, found.scope, 1);
  return (prop) => forwardsAll || spelled.has(prop) || forwardedBut.some((but) => !but.has(prop));
}

/** The states `aria-disabled` (an attribute, or a key of a spread object)
 * marks: it blocks no click, so it counts only with a refuse in the handler
 * (refuseCoverage), as Toolbar's Run pairs it with refuseEditWhileFollowing. */
function ariaCoverage(attributes: ts.NodeArray<ts.JsxAttributeLike>, scope: Scope): number {
  const fromObject = (expression: ts.Node, seen: Set<string>): number => {
    if (ts.isParenthesizedExpression(expression)) return fromObject(expression.expression, seen);
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.reduce((mask, property) => {
        if (ts.isSpreadAssignment(property)) return mask | fromObject(property.expression, seen);
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return mask;
        if (property.name.getText(scope.root).replace(/^['"]|['"]$/g, '') !== 'aria-disabled') return mask;
        return mask | lockCoverage(ts.isPropertyAssignment(property) ? property.initializer : property.name, scope);
      }, 0);
    }
    if (!ts.isIdentifier(expression) || seen.has(expression.text)) return 0;
    seen.add(expression.text);
    return (localsAt(expression, scope) ?? []).reduce((mask, definition) =>
      mask | (ts.isBindingElement(definition) ? 0 : fromObject(definition, seen)), 0);
  };
  return attributes.reduce((mask, attribute) => {
    if (ts.isJsxSpreadAttribute(attribute)) return mask | fromObject(attribute.expression, new Set());
    if (attribute.name.getText(scope.root) !== 'aria-disabled') return mask;
    const value = attribute.initializer;
    return value && ts.isJsxExpression(value) && value.expression ? mask | lockCoverage(value.expression, scope) : mask;
  }, 0);
}

/** Fix round 6 of PR #200 (CI timeout on 1841a21a, review 6 MEDIUM-1): the
 * reach of a node from a fresh start is computed once per node and kept, so
 * the guard check below asks it as often as it likes. `reachOf` with a shared
 * `seen` (inside one traversal) is never cached: what it returns depends on
 * what that traversal saw first. */
const reachMemo = new WeakMap<ts.Node, Map<string, Set<string>>>();
function reachCached(node: ts.Node, scope: Scope, resolve: Resolve | undefined, depth: number, ownNames: boolean): Set<string> {
  let byKey = reachMemo.get(node);
  if (!byKey) { byKey = new Map(); reachMemo.set(node, byKey); }
  const key = `${depth}:${ownNames}:${resolve ? resolveIds.get(resolve) ?? resolveIds.set(resolve, resolveIds.size + 1).get(resolve) : 0}`;
  let reach = byKey.get(key);
  if (!reach) { reach = reachOf(node, scope, resolve, new Set(), depth, ownNames); byKey.set(key, reach); }
  return reach;
}
const resolveIds = new Map<Resolve, number>();
const ownMemo = new WeakMap<Scope, boolean>();
const ownOf = (scope: Scope) => {
  let own = ownMemo.get(scope);
  if (own === undefined) { own = reachesGraphStore(scope.root.text, scope.file); ownMemo.set(scope, own); }
  return own;
};
const reachesGated = (reach: Set<string>) => { for (const name of reach) if (GATED.has(name)) return true; return false; };

/** The states a handler's own refusal covers (fix rounds 5 and 6 of PR
 * #200, reviews 5 and 6 LOW-3). Each gated call the handler makes (a gated
 * name, or a call of a local or imported function that reaches one) must be
 * guarded where it sits:
 * - an earlier statement of a block around it is `if (G) return` (or an if
 *   block ending in return or throw);
 * - it sits in the then-branch of `if (!G)` (or `ok && !G`), the else-branch
 *   of `if (G)`, the false side of `G ? … : call()`, the right of `G ||` or of
 *   `!G &&`;
 * - or it calls a function of the file (or an import) whose own gated calls
 *   are all guarded.
 * G is a refusal (`refuseCanvasEdit()`, the following and offline ones),
 * `canvasLockNow().locked` (`.offline` and `.following` cover that state
 * only), a local made of one (`const r = refuse…()`, `const { locked } =
 * canvasLockNow()`), a one-line helper returning one, `G || x` (either
 * returns), or `G1 && G2`; `G && x` guards nothing (it returns only when x).
 * A guard in a `catch`, after the call, inside a loop that `continue`s, or
 * whose result is dropped guards nothing. The handler's coverage is what all
 * its gated calls share. */
// PR #199: refuseTabOnlyEdit refuses following and offline as refuseCanvasEdit does (lib/canvasLock).
const REFUSERS: Record<string, number> = { refuseCanvasEdit: LOCKED, refuseTabOnlyEdit: LOCKED, refuseEditWhileFollowing: FOLLOWING, refuseEditWhileOffline: OFFLINE };
function guardMask(condition: ts.Expression, scope: Scope, seen: Set<string> = new Set()): number {
  const again = (node: ts.Expression) => guardMask(node, scope, seen);
  if (ts.isParenthesizedExpression(condition) || ts.isAwaitExpression(condition)) return again(condition.expression);
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken
    && ts.isPrefixUnaryExpression(condition.operand) && condition.operand.operator === ts.SyntaxKind.ExclamationToken) return again(condition.operand.operand);
  if (ts.isCallExpression(condition) && ts.isIdentifier(condition.expression)) {
    const name = condition.expression.text;
    if (REFUSERS[name]) return REFUSERS[name];
    // A one-line helper of the file: `const guard = () => refuseCanvasEdit()`.
    if (seen.has(`call:${name}`)) return 0;
    seen.add(`call:${name}`);
    const helpers = localsAt(condition.expression, scope) ?? [];
    const masks = helpers.map((helper) => {
      if (!(ts.isArrowFunction(helper) || ts.isFunctionExpression(helper) || ts.isFunctionDeclaration(helper)) || !helper.body) return 0;
      if (!ts.isBlock(helper.body)) return again(helper.body);
      // Review 7 N-1: a helper of several statements returns the refusal when
      // every return that can be truthy does so only when G holds
      // (`{ if (refuse()) return true; return false; }`).
      return truthyReturnsOnlyWhen(helper.body, scope, seen);
    });
    return masks.length ? masks.reduce((all, mask) => all & mask, LOCKED) : 0;
  }
  if (ts.isPropertyAccessExpression(condition)) {
    const state = LOCK_STATES[condition.name.text];
    return state && isLockValue(condition.expression, scope) ? state : 0;
  }
  if (ts.isIdentifier(condition)) {
    // A local made of a guard: `const r = refuse…()`, `const { locked } = canvasLockNow()`.
    if (seen.has(condition.text)) return 0;
    seen.add(condition.text);
    const definitions = localsAt(condition, scope) ?? [];
    const masks = definitions.map((definition) => {
      if (ts.isBindingElement(definition)) {
        const declared = definition.parent?.parent;
        const member = (definition.propertyName ?? definition.name).getText(scope.root);
        return LOCK_STATES[member] && declared && ts.isVariableDeclaration(declared) && declared.initializer
          && isLockValue(declared.initializer, scope) ? LOCK_STATES[member] : 0;
      }
      // `const { locked } = canvasLockNow()` also lists the initializer under
      // `locked`: the element above reads it.
      if (definition.parent && ts.isVariableDeclaration(definition.parent) && !ts.isIdentifier(definition.parent.name)) return null;
      return ts.isFunctionLike(definition) ? 0 : again(definition as ts.Expression);
    }).filter((mask): mask is number => mask !== null);
    return masks.length ? masks.reduce((all, mask) => all & mask, LOCKED) : 0;
  }
  if (ts.isBinaryExpression(condition)) {
    const op = condition.operatorToken.kind;
    const [left, right] = [again(condition.left), again(condition.right)];
    if (op === ts.SyntaxKind.BarBarToken) return left | right;
    // `G1 && G2` refuses only when both do; `G && x` returns only when x (review 6).
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return left & right;
  }
  return 0;
}
const falsy = (expression: ts.Expression | undefined): boolean => !expression
  || expression.kind === ts.SyntaxKind.FalseKeyword || expression.kind === ts.SyntaxKind.NullKeyword
  || (ts.isIdentifier(expression) && expression.text === 'undefined');
/** What every truthy return of a helper's block needs to hold: each `return
 * true` (or any value) is in the then-branch of `if (G)`, the else of `if
 * (!G)`, or after `if (!G) return false`, or returns a guard itself. Returns
 * of falsy values, and falling off the end, give nothing. */
function truthyReturnsOnlyWhen(body: ts.Block, scope: Scope, seen: Set<string>): number {
  const returns: ts.ReturnStatement[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, walk);
  };
  body.statements.forEach(walk);
  const truthy = returns.filter((statement) => !falsy(statement.expression));
  if (!truthy.length) return 0;
  return truthy.reduce((all, statement) => {
    const value = statement.expression!;
    const itself = value.kind === ts.SyntaxKind.TrueKeyword ? 0 : guardMask(value, scope, seen);
    let when = 0;
    for (let cur: ts.Node = statement; cur !== body && cur.parent; cur = cur.parent) {
      const up = cur.parent;
      if (ts.isIfStatement(up)) {
        if (cur === up.thenStatement) when |= guardMask(up.expression, scope, seen);
        else if (cur === up.elseStatement) when |= negatedGuard(up.expression, scope);
      } else if (ts.isBlock(up) && ts.isStatement(cur as ts.Statement)) {
        const list = up.statements as ts.NodeArray<ts.Statement>;
        for (const earlier of list.slice(0, list.indexOf(cur as ts.Statement))) {
          if (ts.isIfStatement(earlier) && exits(earlier.thenStatement)) when |= negatedGuard(earlier.expression, scope);
        }
      }
    }
    return all & (itself | when);
  }, LOCKED);
}
/** A `switch (G)` whose `case true:` exits (review 7 N-1). */
const switchExitsOnTrue = (statement: ts.SwitchStatement): boolean => statement.caseBlock.clauses.some((clause) =>
  ts.isCaseClause(clause) && clause.expression.kind === ts.SyntaxKind.TrueKeyword
  && clause.statements.length > 0 && exits(clause.statements[clause.statements.length - 1]));
/** The refusals a condition's && chain negates (`!refuseCanvasEdit()`, `ok &&
 * !refuse…()`): true only when nothing refused. */
function negatedGuard(condition: ts.Expression, scope: Scope): number {
  if (ts.isParenthesizedExpression(condition)) return negatedGuard(condition.expression, scope);
  if (ts.isPrefixUnaryExpression(condition) && condition.operator === ts.SyntaxKind.ExclamationToken) return guardMask(condition.operand, scope);
  if (ts.isBinaryExpression(condition) && condition.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return negatedGuard(condition.left, scope) | negatedGuard(condition.right, scope);
  }
  return 0;
}
const exits = (statement: ts.Statement): boolean => ts.isReturnStatement(statement) || ts.isThrowStatement(statement)
  || (ts.isBlock(statement) && statement.statements.length > 0 && exits(statement.statements[statement.statements.length - 1]));

/** The guards around one spot, up to `root`. */
function guardsAround(site: ts.Node, root: ts.Node, scope: Scope): number {
  let mask = 0;
  for (let cur: ts.Node = site; cur !== root && cur.parent; cur = cur.parent) {
    const up = cur.parent;
    if ((ts.isBlock(up) || ts.isSourceFile(up) || ts.isCaseClause(up) || ts.isDefaultClause(up)) && ts.isStatement(cur as ts.Statement)) {
      const list = up.statements as ts.NodeArray<ts.Statement>;
      for (const earlier of list.slice(0, list.indexOf(cur as ts.Statement))) {
        if (ts.isIfStatement(earlier) && exits(earlier.thenStatement)) mask |= guardMask(earlier.expression, scope);
        else if (ts.isSwitchStatement(earlier) && switchExitsOnTrue(earlier)) mask |= guardMask(earlier.expression, scope);
      }
    } else if (ts.isIfStatement(up)) {
      if (cur === up.thenStatement) mask |= negatedGuard(up.expression, scope);
      else if (cur === up.elseStatement) mask |= guardMask(up.expression, scope);
    } else if (ts.isConditionalExpression(up)) {
      if (cur === up.whenFalse) mask |= guardMask(up.condition, scope);
      else if (cur === up.whenTrue) mask |= negatedGuard(up.condition, scope);
    } else if (ts.isBinaryExpression(up) && cur === up.right) {
      if (up.operatorToken.kind === ts.SyntaxKind.BarBarToken) mask |= guardMask(up.left, scope);
      else if (up.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) mask |= negatedGuard(up.left, scope);
    }
    if (mask === LOCKED) break;
  }
  return mask;
}

const coverageMemo = new WeakMap<ts.Node, Map<number, number>>();
const coverageBusy = new WeakSet<ts.Node>();
function refuseCoverage(node: ts.Node, scope: Scope, resolve: Resolve | undefined, depth = 0): number {
  const rid = resolve ? resolveIds.get(resolve) ?? resolveIds.set(resolve, resolveIds.size + 1).get(resolve)! : 0;
  let byResolve = coverageMemo.get(node);
  if (!byResolve) { byResolve = new Map(); coverageMemo.set(node, byResolve); }
  const known = byResolve.get(rid);
  if (known !== undefined) return known;
  // A function that calls itself: its own calls add nothing.
  if (coverageBusy.has(node)) return LOCKED;
  coverageBusy.add(node);
  const ownNames = ownOf(scope);
  let mask = LOCKED;
  const visit = (current: ts.Node) => {
    if (mask === 0) return;
    if (current !== node && (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current) || ts.isJsxFragment(current))) return;
    let inner = -1; // -1: not a gated call; else the coverage of what it calls
    if (ts.isIdentifier(current)) {
      // Every same-named definition, not only the one in scope (localsAt):
      // more definitions only lower the coverage (`all & …`), so this stays
      // the stricter reading (and scoping here made G's walk far slower).
      const local = scope.locals.get(current.text);
      const imported = scope.imports.get(current.text);
      if (local && isReference(current)) {
        if (local.some((definition) => reachesGated(reachCached(definition, scope, resolve, depth, ownNames)))) {
          inner = local.reduce((all, definition) => all & refuseCoverage(definition, scope, resolve, depth), LOCKED);
        }
      } else if (imported && isReference(current)) {
        const module = resolve && imported.specifier.startsWith('.') ? resolve(imported.specifier, scope.file) : null;
        const target = module && depth < IMPORT_DEPTH ? exportedTarget(scopeOf(module.source, module.file), imported.imported, resolve!) : null;
        if (target && reachesGated(reachCached(target.node, target.scope, resolve, depth + 1, ownOf(target.scope)))) {
          inner = refuseCoverage(target.node, target.scope, resolve, depth + 1);
        } else if (GATED.has(current.text) && (ownNames || (module && reachesGraphStore(module.source, module.file)))) inner = 0;
      } else if (ownNames && GATED.has(current.text)) inner = 0;
    } else if (ownNames && ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)
      && GATED.has(current.argumentExpression.text)) inner = 0;
    if (inner >= 0) {
      mask &= inner === LOCKED ? LOCKED : inner | guardsAround(current, node, scope);
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  coverageBusy.delete(node);
  byResolve.set(rid, mask);
  return mask;
}

/** Pointer handlers a disabled control still gets (review 5 LOW-3, live:
 * Chrome dispatches pointerdown and pointerup to a disabled <button>; only
 * mousedown and click are held back). On a native control each needs its
 * own refusal. */
const POINTER_HANDLER = /^onPointer[A-Z]/;

/** Opening-element text of each finding, for CONTROL_AT (an allowlist entry
 * for one control, never every control of its tag; review 4 LOW-4). */
const findingElement = new Map<string, string>();

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
      const local = localsAt(current, scope);
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
      // Each handler that reaches a gated action, with its own refusal
      // (review 5 LOW-3: per handler; a refusal in onKeyDown covers no
      // onClick) and whether it is a pointer handler.
      const gatedHandlers: Array<{ refuse: number; pointer: boolean }> = [];
      for (const handler of handlers) {
        const reach = reachCached(handler, scope, resolve, 0, ownNames);
        for (const name of reach) reached.add(name);
        if (![...reach].some((name) => GATED.has(name))) continue;
        const name = ts.isJsxAttribute(handler) ? handler.name.getText(root) : '';
        gatedHandlers.push({ refuse: refuseCoverage(handler, scope, resolve), pointer: POINTER_HANDLER.test(name) });
      }
      const hits = [...reached].filter((name) => GATED.has(name));
      if (hits.length > 0) {
        const control = CONTROL_TAGS.has(tag);
        const reads = /^[A-Z]/.test(tag) ? componentReads(tag, scope, resolve) : undefined;
        // Its own attributes and a disabled <fieldset> around it, together
        // (only a fieldset disables what it holds; review 3 LOW-6: a <div
        // title={lock.title()}> around a button disables nothing).
        let covered = attributes.reduce((mask, attribute) => mask | lockAttribute(attribute, scope, tag, attributes, reads), 0);
        // A disabled fieldset disables the form controls it holds, except
        // those in its first <legend> (HTML), never a <div onClick> or an <a>.
        // The legend is found through fragments and expressions (review 5
        // LOW-3: `{open && <legend>…}`, `<><legend>…</>`): any legend with no
        // other element between it and the fieldset counts as the first.
        let inLegend = false;
        for (let up: ts.Node | undefined = node.parent; up && covered !== LOCKED && control; up = up.parent) {
          if (!ts.isJsxElement(up) || up.openingElement === node) continue;
          const upTag = up.openingElement.tagName.getText(root);
          if (upTag === 'legend') { inLegend = true; continue; }
          if (upTag !== 'fieldset') { inLegend = false; continue; }
          if (!inLegend) {
            for (const attribute of up.openingElement.attributes.properties) {
              if (ts.isJsxAttribute(attribute) && attribute.name.getText(root) === 'disabled') covered |= lockAttribute(attribute, scope, 'fieldset');
            }
          }
          inLegend = false;
        }
        const aria = ariaCoverage(attributes, scope);
        // Each gated handler, on its own: the control's lock, aria-disabled
        // with this handler's refusal (review 4 LOW-4), or, on a component or
        // a non-control, the handler's refusal alone. A pointer handler on a
        // native control fires while disabled: only its own refusal.
        const own = gatedHandlers.every(({ refuse, pointer }) => (control && pointer ? refuse
          : covered | (aria & refuse) | (control ? 0 : refuse)) === LOCKED);
        if (!own) {
          const { line } = root.getLineAndCharacterOfPosition(node.getStart(root));
          // A component: the file it comes from, so a locked component is
          // known by its file, never its name (review 3 LOW-6).
          const head = tag.split('.')[0];
          const from = !/^[A-Z]/.test(tag) ? null : scope.locals.has(head) ? file
            : scope.imports.get(head) && resolve ? resolve(scope.imports.get(head)!.specifier, file)?.file ?? null : null;
          const finding = `${file}:${line + 1} <${tag}> ${hits.sort().join(', ')}${from ? ` [${from}]` : ''}`;
          findingElement.set(finding, node.getText(root).replace(/\s+/g, ' '));
          found.push(finding);
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
  'components/panels/ChatPanel.tsx: clearBackendNodes': "the chat's /clear (lib/chatCanvasClear, one level in): the chat itself stays usable while following or offline, and /clear is refused whole with refuseCanvasEdit before it clears (agentPresenceFollowups.surfaces)",
  'components/panels/AssetsPanel.tsx: undo': "`deleting.undo()` is the asset library's own undo of a deleted style (useAssetDelete), not the canvas's",
  // Fix round 3 of PR #200 (review 3 LOW-6): the forms G reads now (a
  // spread's handlers, `disabled` that must be truthy when locked) find these.
  'components/Canvas.tsx <ReactFlow>': "React Flow's change, connect and paste handlers: the store's edit gate (EDIT_GATES) refuses each while following or offline, and the canvas is read-only (data-read-only, nodesDraggable/nodesConnectable off); round20/round23 tests",
  'components/cinema-studio/CinemaShotPanel.tsx: addLocalCinemaMotionNode': "Send to motion: disabled while locked (`… || readOnly` under the not-ready branch; ready, it only views the node it made); agentPresenceFollowups.r1 renders it locked offline",
  'components/create-studio/CreateView.tsx <ResultsGallery>': "its Delete is ResultCard's button, which spreads lock.act() (ResultCard.tsx)",
};

/** One control each, found by a snippet of its own opening tag (fix round 4
 * of PR #200, review 4 LOW-4: the palette's entries were tag-wide, so any new
 * palette button reaching a gated action passed unseen). */
const CONTROL_AT: Array<{ file: string; tag: string; at: string; reason: string }> = [
  { file: 'components/CommandPalette.tsx', tag: 'input', at: 'className="command-palette__input"',
    reason: "the palette's search field: Enter runs the chosen command through run(), which refuses an acting command with refuseCanvasEdit (round23Surfaces' CommandPalette)" },
  { file: 'components/CommandPalette.tsx', tag: 'button', at: 'onClick={() => run(cmd)} {...(act ?? {})} disabled={disabled}',
    reason: "a palette row: a command that edits (`cmd.acts`) spreads lock.act() and takes its `disabled` (`act ? act.disabled : …`, which G can't follow), and run() refuses it with refuseCanvasEdit; round23Surfaces' CommandPalette renders them locked" },
];

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
  const element = findingElement.get(line) ?? '';
  if (CONTROL_AT.some((entry) => entry.file === file && entry.tag === tag && element.includes(entry.at))) return true;
  const locked = LOCKED_COMPONENTS[tag];
  if (locked && from && [locked.file, ...(locked.via ?? [])].includes(from)
    && READS_LOCK.test(readFileSync(join(SRC, locked.file), 'utf8'))) return true;
  return hits.split(', ').every((hit) => CONTROL_ALLOWLIST[`${file}: ${hit}`]);
};

// Parsing every source file is slow under load: a generous limit (300 s
// since the merge with PR #198: more files, and G alone took 110 s at a load
// average of 50; the full suite at 68 passed 120 s).
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
      // Review 4 LOW-4: aria-disabled counts with the handler's own refusal.
      aria_disabled_refused: 'export const A = () => <div role="button" aria-disabled={lock.locked || undefined} onClick={() => { if (refuseCanvasEdit()) return; run(); }} />;',
      destructured_locked: 'const { locked } = lock;\nexport const A = () => <button disabled={locked} onClick={() => run()}>Run</button>;',
      locked_fieldset: 'export const A = () => <fieldset disabled={busy || lock.locked}><button onClick={() => run()}>Run</button></fieldset>;',
      render_prop_row_locked: 'export const A = () => <List render={() => <button {...lock.act()} onClick={() => run()}>Run</button>} />;',
    };
    const loud = Object.entries(quiet).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`, resolve).length !== 0)
      .map(([form]) => form);
    expect(loud, 'locked or harmless controls G flags').toEqual([]);
  });

  // Fix round 4 of PR #200: review 4's G corpus (r4/fe/ratchet4.probe.test.ts,
  // ratchet4.facts.json "forms"): the forms that don't really disable.
  it('G corpus (review 4, LOW-4): aria-disabled alone, readOnly where it does nothing, a fieldset that disables nothing, trust by name', () => {
    const head = 'const lock = useCanvasLock();\nconst run = useGraphStore((s) => s.executeGraph);\n';
    const forms: Record<string, string> = {
      aria_disabled_native_button: 'export const A = () => <button aria-disabled={lock.locked} onClick={() => run()}>Run</button>;',
      aria_disabled_div_no_refuse: 'export const A = () => <div role="button" aria-disabled={lock.locked || undefined} onClick={() => run()} />;',
      aria_disabled_spread: "export const A = () => <button {...{ 'aria-disabled': lock.locked }} onClick={() => run()}>Run</button>;",
      aria_disabled_following_refuse_only: 'export const A = () => <button aria-disabled={lock.locked} onClick={() => { if (refuseEditWhileFollowing()) return; run(); }}>Run</button>;',
      readonly_checkbox: 'export const A = () => <input type="checkbox" readOnly={lock.locked} onChange={() => run()} />;',
      readonly_range: 'export const A = () => <input type="range" readOnly={lock.locked} onChange={() => run()} />;',
      readonly_color: 'export const A = () => <input type="color" readOnly={lock.locked} onChange={() => run()} />;',
      fieldset_div_onclick: 'export const A = () => <fieldset disabled={lock.locked}><div onClick={() => run()}>Run</div></fieldset>;',
      fieldset_anchor: 'export const A = () => <fieldset disabled={lock.locked}><a href="#" onClick={() => run()}>Run</a></fieldset>;',
      fieldset_legend_button: 'export const A = () => <fieldset disabled={lock.locked}><legend><button onClick={() => run()}>Run</button></legend></fieldset>;',
      div_disabled: 'export const A = () => <div disabled={lock.locked} onClick={() => run()}>Run</div>;',
      global_named_disabled: 'export const A = () => <button disabled={disabled} onClick={() => run()}>Run</button>;',
      any_name_locked: 'export const A = () => <button disabled={props.locked} onClick={() => run()}>Run</button>;',
      global_named_lock: 'export const A = () => <button {...locked.act()} onClick={() => run()}>Run</button>;',
      component_disable_prop_ignored: 'export const A = () => <Fancy disableRipple={lock.locked} onClick={() => run()} />;',
      // Fix round 5 (review 5 LOW-3): a component nobody can find takes no `disabled` on trust.
      component_disabled: 'export const A = () => <Fancy disabled={lock.locked} onClick={() => run()} />;',
    };
    const missed = Object.entries(forms).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`).length !== 1)
      .map(([form]) => form);
    expect(missed, 'forms G lets through').toEqual([]);
    const quiet: Record<string, string> = {
      aria_disabled_refused: 'export const A = () => <button aria-disabled={lock.locked} onClick={() => { if (refuseCanvasEdit()) return; run(); }}>Run</button>;',
      readonly_text: 'export const A = () => <input readOnly={lock.locked} onChange={() => run()} />;',
      readonly_text_typed: 'export const A = () => <input type="search" readOnly={lock.locked} onChange={() => run()} />;',
      readonly_textarea: 'export const A = () => <textarea readOnly={lock.locked} onChange={() => run()} />;',
      fieldset_after_legend: 'export const A = () => <fieldset disabled={lock.locked}><legend>Run</legend><button onClick={() => run()}>Run</button></fieldset>;',
      props_param_locked: 'export const A = (props: { locked: boolean }) => <button disabled={props.locked} onClick={() => run()}>Run</button>;',
      component_disabled_read: 'const Fancy = ({ disabled, onClick }: P) => <button disabled={disabled} onClick={onClick} />;\n'
        + 'export const A = () => <Fancy disabled={lock.locked} onClick={() => run()} />;',
    };
    const loud = Object.entries(quiet).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`).length !== 0)
      .map(([form]) => form);
    expect(loud, 'locked controls G flags').toEqual([]);
  });

  // Fix round 5 of PR #200: review 5's G corpus (r5/fe/ratchet5.probe.test.ts,
  // ratchet5.facts.json): a refusal counts only when it gates its own
  // handler, readOnly only where it applies, a parameter only of the
  // component, the first legend through fragments, a component's prop only
  // when it reads it, and a pointer handler fires on a disabled button.
  it('G corpus (review 5, LOW-3): the 14 missed forms and the 7 caught ones are caught; 7 locked forms stay quiet', () => {
    const head = 'const lock = useCanvasLock();\nconst run = useGraphStore((s) => s.executeGraph);\n';
    const forms: Record<string, string> = {
      aria_refuse_other_handler: 'export const A = () => <button aria-disabled={lock.locked} onClick={() => run()} onKeyDown={() => { if (refuseCanvasEdit()) return; }}>Run</button>;',
      aria_refuse_result_ignored: 'export const A = () => <button aria-disabled={lock.locked} onClick={() => { refuseCanvasEdit(); run(); }}>Run</button>;',
      div_refuse_result_ignored: 'export const A = () => <div role="button" onClick={() => { refuseCanvasEdit(); run(); }}>Run</div>;',
      div_canvasLockNow_offline_only: 'export const A = () => <div role="button" onClick={() => { if (canvasLockNow().offline) return; run(); }}>Run</div>;',
      div_canvasLockNow_unused: 'export const A = () => <div role="button" onClick={() => { const l = canvasLockNow(); run(); }}>Run</div>;',
      aria_canvasLockNow_offline_only: 'export const A = () => <button aria-disabled={lock.locked} onClick={() => { if (canvasLockNow().offline) return; run(); }}>Run</button>;',
      readonly_spread_checkbox: 'export const A = () => <input type="checkbox" {...{ readOnly: lock.locked }} onChange={() => run()} />;',
      readonly_spread_range: 'export const A = () => <input type="range" {...{ readOnly: lock.locked }} onChange={() => run()} />;',
      readonly_spread_div: 'export const A = () => <div {...{ readOnly: lock.locked }} onClick={() => run()} />;',
      map_param_named_disabled: 'export const A = () => <>{[false].map((disabled) => <button disabled={disabled} onClick={() => run()}>Run</button>)}</>;',
      handler_param_named_locked: 'export const A = () => <List render={(locked: boolean) => <button disabled={locked} onClick={() => run()}>Run</button>} />;',
      fieldset_legend_conditional: 'export const A = () => <fieldset disabled={lock.locked}>{true && <legend><button onClick={() => run()}>Run</button></legend>}</fieldset>;',
      fieldset_legend_in_fragment: 'export const A = () => <fieldset disabled={lock.locked}><><legend><button onClick={() => run()}>Run</button></legend></></fieldset>;',
      inverted_disabled: 'export const A = () => <button disabled={lock.locked ? false : true} onClick={() => run()}>Run</button>;',
      disabled_and_false: 'export const A = () => <button disabled={lock.locked && false} onClick={() => run()}>Run</button>;',
      component_disabled_ignored: 'const Fancy = (p: { onClick: () => void }) => <span onClick={p.onClick} />;\nexport const A = () => <Fancy disabled={lock.locked} onClick={() => run()} />;',
      option_disabled: 'export const A = () => <select onChange={() => run()}><option disabled={lock.locked}>x</option></select>;',
      fieldset_outside_component_div: 'export const A = () => <fieldset disabled={lock.locked}><span role="button" onClick={() => run()}>Run</span></fieldset>;',
      readonly_dynamic_type: 'export const A = ({ kind }: { kind: string }) => <input type={kind} readOnly={lock.locked} onChange={() => run()} />;',
      readonly_typed_hidden: 'export const A = () => <input type="hidden" readOnly={lock.locked} onChange={() => run()} />;',
      pointerdown_on_disabled: 'export const A = () => <button disabled={lock.locked} onPointerDown={() => run()}>Run</button>;',
      // Beyond the corpus: pointerup and a pointer handler beside a locked click.
      pointerup_on_act: 'export const A = () => <button {...lock.act()} onClick={() => run()} onPointerUp={() => run()}>Run</button>;',
      refuse_after_the_call: 'export const A = () => <div role="button" onClick={() => { run(); if (refuseCanvasEdit()) return; }}>Run</div>;',
    };
    expect(Object.keys(forms)).toHaveLength(23);
    const missed = Object.entries(forms).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`).length !== 1)
      .map(([form]) => form);
    expect(missed, 'forms G lets through').toEqual([]);
    const quiet: Record<string, string> = {
      refuse_gate: 'export const A = () => <div role="button" onClick={() => { if (refuseCanvasEdit()) return; run(); }}>Run</div>;',
      lockNow_locked: 'export const A = () => <div role="button" onClick={() => { if (canvasLockNow().locked) return; run(); }}>Run</div>;',
      act_spread: 'export const A = () => <button {...lock.act()} onClick={() => run()}>Run</button>;',
      disabled_func_param: 'export function A({ disabled }: { disabled: boolean }) { return <button disabled={disabled} onClick={() => run()}>Run</button>; }',
      readonly_email: 'export const A = () => <input type="email" readOnly={lock.locked} onChange={() => run()} />;',
      act_via_title_var: 'const acts = lock.act({ title: "x" });\nexport const A = () => <input type="color" {...acts} onChange={() => run()} />;',
      fieldset_select: 'export const A = () => <fieldset disabled={lock.locked}><select onChange={() => run()} /></fieldset>;',
      // The real forms: a negated refusal, two refusals, a block ending in return, a pointer handler that refuses.
      negated_refuse: 'export const A = () => <div role="button" onClick={(e) => { if (e.detail <= 1 && !refuseCanvasEdit()) run(); }}>Run</div>;',
      both_refusers: 'export const A = () => <div role="button" onClick={() => { if (refuseEditWhileFollowing() || refuseEditWhileOffline()) return; run(); }}>Run</div>;',
      gesture_end: 'export const A = () => <div onPointerMove={() => { if (canvasLockNow().locked) { end(); return; } run(); }} />;',
      pointer_refused: 'export const A = () => <button disabled={lock.locked} onPointerDown={() => { if (refuseCanvasEdit()) return; run(); }}>Run</button>;',
      helper_refuses: 'function go() { if (refuseCanvasEdit()) return; run(); }\nexport const A = () => <div role="button" onClick={() => go()}>Run</div>;',
    };
    const loud = Object.entries(quiet).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`).length !== 0)
      .map(([form]) => form);
    expect(loud, 'locked controls G flags').toEqual([]);
  });

  // Fix round 6 of PR #200: review 6's G probe (r6/fe/ratchet6.probe.test.ts,
  // ratchet6.facts.json): a guard counts where the gated call sits, and a
  // component's prop where it really lands.
  it('G corpus (review 6, LOW-3): a guard counts where the call sits; 5 missed forms caught, 6 correct guards quiet', () => {
    const head = 'const lock = useCanvasLock();\nconst run = useGraphStore((s) => s.executeGraph);\n';
    const forms: Record<string, string> = {
      // Review 6's five misses.
      not_refuse_empty_block: 'export const A = () => <div role="button" onClick={() => { if (!refuseCanvasEdit()) {} run(); }}>Run</div>;',
      refuse_and_other: 'export const A = () => <div role="button" onClick={() => { if (refuseCanvasEdit() && Math.random() > 2) return; run(); }}>Run</div>;',
      fancy_destructures_unused: 'const Fancy = ({ disabled, ...p }: { disabled?: boolean; onClick?: () => void }) => <span {...p} />;\nexport const A = () => <Fancy disabled={lock.locked} onClick={() => run()} />;',
      fancy_forwards_to_div: 'const Fancy = (p: { disabled?: boolean; onClick?: () => void }) => <div {...p} />;\nexport const A = () => <Fancy disabled={lock.locked} onClick={() => run()} />;',
      refuse_in_catch: 'export const A = () => <div role="button" onClick={() => { try { run(); } catch { if (refuseCanvasEdit()) return; } }}>Run</div>;',
      // The rest of its probe, which G already caught.
      if_block_no_return: 'export const A = () => <div role="button" onClick={() => { if (refuseCanvasEdit()) { console.log(1); } run(); }}>Run</div>;',
      guard_after_deferred: 'export const A = () => <div role="button" onClick={() => { setTimeout(() => run(), 0); if (refuseCanvasEdit()) return; }}>Run</div>;',
      and_short_circuit: 'export const A = () => <div role="button" onClick={() => { refuseCanvasEdit() && run(); }}>Run</div>;',
      refuse_other_handler2: 'export const A = () => <div role="button" onClick={() => { if (refuseCanvasEdit()) return; }} onDoubleClick={() => run()}>Run</div>;',
      lockNow_following_only: 'export const A = () => <div role="button" onClick={() => { if (canvasLockNow().following) return; run(); }}>Run</div>;',
      helper_always_false: 'const guard = () => { refuseCanvasEdit(); return false; };\nexport const A = () => <div role="button" onClick={() => { if (guard()) return; run(); }}>Run</div>;',
      pointer_on_input_range: 'export const A = () => <input type="range" disabled={lock.locked} onPointerUp={() => run()} />;',
      early_return_then_loop: 'export const A = () => <div role="button" onClick={() => { for (const x of [1]) { if (refuseCanvasEdit()) continue; } run(); }}>Run</div>;',
      // Beyond the probe: a rest that keeps `disabled` out, a helper whose call isn't guarded.
      rest_without_disabled: 'const Fancy = ({ disabled, ...p }: { disabled?: boolean; onClick?: () => void }) => <button {...p} />;\nexport const A = () => <Fancy disabled={lock.locked} onClick={() => run()} />;',
      helper_unguarded: 'function go() { run(); }\nexport const A = () => <div role="button" onClick={() => { go(); }}>Run</div>;',
    };
    const missed = Object.entries(forms).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`).length !== 1)
      .map(([form]) => form);
    expect(missed, 'forms G lets through').toEqual([]);
    const quiet: Record<string, string> = {
      // Review 6's six false positives.
      or_short_circuit: 'export const A = () => <div role="button" onClick={() => { refuseCanvasEdit() || run(); }}>Run</div>;',
      local_flag: 'export const A = () => <div role="button" onClick={() => { const r = refuseCanvasEdit(); if (r) return; run(); }}>Run</div>;',
      ternary: 'export const A = () => <div role="button" onClick={() => (refuseCanvasEdit() ? null : run())}>Run</div>;',
      and_not: 'export const A = () => <div role="button" onClick={() => !refuseCanvasEdit() && run()}>Run</div>;',
      helper_guard: 'const guard = () => refuseCanvasEdit();\nexport const A = () => <div role="button" onClick={() => { if (guard()) return; run(); }}>Run</div>;',
      destructured_lockNow: 'export const A = () => <div role="button" onClick={() => { const { locked } = canvasLockNow(); if (locked) return; run(); }}>Run</div>;',
      // And the forms it already passed.
      not_refuse_call: 'export const A = () => <div role="button" onClick={() => { if (!refuseCanvasEdit()) run(); }}>Run</div>;',
      or_in_if: 'export const A = () => <div role="button" onClick={() => { if (refuseCanvasEdit() || Math.random() > 2) return; run(); }}>Run</div>;',
      async_guard: 'export const A = () => <div role="button" onClick={async () => { await Promise.resolve(); if (refuseCanvasEdit()) return; run(); }}>Run</div>;',
      outer_param_in_map: 'export const A = ({ disabled }: { disabled: boolean }) => <>{[1].map((k) => <button key={k} disabled={disabled} onClick={() => run()}>Run</button>)}</>;',
      fancy_forwards_button: 'const Fancy = (p: { disabled?: boolean; onClick?: () => void }) => <button {...p} />;\nexport const A = () => <Fancy disabled={lock.locked} onClick={() => run()} />;',
      fancy_rest_button: 'const Fancy = ({ label, ...p }: { label: string; disabled?: boolean; onClick?: () => void }) => <button {...p}>{label}</button>;\nexport const A = () => <Fancy label="Run" disabled={lock.locked} onClick={() => run()} />;',
      else_branch: 'export const A = () => <div role="button" onClick={() => { if (refuseCanvasEdit()) { return; } else { run(); } }}>Run</div>;',
      try_guarded: 'export const A = () => <div role="button" onClick={() => { if (refuseCanvasEdit()) return; try { run(); } catch { /* shown */ } }}>Run</div>;',
      following_and_offline: 'export const A = () => <div role="button" onClick={() => { if (refuseEditWhileFollowing() || refuseEditWhileOffline()) return; run(); }}>Run</div>;',
    };
    const loud = Object.entries(quiet).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`).length !== 0)
      .map(([form]) => form);
    expect(loud, 'correct guards G flags').toEqual([]);
  });

  // Fix round 7 of PR #200: review 7 N-1, the two correct guards G flagged,
  // and their wrong twins, which it must still catch.
  it('G corpus (review 7, N-1): a helper of several statements returning the refusal, and switch (G) { case true: return }', () => {
    const head = 'const run = useGraphStore((s) => s.executeGraph);\n';
    const quiet: Record<string, string> = {
      helper_returns_refusal: 'const stop = () => { if (refuseCanvasEdit()) return true; return false; };\nexport const A = () => <div role="button" onClick={() => { if (stop()) return; run(); }}>Run</div>;',
      helper_function_declaration: 'function stop() { if (!refuseCanvasEdit()) return false; return true; }\nexport const A = () => <div role="button" onClick={() => { if (stop()) return; run(); }}>Run</div>;',
      helper_redraws_then_returns: 'const stop = () => { if (refuseCanvasEdit()) { console.log(1); return true; } return false; };\nexport const A = () => <div role="button" onClick={() => { if (stop()) return; run(); }}>Run</div>;',
      switch_case_true: 'export const A = () => <div role="button" onClick={() => { switch (refuseCanvasEdit()) { case true: return; } run(); }}>Run</div>;',
    };
    const loud = Object.entries(quiet).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`).length !== 0)
      .map(([form]) => form);
    expect(loud, 'correct guards G flags').toEqual([]);
    const forms: Record<string, string> = {
      helper_returns_true_anyway: 'const stop = () => { if (refuseCanvasEdit()) return true; return true; };\nexport const A = () => <div role="button" onClick={() => { if (stop()) return; run(); }}>Run</div>;',
      helper_returns_negated: 'const stop = () => { if (refuseCanvasEdit()) return false; return true; };\nexport const A = () => <div role="button" onClick={() => { if (stop()) return; run(); }}>Run</div>;',
      helper_multi_false: 'const stop = () => { refuseCanvasEdit(); return false; };\nexport const A = () => <div role="button" onClick={() => { if (stop()) return; run(); }}>Run</div>;',
      switch_case_false: 'export const A = () => <div role="button" onClick={() => { switch (refuseCanvasEdit()) { case false: return; } run(); }}>Run</div>;',
      switch_case_true_no_exit: 'export const A = () => <div role="button" onClick={() => { switch (refuseCanvasEdit()) { case true: console.log(1); } run(); }}>Run</div>;',
    };
    const missed = Object.entries(forms).filter(([form, body]) => unlockedControls(head + body, `components/${form}.tsx`).length !== 1)
      .map(([form]) => form);
    expect(missed, 'forms G lets through').toEqual([]);
  });

  it('the palette is allowlisted control by control, never tag-wide (review 4 LOW-4)', () => {
    expect(Object.keys(CONTROL_ALLOWLIST).filter((key) => key.startsWith('components/CommandPalette.tsx'))).toEqual([]);
    const source = readFileSync(join(SRC, 'components/CommandPalette.tsx'), 'utf8');
    const extra = source.replace('</ModalPortal>', '<button type="button" onClick={() => run(flat[0])}>Run first</button></ModalPortal>');
    const lines = unlockedControls(extra, 'components/CommandPalette.tsx', resolveSource);
    expect(lines.filter((line) => !allowed(line)), 'a new palette button reaching a gated action').toHaveLength(1);
    for (const entry of CONTROL_AT) expect(entry.reason.trim()).not.toBe('');
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
      // Fix round 5 (review 5 LOW-3): a component's `lock` counts when it reads it.
      passed_down: 'const Toolbar = ({ lock, onRun }: P) => <button {...lock.act()} onClick={onRun}>Run</button>;\n'
        + 'export const A = () => <Toolbar lock={lock} onRun={() => run()} />;',
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
  // Fix round 25 of PR #198 (review 23 NIT-4): the merge trusted any `act`
  // param and `lockedAction` by name. Now an `act` counts only where every
  // use of its file-local component hands it a lock spread, and
  // `lockedAction` only as canvasLock's own export, whose body keeps act's lock.
  it('review 23 NIT-4: an `act` prop counts only where every use hands it the lock; lockedAction only as canvasLock\'s', () => {
    const head = 'const lock = useCanvasLock();\nconst run = useGraphStore((s) => s.executeGraph);\n';
    const child = 'function Child({ act }) { return <button {...act} onClick={run}>R</button>; }\n';
    const quiet: Record<string, string> = {
      handed: `${head}${child}export const A = () => <><Child act={lock.act()} /><Child act={lock.act({ disabled: true })} /></>;`,
      locked_action: `import { lockedAction } from '../lib/canvasLock';\n${head}export const A = () => <button {...lockedAction(lock)} onClick={run}>R</button>;`,
      locked_action_handed: `import { lockedAction } from '../lib/canvasLock';\n${head}${child}export const A = () => <Child act={lockedAction(lock, {}, { run: true })} />;`,
    };
    for (const [form, source] of Object.entries(quiet)) expect(unlockedControls(source, 'probe.tsx'), form).toEqual([]);
    const caught: Record<string, string> = {
      one_use_unlocked: `${head}${child}export const A = () => <><Child act={lock.act()} /><Child act={{}} /></>;`,
      one_use_without: `${head}${child}export const A = () => <><Child act={lock.act()} /><Child /></>;`,
      no_use: `${head}${child}export const A = () => null;`,
      exported: `${head}export ${child}export const A = () => <Child act={lock.act()} />;`,
      exported_by_name: `${head}${child}export { Child };\nexport const A = () => <Child act={lock.act()} />;`,
      passed_as_value: `${head}${child}export const B = Child;\nexport const A = () => <Child act={lock.act()} />;`,
      aliased: `import { offlineAction as lockedAction } from '../lib/canvasLock';\n${head}export const A = () => <button {...lockedAction(lock)} onClick={run}>R</button>;`,
      other_module: `import { lockedAction } from '../lib/fakeLock';\n${head}export const A = () => <button {...lockedAction(lock)} onClick={run}>R</button>;`,
      not_a_lock: `import { lockedAction } from '../lib/canvasLock';\n${head}export const A = () => <button {...lockedAction(other)} onClick={run}>R</button>;`,
    };
    for (const [form, source] of Object.entries(caught)) expect(unlockedControls(source, 'probe.tsx'), form).toHaveLength(1);
  });

  // Fix round 25 (review 23 NIT-4): the two CONTROL_AT entries the merge
  // added are gone; G reads a name where it is in scope (visibleLocals).
  it('review 23 NIT-4: a name is the definition in scope where it is read; a parameter hides the file\'s same-named locals', () => {
    const head = 'const lock = useCanvasLock();\n';
    const gated = 'useGraphStore.getState().executeGraph';
    const quiet: Record<string, string> = {
      other_function: `${head}function later() { const go = ${gated}; go(); }\nexport const A = () => { const go = () => {}; return <button onClick={go}>R</button>; };`,
      param_hides: `${head}function Row({ go }) { return <button onClick={go}>R</button>; }\nfunction useGo() { const go = ${gated}; return go; }\nexport const A = () => <Row go={() => {}} />;`,
      inner_block: `${head}export const A = () => { { const go = ${gated}; go(); } const go = () => {}; return <button onClick={go}>R</button>; };`,
    };
    for (const [form, source] of Object.entries(quiet)) expect(unlockedControls(source, 'probe.tsx'), form).toEqual([]);
    const caught: Record<string, string> = {
      local: `${head}export const A = () => { const go = ${gated}; return <button onClick={go}>R</button>; };`,
      module_level: `${head}const go = ${gated};\nexport const A = () => <button onClick={go}>R</button>;`,
      nearer_block: `${head}export const A = () => { const go = () => {}; { const go = ${gated}; return <button onClick={go}>R</button>; } };`,
      var_hoisted: `${head}export function A({ x }) { if (x) { var go = ${gated}; } return <button onClick={go}>R</button>; }`,
      destructured: `${head}export const A = () => { const { go } = { go: ${gated} }; return <button onClick={go}>R</button>; };`,
      assigned: `${head}const tools = {};\nfunction setUp() { tools.go = ${gated}; }\nexport const A = () => <button onClick={tools.go}>R</button>;`,
      out_of_scope_kept: `${head}function later() { const go = ${gated}; }\nexport const A = () => <button onClick={go}>R</button>;`,
    };
    for (const [form, source] of Object.entries(caught)) expect(unlockedControls(source, 'probe.tsx'), form).toHaveLength(1);
  });

  it('lockedAction keeps act\'s lock: it starts from lock.act and never writes disabled or aria-disabled (review 23 NIT-4)', () => {
    const source = readFileSync(join(SRC, 'lib/canvasLock.ts'), 'utf8');
    const body = /export function lockedAction\([\s\S]*?\n\}\n/.exec(source)?.[0] ?? '';
    expect(body).toMatch(/const props[^=]*= lock\.act\(own, options\);/);
    expect(body).toMatch(/return props;\n\}\n$/);
    expect(body).not.toMatch(/\bdisabled\b|aria-disabled|delete |Object\.assign|\.\.\./);
  });

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
  // PR #198's own, kept through the merge with #200 and listed for the same
  // sweep: the canvas notice's held and locked buttons (GM r33's token set,
  // canvasProposals.css; its filled look differs from this file's, a GM
  // call), the Cinema fieldset's dimming for checkboxes, swatches and
  // sliders (round 5), and the editor's clip presets (GM r18, beside
  // editor-transport__btn above).
  'styles/canvasProposals.css: canvas-undo-notice button',
  'styles/cinema-studio.css: cinema-offline-lock button',
  'styles/slava-restraint.css: editor-transport__preset',
]);

describe('GM r24 item 2 and PR #200 answer 6: a disabled button is neutral grey whatever the reason', { timeout: 120_000 }, () => {
  const shared = readFileSync(join(SRC, SHARED), 'utf8');
  const rules = cssRules(shared);
  // The two list rules (fix round 3 added smaller ones for no-label buttons beside them).
  // Round 25 of PR #198 (GM r37, option c): the list rules read GM r33's
  // token set, the filled one the grey fill (--disabled-fill).
  const filledRule = rules.find(({ selector, body }) => /:disabled/.test(selector) && /background:\s*var\(--disabled-fill[,)]/.test(body)
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
      // A notice button's first ~150 ms held (useHeldLook) keeps its own look.
      expect(rule.selector).toMatch(/\[aria-disabled=['"]?true['"]?\]:not\(\[data-held-pending\]\)/);
    }
    // GM r37 option c: GM r33's tokens, by kind of button.
    expect(filledRule!.body).toMatch(/color:\s*var\(--disabled-fill-label[,)]/);
    expect(unfilledRule!.body).toMatch(/color:\s*var\(--disabled-label[,)]/);
    // The unfilled rule comes first: a filled style wins for a button that has both classes.
    expect(shared.indexOf('background: transparent !important')).toBeLessThan(shared.indexOf('background: var(--disabled-fill,'));
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

  // PR #198 round 25 (review 23 MEDIUM-1, GM r37 option c): one look for
  // every reason. Cinema's offline rule painted its buttons with !important
  // (transparent, the 0.06 edge) over this file's look, so Generate shot read
  // one way offline and another following, and the checks above missed it:
  // it keys on the lock's mark ([data-offline-disabled]) and a fieldset's
  // :disabled descendants, through a bare `button`. No other sheet may paint
  // (background, colour, border colour, with !important) a disabled, held or
  // lock-marked button: a bare `button` or a class this file covers.
  it('no other sheet overrides the shared look for any reason (offline, following, a hold): no !important paint on a disabled or lock-marked button', () => {
    const LOCKED = /:disabled|\[aria-disabled|\[data-offline-disabled\]|\[data-following-disabled\]|data-held-look/;
    const PAINT = /(?:^|;)\s*(?:background(?:-color)?|color|border-color)\s*:[^;]*!important/;
    const found: string[] = [];
    for (const path of walk(SRC, /\.css$/)) {
      const file = relative(SRC, path);
      if (file === SHARED) continue;
      for (const { selector, body } of cssRules(readFileSync(path, 'utf8'))) {
        if (!PAINT.test(body)) continue;
        for (const one of selectorsOf(selector)) {
          const state = one.replace(/:not\([^)]*\)/g, '');
          if (!LOCKED.test(state) || /:not\(\.app-slava-restraint\)/.test(one)) continue;
          const subject = state.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
          const className = subjectClass(state);
          if (/^button\b/.test(subject) || (className && covered(className))) found.push(`${file}: ${one.replace(/\s+/g, ' ')}`);
        }
      }
    }
    expect(found).toEqual([]);
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
  // Fix round 4 (GM round 5 answer 2): the floor is 1.25×, the red about 8:1.
  it('N-5: an unfilled control\'s enabled label is at least 1.25× the grey; the red Delete is measured and clears it', () => {
    const report = disabledLooks();
    const danger = report.find((row) => row.className === 'selection-toolbar__button--danger');
    expect(danger, 'the modifier is measured').toBeDefined();
    expect(danger!.disabled.label).toBeLessThanOrEqual(CLEARLY_DIMMER * danger!.enabled.label);
    expect(report.find((row) => row.className === 'prompt-dialog__destructive')!.enabled.label).toBeGreaterThanOrEqual(danger!.disabled.label / CLEARLY_DIMMER);
    // On the toolbar's own surface, not black (fix round 3: the live check
    // drew #ff968a at 8.8:1 against the grey's 6.2:1 there).
    const toolbar = cssRules(readFileSync(join(SRC, 'styles/canvas.css'), 'utf8')).find((rule) => rule.selector.trim() === '.selection-toolbar');
    const surface = over(parseColor(/background:\s*([^;]+)/.exec(toolbar!.body)![1])!, CANVAS);
    const red = parseColor(resolveFill('var(--sr-danger-ink)', fillTokens()))!;
    const grey = parseColor(resolveFill('var(--sr-disabled-ink)', fillTokens()))!;
    expect(contrast(over(grey, surface), surface)).toBeLessThanOrEqual(CLEARLY_DIMMER * contrast(over(red, surface), surface));
    for (const [name, reason] of Object.entries(ACCENT_GHOSTS)) expect(reason.trim(), name).not.toBe('');
    // GM round 5 answer 2: a true red (hue about 5°, never the salmon
    // #ffa395 at 8°), about 8:1 on the toolbar, the hover brighter.
    const hue = ({ r, g, b }: Rgba) => { const max = Math.max(r, g, b); const min = Math.min(r, g, b); return max === r ? 60 * (((g - b) / (max - min)) % 6) : NaN; };
    expect(hue(red)).toBeLessThanOrEqual(6);
    expect(contrast(over(red, surface), surface)).toBeGreaterThanOrEqual(7.8);
    expect(contrast(over(red, surface), surface)).toBeLessThanOrEqual(8.5);
    const hover = parseColor(resolveFill('var(--sr-danger-ink-hover)', fillTokens()))!;
    expect(luminance(hover)).toBeGreaterThan(luminance(red));
    expect(hue(hover)).toBeLessThanOrEqual(6);
  });

  it('M-3: no-label buttons have a disabled look of their own; the selected one keeps a grey mark', () => {
    const shared = cssRules(readFileSync(join(SRC, SHARED), 'utf8'));
    for (const [name, { image, selected }] of Object.entries(NO_LABEL)) {
      const own = shared.filter(({ selector }) => /^:is\([^)]*\):is\(:disabled/.test(selector) && new RegExp(`\\.${name}(?:\\s[^,)]*)?[,)]`).test(selector.slice(0, selector.indexOf('):is(:disabled') + 1)));
      expect(own.length, `${name}: a disabled rule`).toBeGreaterThan(0);
      // Never a fill brighter than its resting look, and the edge no brighter than enabled.
      for (const { body } of own) expect(body, name).not.toMatch(/background:\s*var\(--(?:sr-)?disabled-fill[,)]/);
      if (image) {
        const img = shared.find(({ selector }) => selector.includes(name) && /:disabled/.test(selector) && /\simg$/.test(selector.trim()));
        expect(img, `${name}: its image dims`).toBeDefined();
        expect(Number(/opacity:\s*([\d.]+)/.exec(img!.body)?.[1])).toBeLessThanOrEqual(0.55);
        expect(img!.body).toMatch(/filter:\s*grayscale\(1\)/);
      }
      if (selected) {
        const mark = shared.find(({ selector }) => selected.test(selector) && /:disabled/.test(selector));
        expect(mark, `${name}: the selected one keeps a mark`).toBeDefined();
        expect(mark!.body).toMatch(/border-color:\s*var\(--sr-disabled-ink/);
      }
    }
  });

  // Fix round 4 of PR #200 (review 4 LOW-3, GM round 5 answer 1): a locked
  // colour swatch keeps its hue, dims to 0.45 with the disabled edge, and
  // never changes on hover; a variation (the image is the button) greys.
  it('LOW-3: locked colour swatches dim to 0.45 with the grey edge and keep their hue; variations stay greyscale', () => {
    const shared = cssRules(readFileSync(join(SRC, SHARED), 'utf8'));
    for (const name of Object.keys(NO_LABEL).filter((key) => NO_LABEL[key].swatch)) {
      const rule = shared.find(({ selector }) => new RegExp(`\\.${name}(?![\\w-])`).test(selector) && /:disabled/.test(selector) && /:hover/.test(selector));
      expect(rule, `${name}: one rule, its hover included`).toBeDefined();
      expect(rule!.body).toMatch(/opacity:\s*0\.45\s*!important/);
      expect(rule!.body).toMatch(/border-color:\s*var\(--sr-disabled-edge/);
      expect(rule!.body).toMatch(/filter:\s*none\s*!important/);
      expect(rule!.body).not.toMatch(/grayscale/);
    }
    const variation = shared.find(({ selector }) => selector.includes('.cinema-shot-panel__variation') && /\simg$/.test(selector.trim()));
    expect(variation!.body).toMatch(/grayscale\(1\)/);
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
const NO_LABEL: Record<string, { image: boolean; selected: RegExp | null; swatch?: boolean; edgeKept?: boolean }> = {
  'cinema-shot-panel__variation': { image: true, selected: /\.cinema-shot-panel__variation--active/ },
  'remotion-properties-panel__anchor-button': { image: false, selected: /\.remotion-properties-panel__anchor-button\[data-active='true'\]/ },
  // Fix round 4 (review 4 N-7): the Projects cover picker, disabled while busy.
  // Its edge is transparent at rest and stays so disabled.
  'project-home__cover-choice': { image: true, selected: /\.project-home__cover-choice\[aria-pressed='true'\]/, edgeKept: true },
  // Fix round 4 (review 4 LOW-3; GM round 5 answer 1): colour swatches keep
  // their hue (the colour is the content), dimmed, no selected state.
  'cinema-shared-controls__swatch': { image: false, selected: null, swatch: true },
  'inspector__palette-color': { image: false, selected: null, swatch: true },
};
/** "Clearly dimmer" (GM r1 answer 2), fix round 3 of PR #200 (review 3
 * N-5), set by GM in round 5 (answer 2): the red Delete "clearly above the
 * disabled 6.2:1, aiming for about 8:1", so an enabled label at least 1.25
 * times the disabled grey's contrast (8.0 against 6.2 is 1.29). The neutral
 * controls sit near 2× (17.6:1 or 12.5:1 against 6.3:1); a coloured label
 * that greys must clear it by brightness, not by its hue change alone. */
const CLEARLY_DIMMER = 0.8;
/** Ghost buttons whose label is the brand accent (GM, PR #200 round 5
 * answer 1: "an orange label and outline, not a fill, so it follows the
 * ghost rule"): the accent isn't lightened, and the label greys at about
 * its luminance, so the outline carries the change: enabled it must be
 * clearly brighter than the disabled edge (a hue-only change is invisible
 * to colour-blind users). */
const ACCENT_GHOSTS: Record<string, string> = {
  'prompt-dialog__confirm': 'Send note and the other dialog confirms: the accent label (6.7:1) and outline; disabled, both go to the shared grey (GM round 5 answer 1)',
};
/** How much brighter an accent ghost's enabled outline is than the disabled edge. */
const OUTLINE_DROP = 1.25;
/** Filled buttons whose enabled label is under the grey's contrast: the fill
 * shows the state (GM r2 answer 6, "Generate shot's contrast: no change; its
 * fill shows the state"). Each still turns from its fill to the grey fill,
 * which the test checks is dimmer. */
// Round 25 of PR #198 (GM r37 option c): the grey fill's dark label is
// dimmer than every enabled filled label, white on the accent (2.9:1) and on
// the agent's colour included, so none needs this any more (Generate and
// Accept left it; the test below keeps the list true).
const FILL_SHOWS_STATE: Record<string, string> = {};

function disabledLooks() {
  const tokens = cssTokens();
  const shared = readFileSync(join(SRC, SHARED), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const lists = [...shared.matchAll(/:is\(([^)]*)\):is\(:disabled[^{]*\{([^}]*)\}/g)].map((m) => ({ classes: [...m[1].matchAll(/\.([\w-]+)/g)].map((c) => c[1]), body: m[2] }));
  // GM r37 option c: a filled button's label is the dark one on the grey
  // fill, a ghost button's the grey label (GM r33's token set).
  const ghostInk = parseColor(resolveVar('var(--disabled-label)', tokens))!;
  const fillInk = parseColor(resolveVar('var(--disabled-fill-label)', tokens))!;
  const greyFill = parseColor(resolveVar('var(--disabled-fill)', tokens))!;
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
    const filled = /var\(--disabled-fill[,)]/.test(/background:[^;]*/.exec(body)?.[0] ?? '');
    const ink = filled ? fillInk : ghostInk;
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
      const disabledEdge = !edgeColor || NO_LABEL[className]?.edgeKept ? 1 : filled ? 1 : contrast(over(greyEdge, CANVAS), CANVAS);
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
        } else if (!filled && ACCENT_GHOSTS[className]) {
          if (enabledEdge < OUTLINE_DROP * disabledEdge) problem = `an accent ghost: its outline ${enabledEdge.toFixed(2)}:1 is not clearly brighter than the disabled edge ${disabledEdge.toFixed(2)}:1, so only the hue changes`;
        } else if (!filled && disabledLabel > CLEARLY_DIMMER * enabledLabel) {
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

// Fix rounds 7 to 9 of PR #200 (GM r11 answer 3, verbatim: "Grep for any
// other hard-coded reds or orange on destructive actions, so the rule is
// enforced in code (a ratchet), not by eye."). THE RULE, by what the action
// does, not how the control looks (GM r13, and r14's calls):
// - Red: it deletes a standalone thing (project, node, asset, result, agent, API key, app token), or wipes a whole surface (Clear, Purge, Discard). Undo doesn't change this (node Delete stays red).
// - Neutral: it takes an item out of a list inside the thing you're editing (chips, swatches, tags, a shot in a scene, an item on a board, a character view).
// GM r16 answer 1: Krea Disconnect is red; an agent's Sign out is neutral
// (it deletes only the stored Google login, which signing in brings back).
// Controls are found by their words (review 8 LOW-2, review 9 LOW-4); the
// words say the kind first and the class must agree; the colours are checked
// per rule (focus rules too, all but the ring) and per control through the
// cascade, colour inherited from its ancestors included. The machinery is
// tests/helpers/destructiveRule.ts.
// It parses every stylesheet and walks every TSX file: a few seconds alone,
// past vitest's 5 s default under the full suite (it timed out there).
describe('GM r11 answer 3, r13 and r14: red marks what deletes a standalone thing or wipes a surface, an edit stays neutral, and orange marks neither', { timeout: 120_000 }, () => {
  const sheets = appCss();
  const vars = customProperties(sheets);
  const controls = appControls();

  it('every control that names an action (Delete, Clear, Discard, Purge, Trash, Remove, Erase, Empty, Revoke, Forget) says its kind in its class', () => {
    expect(controls.length).toBeGreaterThanOrEqual(61);
    expect(controls.filter((control) => !control.kind).map((c) => `${c.file}:${c.line} ${c.name}`)).toEqual([]);
    // Review 8's controls, each seen with GM r14's kind.
    const kindAt = (file: string, name: RegExp) => controls.filter((c) => c.file === file && name.test(c.name)).map((c) => c.kind);
    expect(kindAt('components/moodboard-studio/MoodboardStudioView.tsx', /^(Delete|Move to Recently deleted)$/)).toEqual(['red']);
    expect(kindAt('components/character-studio/CharacterStudioToolbar.tsx', /^(Delete|Move to Recently deleted)$/)).toEqual(['red']);
    expect(kindAt('components/commons/CommonsDetail.tsx', /^Delete$/)).toEqual(['red']);
    expect(kindAt('components/commons/CommonsLeavePopover.tsx', /^Discard and leave$/)).toEqual(['red']);
    expect(kindAt('components/commons/CommonsEvaluation.tsx', /^Discard/)).toEqual(['red']);
    expect(kindAt('components/commons/CommonsReview.tsx', /^Discard/)).toEqual(['red']);
    expect(kindAt('components/panels/settings/PersonalAgentsSection.tsx', /^Remove download$/)).toEqual(['red']);
    expect(kindAt('components/panels/RunHistoryPanel.tsx', /^Clear run history$/)).toEqual(['red']);
    expect(kindAt('components/panels/MaskPainterModal.tsx', /^Clear$/)).toEqual(['red']);
    expect(kindAt('components/panels/ChatPanel.tsx', /^Remove image$/)).toEqual(['neutral']);
    expect(kindAt('components/commons/CommonsEvaluation.tsx', /^Remove accent/)).toEqual(['neutral']);
    expect(kindAt('components/projects/ProjectHome.tsx', /^Delete forever$/)).toEqual(['red', 'red']);
    expect(kindAt('components/asset-trash/AssetTrash.tsx', /^Delete forever$/)).toEqual(['red', 'red']);
  });

  it('review 9 LOW-4: the words say the kind first; the class must agree (a red word on a neutral class only where reviewed)', () => {
    expect(controls.length).toBeGreaterThanOrEqual(72);
    expect(controls.flatMap((control) => wordFindings(control))).toEqual([]);
    const kindAt = (file: string, name: RegExp) => controls.filter((c) => c.file === file && name.test(c.name)).map((c) => c.kind);
    // The ten review 9 found (GM r16 answer 1 for the last two).
    expect(kindAt('components/cinema-studio/CinemaShotPanel.tsx', /^Reset shot (palette|look) to scene$/)).toEqual(['neutral', 'neutral']);
    expect(kindAt('components/editor/EditorTransport.tsx', /^Reset zoom/)).toEqual(['neutral']);
    expect(kindAt('components/nodes/WorldPreview.tsx', /^Reset camera$/)).toContain('neutral');
    expect(kindAt('components/panels/Toolbar.tsx', /reset/i)).toEqual(['neutral', 'neutral']);
    expect(kindAt('components/panels/MaskPainterModal.tsx', /^Erase$/)).toEqual(['neutral']);
    expect(kindAt('components/panels/Inspector.tsx', /favorites/)).toEqual(['neutral']);
    expect(kindAt('components/panels/settings/KreaSignInRow.tsx', /^Disconnect$/)).toEqual(['red']);
    expect(kindAt('components/panels/settings/PersonalAgentsSection.tsx', /^Sign out$/)).toEqual(['neutral']);
    // The two reviewed red words on neutral controls (GM r14), pinned.
    expect(kindAt('components/commons/CommonsFilters.tsx', /^clear$/)).toEqual(['neutral']);
    expect(kindAt('components/create-studio/ResultsGallery.tsx', /^Clear$/)).toEqual(['neutral']);
    expect(wordKind('Clear', 'components/other/Elsewhere.tsx')).toBe('red');
    expect(wordKind('Remove')).toBeNull();
  });

  it('review 9 NIT-2: pressed, every red control\'s text goes to the lighter red', () => {
    expect(controls.flatMap((control) => pressedFindings(control))).toEqual([]);
  });

  it('corpus (review 9 LOW-4): every form that hid a control is found, and its words decide', () => {
    const one = (tsx: string) => controlsIn(tsx, 'probe.tsx').map((c) => [c.name, c.kind]);
    expect(one('const A = () => <button className="x__go" aria-label={t("actions.delete")}>x</button>;')).toEqual([['actions.delete', null]]);
    expect(one('const A = () => <button className="x__go" aria-label={strings.deleteProject}>x</button>;')).toEqual([['delete Project', null]]);
    expect(one('function A(props) { return <button className="x__go" aria-label={props.label}>x</button>; } const B = () => <A label="Delete" />;')).toEqual([['Delete', null]]);
    expect(one('const A = (p) => <button className="x__go" {...p} />; const B = () => <A aria-label="Delete" />;')).toEqual([['Delete', null]]);
    expect(one('const A = () => <IconButton className="x__go" aria-label="Delete" onClick={del} />;')).toEqual([['Delete', null]]);
    expect(one('const A = () => <MenuItem className="x__go" onSelect={del}>Delete</MenuItem>;')).toEqual([['Delete', null]]);
    expect(one('const A = () => <input type="button" className="x__go" value="Delete" />;')).toEqual([['Delete', null]]);
    expect(one('const A = () => <a className="x__go" href="#" onClick={del}>Delete</a>;')).toEqual([['Delete', null]]);
    expect(one('const A = () => <span className="x__go" onClick={del}>Delete</span>;')).toEqual([['Delete', null]]);
    expect(one('const A = () => <button className="x__go"><>Del</>ete</button>;')).toEqual([['Delete', null]]);
    expect(one('const A = () => <button className="x__go">Permanently delete</button>;')).toEqual([['Permanently delete', null]]);
    expect(one('const A = () => <button className="x__go">Move to Recently deleted</button>;')).toEqual([['Move to Recently deleted', null]]);
    expect(one('const A = () => <button className="x__go">Uninstall</button>;')).toEqual([['Uninstall', null]]);
    expect(one('const A = () => <button className="x__go">Disconnect</button>;')).toEqual([['Disconnect', null]]);
    expect(one('const A = () => <button className="x__go">Reset all settings</button>;')).toEqual([['Reset all settings', null]]);
    expect(one('const A = () => <button aria-pressed={false} className="x__go">Delete</button>;')).toEqual([['Delete', null]]);
    // A label from another file: the component is imported by name.
    const across = controlsInFiles({
      'components/a/Confirm.tsx': 'export function Confirm({ label }) { return <button className="x__go x__go--delete" aria-label={label}>x</button>; }',
      'components/b/Use.tsx': "import { Confirm } from '../a/Confirm';\nexport const B = () => <Confirm label=\"Delete forever\" />;",
      'components/c/Other.tsx': 'function Confirm({ label }) { return <button className="y__go" aria-label={label}>x</button>; }\nexport const C = () => <Confirm label="Delete" />;',
    });
    expect(across.map((c) => [c.file, c.name, c.kind])).toEqual([
      ['components/b/Use.tsx', 'Delete forever', 'red'],
      ['components/c/Other.tsx', 'Delete', null],
    ]);
    // A disclosure opens a section; a clickable card says only its own words.
    expect(one('const A = () => <button aria-expanded={open}>Recently deleted</button>;')).toEqual([]);
    expect(one('const A = () => <div className="card" onClick={pick}><button className="x__delete">Delete</button></div>;')).toEqual([['Delete', 'red']]);
    // The words decide: a red word on a neutral class fails; Remove says neither.
    const words = (tsx: string) => controlsIn(tsx, 'probe.tsx').flatMap((c) => wordFindings(c));
    expect(words('const A = () => <button className="x__remove">Delete project</button>;')).not.toEqual([]);
    expect(words('const A = () => <button className="x__delete">Reset zoom</button>;')).not.toEqual([]);
    expect(words('const A = () => <button className="x__delete">Remove</button>;')).toEqual([]);
    expect(words('const A = () => <button className="x__remove">Remove</button>;')).toEqual([]);
    expect(words('const A = () => <button className="x__reset">Clear search</button>;')).toEqual([]);
  });

  it('corpus (review 9 LOW-4): every colour form that hid an orange is caught, focus rules and inherited colour included', () => {
    const caught = (css: string) => ruleFindings(css, 'probe.css', customProperties([{ css }]));
    for (const css of [
      '.x__delete:focus-visible { color: #ff5a1f; background: #ff5a1f; }',
      '.x__delete:hover:focus { color: #ff5a1f; }',
      '.row:focus-within .x__delete { color: #ff5a1f; }',
      '.x__delete:is(:hover, :focus-visible) { color: #ff5a1f; }',
      '.x__delete:hover { color: hwb(20 0% 0%); }',
      '.x__delete:hover { color: lab(62 52 62); }',
      '.x__delete:hover { color: lch(62 80 50); }',
      '.x__delete:hover { color: oklab(0.7 0.15 0.12); }',
      '.x__delete:hover { color: color(display-p3 1 0.35 0.12); }',
      '.x__delete:hover { color: color-mix(in srgb, var(--sr-accent) 60%, white); }',
      '.x__delete:hover { color: hsl(0.04turn 90% 55%); }',
      '.x__delete:hover { color: hsl(0.3rad 90% 55%); }',
      '.x__delete:hover { border-inline-color: #ff5a1f; }',
      '.x__delete:hover { border-block-end-color: #ff5a1f; }',
      '.x__delete { accent-color: #ff5a1f; }',
      '.x__delete:hover { -webkit-text-fill-color: #ff5a1f; }',
      '.x__delete:hover { background: linear-gradient(#ff5a1f, #ff5a1f); }',
      '@scope (.x__delete) { :scope:hover { color: #ff5a1f; } }',
      '@layer a { .x__delete:hover { color: #ff5a1f; } }',
      '@media (hover: hover) { .x__delete:hover { color: #ff5a1f; } }',
      '.x__delete:hover svg { color: #ff5a1f; stroke: #ff5a1f; }',
      '.x__delete:hover::before { background: #ff5a1f; }',
      ':root { --hot: var(--sr-accent); } .x__delete:hover { color: var(--hot); }',
      '.x__remove:hover { color: #ff3b30; }',
      '.x__delete:hover + .label { color: #ff5a1f; }',
      '.x__delete:hover ~ span { color: #ff5a1f; }',
      '.x__erase:hover { color: var(--sr-danger-ink); }',
    ]) expect(caught(css), css).not.toEqual([]);
    for (const css of [
      // A focus ring may be any colour the keyboard-ring rule gives it (r17).
      '.x__delete:focus-visible { outline: 2px solid var(--sr-accent); box-shadow: 0 0 0 2px var(--sr-accent); }',
      // Review 8's false flags still quiet: a classed descendant is its own control.
      '.panel--danger .panel__run { color: var(--sr-accent); }',
      '.x__delete .x__count { color: var(--sr-accent); }',
      '.x__delete:hover { color: var(--sr-danger-ink,#FF887D); }',
      '.canvas-pin__delete:hover, .canvas-pin__delete:focus-visible { background: var(--sr-danger-tint); color: var(--sr-danger-ink, #ff887d); }',
    ]) expect(caught(css), css).toEqual([]);
    // Colour a control doesn't set comes from its ancestors, in the same state.
    const vars0 = customProperties(appCss());
    const inside = { file: 'probe.tsx', line: 1, name: 'Delete', kind: 'red' as const, classes: ['x__delete'], ancestors: [['div', ['probe-toolbar']]] as Array<[string, string[]]> };
    expect(cascadeFindings(inside, vars0, '.probe-toolbar { color: #ff5a1f; } .x__delete { color: inherit; }').join('\n')).toMatch(/#ff5a1f.*inherited/);
    expect(cascadeFindings(inside, vars0, '.probe-toolbar:hover { color: #ff5a1f; }').join('\n')).toMatch(/:hover color: #ff5a1f/);
    expect(cascadeFindings({ ...inside, kind: 'neutral', classes: ['x__remove'] }, vars0, '.probe-toolbar:hover { color: currentcolor; } .probe-toolbar { color: orange; }').join('\n')).toMatch(/orange/);
    expect(cascadeFindings(inside, vars0, '.probe-toolbar { color: #ff5a1f; } .x__delete { color: var(--sr-danger-ink); } .x__delete:hover { color: var(--sr-danger-ink); }')).toEqual([]);
  });

  it('no stylesheet rule gives a kind the wrong colour: red only from the danger tokens, neutral never red, orange or a danger token', () => {
    expect(sheets.flatMap(({ css, file }) => ruleFindings(css, file, vars))).toEqual([]);
  });

  it('on every control the rule that wins the cascade at rest, on hover and pressed keeps its kind', () => {
    expect(controls.flatMap((control) => cascadeFindings(control, vars))).toEqual([]);
  });

  it('GM r18: no frame around a red control is amber, warning or accent (Forget ID sat in an amber box)', () => {
    expect(controls.flatMap((control) => frameFindings(control, vars))).toEqual([]);
    // GM r22 Q2: the status edge's fill passes by its presence variable, whatever the colour.
    expect(PRESENCE_COLOUR.test('var(--pin-color)')).toBe(true);
    expect(PRESENCE_COLOUR.test('var(--agent-color, #5b9dff)')).toBe(true);
    expect(PRESENCE_COLOUR.test('#e8a33d')).toBe(false);
    // The real Delete note sees the edge beside it (its `near`), and passes.
    const pinDeleteReal = controls.find((c) => c.file.endsWith('PinLayer.tsx') && c.name === 'Delete note');
    expect(pinDeleteReal?.near?.map((tree) => tree[1][0])).toEqual(expect.arrayContaining(['canvas-pin__edge', 'canvas-pin__text', 'canvas-pin__meta', 'canvas-pin__reply']));
  });

  it('GM r18 corpus: an amber, warning, accent or warm frame is caught at rest and on hover; neutral and red frames stay quiet', () => {
    const vars0 = customProperties(appCss());
    const forget = { file: 'probe.tsx', line: 1, name: 'Forget ID', kind: 'red' as const, classes: ['x__forget'],
      ancestors: [['section', ['probe-box']], ['div', ['probe-row']]] as Array<[string, string[]]> };
    for (const css of [
      // Round 11's own safeguards box, before this round.
      '.probe-box { border: 1px solid color-mix(in srgb, var(--sr-warning, #f5c518) 40%, transparent); }',
      '.probe-box { background: color-mix(in srgb, var(--sr-warning, #f5c518) 10%, transparent); }',
      '.probe-box { border: 1px solid #66471f; }',
      '.probe-row:hover { outline: 1px solid #f5c518; }',
      '.probe-row { box-shadow: 0 0 0 1px var(--sr-accent); }',
      '.probe-box { border-left: 3px solid #e8a33d; }',
      // Amber by hue, not the presence variable: still caught (GM r20 Q3).
      '.probe-box { border-left: 3px solid var(--sr-warning); }',
      '.probe-box { border: 3px solid var(--pin-color); }',
      '.probe-box:hover { border-color: #ff5a1f; }',
      // Review 12 NIT-2: every state, pseudo-element, gradient, shadow and alias.
      'body.app-slava-restraint .probe-row:focus-within { outline: 1px solid #f5c518; }',
      'body.app-slava-restraint .probe-row:active { box-shadow: 0 0 0 1px #ff5a1f; }',
      'body.app-slava-restraint .probe-box::before { content: ""; position: absolute; inset: 0; border: 1px solid #f5c518; }',
      'body.app-slava-restraint .probe-box { border: 1px solid; border-image: linear-gradient(#f5c518, #f5c518) 1; }',
      'body.app-slava-restraint .probe-box { background-image: linear-gradient(rgba(245,197,24,.2), rgba(245,197,24,.2)); }',
      'body.app-slava-restraint .probe-box { filter: drop-shadow(0 0 2px #f5c518); }',
      'body.app-slava-restraint .probe-box[data-open] { border-color: #f5c518; }',
      'body.app-slava-restraint .probe-box:not(.closed) { border-color: #f5c518; }',
      ':root { --box-edge: var(--sr-accent); } body.app-slava-restraint .probe-box { border: 1px solid var(--box-edge); }',
      'body.app-slava-restraint .probe-box > .probe-row::after { content: ""; border-bottom: 2px solid #ff5a1f; }',
      'body.app-slava-restraint .probe-row:hover { outline: 2px solid var(--sr-warning); outline-offset: 2px; }',
      // The control's own pseudo-element drawing a frame round it.
      '.x__forget::after { content: ""; border: 1px solid #f5c518; }',
    ]) expect(frameFindings(forget, vars0, css), css).not.toEqual([]);
    // GM r22 Q2 (fix round 14): near Delete note only the status edge's own
    // fill may take the presence colour. The card's border or fill, the Delete
    // row, the text, the reply, the edge's border or glow all fail.
    const pinDelete = { file: 'components/canvas/PinLayer.tsx', line: 1, name: 'Delete note', kind: 'red' as const, classes: ['canvas-pin__delete'],
      ancestors: [['div', ['canvas-pin']], ['div', ['canvas-pin__card']]] as Array<[string, string[]]>,
      near: [['span', ['canvas-pin__edge'], []], ['p', ['canvas-pin__text'], []], ['p', ['canvas-pin__meta'], []],
        ['p', ['canvas-pin__reply'], [['span', ['canvas-pin__agent'], []]]]] as JsxTree[] };
    for (const css of [
      '.canvas-pin__card { border-left: 3px solid var(--pin-color); }',
      '.canvas-pin__card { border: 2px solid var(--sr-accent); box-shadow: 0 0 0 4px #ff5a1f; }',
      '.canvas-pin__card { box-shadow: 0 0 0 2px var(--pin-color); }',
      '.canvas-pin__card { background: var(--pin-color); }',
      'body.app-slava-restraint .canvas-pin__card { border-color: #ff5a1f; }',
      '.canvas-pin { outline: 2px solid #ff5a1f; }',
      '.canvas-pin__meta { background: color-mix(in srgb, var(--pin-color) 20%, transparent); }',
      '.canvas-pin__text { border-bottom: 1px solid #f5c518; }',
      '.canvas-pin__reply .canvas-pin__agent { background: #e8a33d; }',
      '.canvas-pin__edge { background: #f5c518; }',
      '.canvas-pin__edge { background: var(--pin-color); box-shadow: 0 0 8px var(--pin-color); }',
      '.canvas-pin__edge:hover { background: var(--pin-color); }',
      // Review 13 NIT-4: the 8-digit hex, currentColor over an amber colour,
      // a rule that reaches the edge without naming it, a warm fallback.
      '.canvas-pin__card { border: 1px solid #f5c518cc; }',
      '.canvas-pin__card { box-shadow: 0 0 0 1px #fc1c; }',
      '.canvas-pin__card { color: #f5c518; border: 1px solid currentColor; }',
      '.canvas-pin__text { color: #f5c518; border-bottom: 1px solid currentColor; }',
      '.canvas-pin__card:hover { color: #e8a33d; outline: 1px solid currentColor; }',
      '.canvas-pin__card > span { background: var(--pin-color); }',
      '.canvas-pin__card span:first-child { background: var(--pin-color); }',
      '.canvas-pin__edge { background: var(--pin-color, #ff5a1f); }',
      // Review 14 NIT-2 (fix round 16): a narrow left edge only. The presence
      // fill stretched over the card, or widened in any state, fails.
      '.canvas-pin__edge { position: absolute; inset: 0; background: var(--pin-color); }',
      '.canvas-pin__edge { width: 100%; background: var(--pin-color); }',
      '.canvas-pin__edge { right: 0; background: var(--pin-color); }',
      '.canvas-pin__edge { width: 12px; background: var(--pin-color); }',
      '.canvas-pin__edge:hover { width: 100%; }',
      '.canvas-pin__edge { min-width: 40px; }',
      '.canvas-pin__edge { padding-right: 200px; }',
      '.canvas-pin__edge { transform: scaleX(80); }',
      '.canvas-pin__edge { inset-inline: 0; }',
      // Review 15 NIT 2 (fix round 18): zoom, a blur, a pseudo-element
      // repainting the fill, a wide border the fill paints under.
      '.canvas-pin__edge { zoom: 40; }',
      '.canvas-pin__edge { filter: blur(30px); }',
      '.canvas-pin__edge { filter: drop-shadow(0 0 20px var(--pin-color)); }',
      '.canvas-pin__edge::after { content: ""; position: absolute; top: 0; left: 0; width: 200px; height: 100%; background: inherit; }',
      '.canvas-pin__edge::before { content: ""; position: absolute; inset: 0; background: inherit; }',
      '.canvas-pin__edge:hover::after { content: ""; width: 12rem; }',
      '.canvas-pin__edge { border-right: 200px solid transparent; background-clip: border-box; }',
      '.canvas-pin__edge { border-right: 200px solid transparent; }',
      '.canvas-pin__edge { border-width: 0 10em 0 0; border-style: solid; border-color: transparent; }',
      '.canvas-pin__edge { width: 1rem; }',
      // Review 16 NIT 5 (fix round 19): a pseudo-element's text with no width
      // (as wide as its glyphs), and ems on the edge's own changed font size.
      '.canvas-pin__edge::after { content: "a label as wide as its words"; position: absolute; left: 0; }',
      '.canvas-pin__edge::before { content: attr(data-x); }',
      '.canvas-pin__edge { font-size: 1000px; width: 0.25em; }',
      '.canvas-pin__edge { font-size: 500%; width: 0.25em; }',
      '.canvas-pin__edge { font-size: larger; width: 0.25em; }',
      '.canvas-pin__edge::after { content: ""; font-size: 400px; width: 0.5em; }',
      // Review 17 NIT 2 (fix round 20): the font shorthand, at rest and in a
      // state; pseudo text a width doesn't hold in (no clip, an inline box,
      // letter-spacing); a font size the edge inherits; a flex basis or grow.
      '.canvas-pin__edge { font: 1000px/1 serif; width: 0.25em; }',
      '.canvas-pin:hover .canvas-pin__edge { font: 1000px serif; width: 0.25em; }',
      '.canvas-pin__edge { font: var(--big); width: 0.25em; }',
      '.canvas-pin__edge::after { content: "\\2588\\2588\\2588\\2588"; width: 2px; font-size: 40px; color: var(--pin-color); position: absolute; left: 0; }',
      '.canvas-pin__edge::after { content: "."; width: 2px; letter-spacing: 400px; color: var(--pin-color); position: absolute; left: 0; }',
      '.canvas-pin__edge::after { content: "x"; width: 2px; }',
      '.canvas-pin__edge::after { content: "x"; width: 2px; overflow: hidden; }',
      '.canvas-pin__card { font-size: 1000px; } .canvas-pin__edge { width: 0.25em; }',
      '.canvas-pin__card:hover { font-size: 1000px; } .canvas-pin__edge { width: 0.25em; }',
      '.canvas-pin { font-size: 100px; } .canvas-pin__card { font-size: 10em; } .canvas-pin__edge { width: 0.25em; }',
      '.canvas-pin__card { font: 1000px serif; } .canvas-pin__edge { font-size: 100%; width: 0.25em; }',
      '.canvas-pin__edge { position: static; flex: 0 0 230px; }',
      '.canvas-pin__edge { position: static; flex: 1; }',
      '.canvas-pin__edge { position: static; flex-basis: 230px; }',
      '.canvas-pin__edge { position: static; flex-grow: 1; }',
      // Review 18 NIT-4/5 (fix round 22): a font shorthand an ancestor sets
      // that reaches the edge (the card's own 12px stops one on .canvas-pin;
      // inherit lets it through); a glyph too big, too many, an emoji or pushed.
      '.canvas-pin__card { font: 1000px/1 serif; } .canvas-pin__edge { width: .25em; }',
      '.canvas-pin { font: 1000px/1 serif; } .canvas-pin__card { font-size: inherit; } .canvas-pin__edge { width: .25em; }',
      '.canvas-pin__edge::before { content: "|"; width: 3px; font-size: 5px; }',
      '.canvas-pin__edge::before { content: "||"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge::before { content: "\\1F525"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; letter-spacing: 300px; }',
      '.canvas-pin__card { font-size: 1000px; } .canvas-pin__edge::before { content: "|"; width: 3px; }',
      // Review 19 NIT-5 (PR #200 follow-up 2): paint past the glyph (a stroke,
      // a text-shadow offset, its own, the edge's or inherited), a glyph that
      // is wide at any size, and a face of its own.
      '.canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; -webkit-text-stroke: 40px var(--pin-color); }',
      '.canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; -webkit-text-stroke-width: thick; }',
      '.canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; text-shadow: 300px 0 0 var(--pin-color); }',
      '.canvas-pin__edge { text-shadow: 300px 0 0 var(--pin-color); } .canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge:hover { -webkit-text-stroke: 40px; } .canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; }',
      '.canvas-pin__card { text-shadow: 300px 0 0 var(--pin-color); } .canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; }',
      '.canvas-pin:hover { -webkit-text-stroke: 40px var(--pin-color); } .canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge::before { content: "\\FDFD"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge::before { content: "\\1242B"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge::before { content: "﷽"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge::before { content: "𒐫"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge::before { content: "|\\20DD"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge::before { content: "\\FF37"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; font-family: "Very Wide"; }',
      '.canvas-pin__edge::before { content: "|"; width: 3px; font: 4px/1 "Very Wide", serif; }',
      // Review 19 NIT-6 (PR #200 follow-up 2): a root size change reaches rem widths.
      ':root { font-size: 1000px; } .canvas-pin__edge { width: 0.25rem; }',
      'html { font-size: 1000px; } .canvas-pin__edge { width: 0.25rem; }',
      ':root { font: 1000px/1 serif; } .canvas-pin__edge { width: 0.25rem; }',
      ':root { font-size: 6250%; } .canvas-pin__edge { width: 0.25rem; }',
      'html { font-size: 2em; } .canvas-pin__edge { width: 0.25rem; }',
      ':root:hover { font-size: 1000px; } .canvas-pin__edge { width: 0.25rem; }',
      ':root { font-size: var(--big); } .canvas-pin__edge { width: 0.25rem; }',
      ':root { font-size: 1000px; } .canvas-pin__edge { min-width: 0.25rem; width: 2px; }',
      ':root { font-size: 1000px; } .canvas-pin__edge::before { content: "|"; width: 3px; font-size: 0.25rem; }',
      ':root { font-size: 1000px; } .canvas-pin__edge { font-size: 0.25rem; width: 1em; }',
      // PR #202 review 1 NIT-1: the cases its surviving mutations needed. Two
      // root states (the larger one counts), an ancestor's rem size, a space
      // and a Latin-1 glyph, and a generic family listed before a named face.
      ':root { font-size: 16px; } :root:hover { font-size: 1000px; } .canvas-pin__edge { width: 0.25rem; }',
      ':root { font-size: 1000px; } .canvas-pin__card { font-size: 1rem; } .canvas-pin__edge::before { content: "|"; width: 3px; font-size: 0.25em; }',
      '.canvas-pin__edge::before { content: " "; width: 3px; font-size: 4px; word-spacing: 400px; }',
      '.canvas-pin__edge::before { content: "Æ"; width: 3px; font-size: 4px; }',
      '.canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; font-family: serif, "Very Wide"; }',
    ]) expect(frameFindings(pinDelete, vars0, css), css).not.toEqual([]);
    // The edge in other units, and borders the fill stops short of, stay the edge.
    for (const css of [
      '.canvas-pin__edge { width: 0.25rem; }',
      '.canvas-pin__edge { width: 0.1875em; }',
      '.canvas-pin__edge { zoom: 1; filter: none; }',
      '.canvas-pin__edge { border-right: 200px solid transparent; background-clip: padding-box; }',
      '.canvas-pin__edge { border-left: 1px solid transparent; }',
      '.canvas-pin__edge { font-size: 12px; width: 0.25em; }',
      '.canvas-pin__edge::after { content: ""; }',
      '.canvas-pin__edge::after { content: "x"; position: absolute; width: 2px; overflow: hidden; }',
      '.canvas-pin__edge { font: 12px/1 sans-serif; width: 0.25em; }',
      '.canvas-pin__card { font-size: 12px; } .canvas-pin__edge { width: 0.25em; }',
      '.canvas-pin__edge { flex: none; }',
      '.canvas-pin__edge { flex: 0 0 3px; }',
      // Review 18 NIT-5: one 4 px glyph, unclipped, is no wider than the edge.
      '.canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; }',
      // An ancestor's font that the card's own 12px stops.
      '.canvas-pin { font: 1000px/1 serif; } .canvas-pin__edge { width: .25em; }',
      // Review 19 NIT-5/6 (PR #200 follow-up 2): no paint past the glyph, a
      // generic family, and rems at a root size that keeps them narrow.
      '.canvas-pin__edge::before { content: "|"; width: 3px; font-size: 4px; text-shadow: none; -webkit-text-stroke: 0; }',
      '.canvas-pin__edge::before { content: "|"; width: 3px; font: 4px serif; }',
      '.canvas-pin__edge::before { content: "\\7C"; width: 3px; font-size: 4px; }',
      ':root { font-size: 16px; } .canvas-pin__edge { width: 0.25rem; }',
      ':root { font-size: 12px; } .canvas-pin__edge { width: 0.3rem; }',
      'html { font-size: 50%; } .canvas-pin__edge { width: 0.5rem; }',
      ':root { font-size: 1000px; } .canvas-pin__edge { width: 3px; }',
      ':root { font-size: 1000px; } .canvas-pin__edge { width: 0.25em; }',
    ]) expect(frameFindings(pinDelete, vars0, css), css).toEqual([]);
    // Resolved: the author's colour, with only its blue fallback.
    const resolvedDelete = { ...pinDelete, ancestors: [['div', ['canvas-pin', 'canvas-pin--resolved']], ['div', ['canvas-pin__card']]] as Array<[string, string[]]> };
    expect(frameFindings(resolvedDelete, vars0, '.canvas-pin--resolved .canvas-pin__edge { background: var(--agent-color, #ff5a1f); }')).not.toEqual([]);
    expect(frameFindings(resolvedDelete, vars0, '.canvas-pin--resolved .canvas-pin__edge { background: var(--agent-color, #5b9dff); }')).toEqual([]);
    // A lookalike class beside Delete note is no status edge.
    const lookalike = { ...pinDelete, near: [['span', ['canvas-pin__edge-glow'], []], ['div', ['canvas-pin__card-actions'], []]] as JsxTree[] };
    for (const css of [
      '.canvas-pin__edge-glow { background: var(--pin-color); }',
      '.canvas-pin__card-actions { background: var(--pin-color); }',
    ]) expect(frameFindings(lookalike, vars0, css), css).not.toEqual([]);
    // The Delete row itself is never tinted: a presence fill on it is caught as its own colour.
    expect(cascadeFindings(pinDelete, vars0, '.canvas-pin__delete:hover { background: var(--pin-color); }')).not.toEqual([]);
    for (const css of [
      '.canvas-pin__edge { --pin-color: #ff5a1f; background: var(--pin-color); }',
      '.canvas-pin--resolved .canvas-pin__edge { background: var(--agent-color, #5b9dff); }',
      '.canvas-pin__card .canvas-pin__edge { background: var(--pin-color); }',
      '.canvas-pin__card { color: #e8e8e8; border: 1px solid currentColor; }',
    ]) expect(frameFindings(pinDelete, vars0, css), css).toEqual([]);
    for (const css of [
      '.probe-box { border: 1px solid var(--sr-edge-strong); background: var(--sr-surface-control); }',
      '.probe-box { border: 1px solid #383838; background: #1e1e1e; }',
      '.probe-row { border-color: var(--sr-danger-edge); background: var(--sr-danger-tint); }',
      // A focus ring is the keyboard-ring rule's to judge, not a frame.
      '.probe-row:focus-visible { outline: 2px solid var(--sr-accent); }',
      // focus_visible_box (reviews 13-17): left open on purpose (GM r17,
      // kept in GM r31). An ancestor's own keyboard ring, even a warm one
      // round a red control, belongs to the ring rule, so this check passes it.
      // Closing it would reverse r17; that takes a new GM ruling.
      'body.app-slava-restraint .probe-box:focus-visible { outline: 2px solid #ff5a1f; }',
    ]) expect(frameFindings(forget, vars0, css), css).toEqual([]);
    // A neutral control may sit in a warning box; only red ones are framed.
    expect(frameFindings({ ...forget, kind: 'neutral' }, vars0, '.probe-box { border: 1px solid #f5c518; }')).toEqual([]);
  });

  it('every red control looks red: a danger token wins at rest or on hover', () => {
    expect(controls.flatMap((control) => notRedFindings(control))).toEqual([]);
  });

  it('a menu built from data marks each red item danger: true', () => {
    expect(appMenuItemFindings()).toEqual([]);
    expect(menuItemFindings("const items = [{ label: 'Delete', action: del }];", 'probe.tsx')).not.toEqual([]);
    expect(menuItemFindings("const items = [{ label: 'Delete', action: del, danger: true }];", 'probe.tsx')).toEqual([]);
  });

  it('corpus (review 8 LOW-2): every form that hid a control is found', () => {
    const found = (tsx: string) => controlsIn(tsx, 'probe.tsx').map((c) => c.name);
    expect(found('<button>Delete</button>')).toEqual(['Delete']);
    expect(found('<button title="Delete this">x</button>')).toEqual(['Delete this']);
    expect(found('<button type="button" disabled={busy || x > 1} onClick={() => void run(() => act())}>Remove download</button>')).toEqual(['Remove download']);
    expect(found('<button aria-label={"Delete it"}>x</button>')).toEqual(['Delete it']);
    expect(found("const label = 'Delete it'; const A = () => <button aria-label={label}>x</button>;")).toEqual(['Delete it']);
    expect(found('<Button onClick={go}>Delete</Button>')).toEqual(['Delete']);
    expect(found('<div role="button" tabIndex={0}>Delete</div>')).toEqual(['Delete']);
    expect(found('<button>delete it</button>')).toEqual(['delete it']);
    expect(found('<button>Erase</button>')).toEqual(['Erase']);
    expect(found('<button>Empty trash</button>')).toEqual(['Empty trash']);
    expect(found('<button><Trash2 size={14} /> Clear</button>')).toEqual(['Clear']);
    expect(found("function Confirm({ label }: { label: string }) { return <button className=\"x__go\">{label}</button>; }\nconst A = () => <Confirm label=\"Delete forever\" />;"))
      .toEqual(['Delete forever']);
    // A toggle is seen too (review 9 LOW-4: the favourite star, the Erase tool); its words still need a kind.
    expect(found('<button aria-pressed={on} aria-label={on ? "Remove from favorites" : "Add"}>★</button>')).toEqual(['Remove from favorites']);
    expect(controlsIn('<button className="x__action">Delete</button>', 'probe.tsx')[0].kind).toBeNull();
    expect(controlsIn('<button className="x__action x__action--delete">Delete</button>', 'probe.tsx')[0].kind).toBe('red');
    expect(controlsIn('<button className="chip__remove">×</button>', 'probe.tsx')).toEqual([]);
    expect(controlsIn('<button className="chip__remove" aria-label="Remove neon">×</button>', 'probe.tsx')[0].kind).toBe('neutral');
  });

  it('corpus (review 8 LOW-2): every colour form that hid an orange is caught', () => {
    const caught = (css: string) => ruleFindings(css, 'probe.css', customProperties([{ css }]));
    const bad = [
      '.x__delete:hover { color: hsl(15 90% 60%); }',
      '.x__delete:hover { color: oklch(0.7 0.18 45); }',
      '.x__delete:hover { color: darkorange; }',
      '.x__delete:hover { border-color: firebrick; }',
      ...['', '-hover', '-hover-soft', '-border-strong', '-border-soft', '-border-muted', '-border-medium'].map((v) => `.x__delete:hover { color: var(--sr-accent${v}); }`),
      ':root { --c: #ff3b30; } .x__delete:hover { color: var(--c); }',
      '.x__delete:hover { filter: drop-shadow(0 0 2px #ff3b30); }',
      '[data-action="delete"]:hover { color: #ff5a1f; }',
      '[aria-label^="Delete"]:hover { color: #ff5a1f; }',
      '.x { &__delete:hover { color: orange; } }',
      '.x__delete:hover { color: var(--sr-danger-ink, #ff5a1f); }',
      '.x__erase:hover { color: #ff5a1f; }',
      '.x__forget:hover { color: #ff5a1f; }',
      '.x__bin:hover { color: #ff5a1f; }',
      '.x__delete:hover { color: var(--sr-danger); }',
      '.x__remove:hover { color: var(--sr-danger-ink, #ff887d); }',
      '.x__reset:hover { color: var(--sr-accent); }',
    ];
    for (const css of bad) expect(caught(css), css).not.toEqual([]);
    // Review 8's false flags stay quiet, and so do the tokens.
    const good = [
      '.save-status--cleared { color: #f59e0b; }',
      '.tool--remove-bg:hover { color: var(--sr-accent); }',
      '.asset-trash__count { color: var(--sr-accent); }',
      '.panel--danger .panel__run { color: var(--sr-accent); }',
      '.picker__clear-selection:focus-visible { outline: 2px solid var(--sr-accent); }',
      '.x__delete:focus-visible { outline: 2px solid var(--sr-accent); }',
      '.preset-card { background: hsl(20 90% 50%); }',
      '.x__danger { background: var(--sr-danger-fill, #ff887d); color: var(--sr-on-danger, #1f1f1f); }',
      '.x--danger:hover { background: var(--sr-danger-tint); border-color: var(--sr-danger-edge); color: var(--sr-danger-ink, #ff887d); }',
      '.x__delete:active { color: var(--sr-danger-ink-hover, #ff9a91); }',
      '.x__remove:hover { background: var(--sr-surface-control-hover); color: var(--sr-ink-bold); }',
      '.x__remove { background: rgba(0, 0, 0, 0.6); color: #fff; }',
    ];
    for (const css of good) expect(caught(css), css).toEqual([]);
  });

  it('corpus: the cascade check catches a shared class\'s hover winning over a control\'s own', () => {
    const vars0 = customProperties(appCss());
    // Moodboard Studio's Delete as review 8 found it: only the shared toolbar class (amber on hover).
    const before = { file: 'probe.tsx', line: 1, name: 'Delete', kind: 'red' as const, classes: ['moodboard-studio-toolbar__button'], ancestors: [] as Array<[string, string[]]> };
    expect(cascadeFindings(before, vars0).join('\n')).toMatch(/#f59e0b/);
    expect(cascadeFindings({ ...before, classes: ['moodboard-studio-toolbar__button', 'moodboard-studio-toolbar__button--delete'] }, vars0)).toEqual([]);
    // A neutral × that only had its parent's accent-bordered button rule.
    const upload = { file: 'probe.tsx', line: 1, name: 'Remove upload', kind: 'neutral' as const, classes: ['x__remove'], ancestors: [['div', ['cinema-reference-upload__actions']]] as Array<[string, string[]]> };
    expect(cascadeFindings(upload, vars0).join('\n')).toMatch(/--sr-accent/);
    expect(cascadeFindings({ ...upload, classes: ['cinema-upload__remove'] }, vars0)).toEqual([]);
    // A red class with nothing red behind it.
    expect(notRedFindings({ ...before, classes: ['x__action--delete'] })).not.toEqual([]);
  });

  it('review 10 NIT-4: the label forms it missed are read', () => {
    const found = (tsx: string, file = 'probe.tsx') => controlsIn(tsx, file).map((c) => c.name);
    expect(found('const L = { del: "Delete" }; const A = () => <button className="x__go" aria-label={L.del}>x</button>;')).toEqual(['Delete']);
    expect(found('const label = () => "Delete"; const A = () => <button className="x__go" aria-label={label()}>x</button>;')).toEqual(['Delete']);
    expect(found('function label() { if (a) return "Deleting…"; return "Delete"; } const A = () => <button className="x__go">{label()}</button>;')).toEqual(['Deleting… Delete']);
    expect(found('const A = () => <button className="x__go" aria-label={t("btn.rm")}>x</button>;')).toEqual(['btn remove']);
    expect(found('const A = () => <button className="x__go" aria-label={t("actions.delete_project")}>x</button>;')).toEqual(['actions delete project']);
    // Icon-only, no words a person reads: its icon or its handler names it.
    expect(found('const A = () => <button className="x__go" onClick={() => deleteProject(id)}><Trash2 /></button>;')).toEqual(['Trash']);
    expect(found('const A = () => <button className="x__go" onClick={() => deleteProject(id)}><X /></button>;')).toEqual(['delete Project']);
    expect(found('const A = ({ name }) => <button className="x__go" title={`${name}`} onClick={wipeIt}><Ban /></button>;')).toEqual(['wipe It']);
    expect(found('const A = () => <button className="x__go" dangerouslySetInnerHTML={{ __html: "<b>Delete</b>" }} />;')).toEqual(['Delete']);
    // A component imported from a file outside the set is read from disk (CopyValueButton forwards its label).
    expect(found('import { CopyValueButton } from "./ExpandableBlock"; const A = () => <CopyValueButton label="Delete it" text={() => ""} />;',
      'components/nodes/Probe.tsx')).toEqual(['Delete it']);
    // A menu item object, any label form, any handler name.
    expect(menuItemFindings('const items = [{ label: "Delete", onSelect: del }];', 'p.tsx')).not.toEqual([]);
    expect(menuItemFindings('const L = () => "Delete"; const items = [{ label: L(), onClick: del }];', 'p.tsx')).toEqual([]);
    expect(menuItemFindings('const items = [{ label: "Delete", onSelect: del, danger: true }];', 'p.tsx')).toEqual([]);
    // Still quiet: a bare ×, a card's content, a call's arguments.
    expect(found('<button className="chip__remove">×</button>')).toEqual([]);
    expect(found('const A = () => <button className="x__go" aria-label={nameOf(removedNode())}>x</button>;')).toEqual([]);
  });

  it('review 11 NIT-4: the label forms and toggle states it still missed', () => {
    const found = (tsx: string) => controlsIn(tsx, 'probe.tsx').map((c) => c.name);
    expect(found('const L = { a: { del: "Delete" } }; const A = () => <button className="x__go" aria-label={L.a.del}>x</button>;')).toContain('Delete');
    expect(found('const L = { del: "Delete" }; const A = () => <button className="x__go" aria-label={L["del"]}>x</button>;')).toContain('Delete');
    expect(found('const A = () => <button className="x__go" aria-label={t("deleteProject")}>x</button>;')).toEqual(['delete Project']);
    expect(found('const A = () => <button className="x__go" onClick={go}><Eraser /></button>;')).toEqual(['Erase']);
    expect(found('const html = "<b>Delete</b>"; const A = () => <button className="x__go" dangerouslySetInnerHTML={{ __html: html }} />;')).toEqual(['Delete']);
    expect(menuItemFindings('const items = [{ title: "More", text: "Delete", onSelect: del }];', 'p.tsx')).not.toEqual([]);
    // Still quiet: a computed key, a camelCase word that names no action.
    expect(found('const A = () => <button className="x__go" aria-label={L[key]}>x</button>;')).toEqual([]);
    expect(found('const A = () => <button className="x__go" aria-label={t("openProject")}>x</button>;')).toEqual([]);

    const vars0 = customProperties(appCss());
    const star = { file: 'p.tsx', line: 1, name: 'Remove from favorites', kind: 'neutral' as const, toggle: true,
      classes: ['x__star', 'x__star--fav', 'x__favorite-remove'], ancestors: [] };
    // An off toggle's accent by its attribute, and on its icon.
    expect(cascadeFindings(star, vars0, '.x__star[aria-pressed="false"]:hover { color: var(--sr-accent); }').some((f) => / \(off\) :hover color/.test(f))).toBe(true);
    expect(cascadeFindings(star, vars0, '.x__star:not(.x__star--fav):hover svg { fill: var(--sr-accent); }').some((f) => / \(off\) :hover svg fill/.test(f))).toBe(true);
    // --fav and is-on are on-state names: on, the accent is its state.
    expect(cascadeFindings(star, vars0, '.x__star--fav { color: var(--sr-accent); }')).toEqual([]);
    const isOn = { ...star, classes: ['x__star', 'is-on'] };
    expect(cascadeFindings(isOn, vars0, '.x__star.is-on { color: var(--sr-accent); }')).toEqual([]);
    expect(cascadeFindings(isOn, vars0, '.x__star:hover { color: var(--sr-accent); }').some((f) => / \(off\) :hover color/.test(f))).toBe(true);
    // A red control's icon in the accent is caught too.
    const del = { file: 'p.tsx', line: 1, name: 'Delete', kind: 'red' as const, classes: ['x__delete'], ancestors: [] };
    expect(cascadeFindings(del, vars0, '.x__delete:hover svg { stroke: var(--sr-accent); }').join('\n')).toMatch(/:hover svg stroke/);
  });

  it('review 10 LOW-1 (GM r17 item 1): a toggle may be the accent only when on; off, hovering it can\'t look on', () => {
    const vars0 = customProperties(appCss());
    const star = { file: 'p.tsx', line: 1, name: 'Remove from favorites', kind: 'neutral' as const, toggle: true,
      classes: ['x__star', 'x__star--active', 'x__favorite-remove'], ancestors: [] };
    // Round 10's rule: hover and on shared the accent.
    const shared = 'body.app-slava-restraint .x__star:hover, body.app-slava-restraint .x__star--active { color: var(--sr-accent); }';
    expect(cascadeFindings(star, vars0, shared).some((f) => / \(off\) :hover color: /.test(f))).toBe(true);
    expect(cascadeFindings(star, vars0, shared).some((f) => / \(on\) /.test(f))).toBe(false);
    // Split: off hovers in neutral ink, on is the accent hovered or not.
    const split = 'body.app-slava-restraint .x__star:hover:not(.x__star--active) { color: var(--sr-ink-bold); }'
      + ' body.app-slava-restraint .x__star--active, body.app-slava-restraint .x__star--active:hover { color: var(--sr-accent); }';
    expect(cascadeFindings(star, vars0, split)).toEqual([]);
    // The real star.
    const real = appControls().filter((c) => c.file === 'components/panels/Inspector.tsx' && c.toggle);
    expect(real.length).toBeGreaterThan(0);
    for (const control of real) expect(cascadeFindings(control, vars0)).toEqual([]);
    expect(real.every((c) => c.classes.includes('inspector__favorite-button--active'))).toBe(true);
  });
});
