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
  const scope = { root, file, locals, imports };
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

/** The exported function `name` of a module, as a node to follow. Only a
 * function: a store (`create(…)`) is reached by its members already. */
function exportedFunction(scope: Scope, name: string): ts.Node | null {
  for (const node of scope.locals.get(name) ?? []) {
    if (ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node;
  }
  return null;
}

/** The names a node reaches: identifiers it names (members included),
 * through the file's own definitions and one level into imported functions. */
function reachOf(node: ts.Node, scope: Scope, resolve: Resolve | undefined, seen: Set<string>, depth = 0): Set<string> {
  const names = new Set<string>();
  const visit = (current: ts.Node) => {
    if (ts.isIdentifier(current)) {
      const name = current.text;
      const local = scope.locals.get(name);
      if (local && isReference(current)) {
        const key = `${scope.file}#${name}`;
        if (!seen.has(key)) { seen.add(key); for (const inner of local) for (const reached of reachOf(inner, scope, resolve, seen, depth)) names.add(reached); }
        return;
      }
      names.add(name);
      const imported = scope.imports.get(name);
      if (imported && depth === 0 && resolve && isReference(current) && imported.specifier.startsWith('.')) {
        const module = resolve(imported.specifier, scope.file);
        if (module) {
          const inner = scopeOf(module.source, module.file);
          const target = exportedFunction(inner, imported.imported);
          const key = `${module.file}#${imported.imported}`;
          if (target && !seen.has(key)) { seen.add(key); for (const reached of reachOf(target, inner, resolve, seen, depth + 1)) names.add(reached); }
        }
      }
      return;
    }
    if (ts.isElementAccessExpression(current) && ts.isStringLiteralLike(current.argumentExpression)) names.add(current.argumentExpression.text);
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

function lockAttribute(attribute: ts.JsxAttributeLike, scope: Scope): boolean {
  if (ts.isJsxSpreadAttribute(attribute)) return isLockExpression(attribute.expression, scope);
  if (isHandlerName(attribute.name.getText(scope.root))) return false;
  const value = attribute.initializer;
  if (!value || !ts.isJsxExpression(value) || !value.expression) return false;
  return isLockExpression(value.expression, scope);
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
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes = node.attributes.properties;
      const handlers = attributes.filter((attribute) => (ts.isJsxAttribute(attribute) && isHandlerName(attribute.name.getText(root)))
        || (ts.isJsxSpreadAttribute(attribute) && !lockAttribute(attribute, scope)));
      const reached = new Set<string>();
      for (const handler of handlers) for (const name of reachOf(handler, scope, resolve, new Set())) reached.add(name);
      const hits = [...reached].filter((name) => GATED.has(name));
      if (hits.length > 0) {
        const tag = node.tagName.getText(root);
        const own = attributes.some((attribute) => lockAttribute(attribute, scope));
        let fenced = false;
        for (let up: ts.Node | undefined = node.parent; up && !fenced; up = up.parent) {
          if (ts.isJsxElement(up) && up.openingElement !== node) fenced = up.openingElement.attributes.properties.some((attribute) => lockAttribute(attribute, scope));
        }
        const refusesInHandler = !CONTROL_TAGS.has(tag) && /^[a-z]/.test(tag) && (reached.has('refuseCanvasEdit') || reached.has('refuseEditWhileFollowing'));
        if (!own && !fenced && !refusesInHandler) {
          const { line } = root.getLineAndCharacterOfPosition(node.getStart(root));
          found.push(`${file}:${line + 1} <${tag}> ${hits.sort().join(', ')}`);
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
};

/** Components that take the lock themselves for the gated handler they are
 * given (a menu's rows, a modal's Save): the call site needs no lock. Each
 * one's file reads the lock, and a render test shows it locked
 * (agentPresenceFollowups.r2 L-5). */
const LOCKED_COMPONENTS: Record<string, { file: string; reason: string }> = {
  AssetItem: { file: 'components/panels/AssetsPanel.tsx', reason: 'Add to canvas and the drag take the lock (round 23)' },
  ProviderSwitcher: { file: 'components/nodes/ProviderSwitcher.tsx', reason: 'every provider row, fix and switch row takes the lock (fix round 2 of PR #200)' },
  MaskPainterModal: { file: 'components/panels/MaskPainterModal.tsx', reason: 'Save Mask takes the lock (fix round 2 of PR #200)' },
  ForgetRecoveryConfirm: { file: 'components/panels/ForgetRecoveryConfirm.tsx', reason: 'Forget takes the lock (fix round 2 of PR #200)' },
};

const allowed = (line: string) => {
  const match = /^(.*?):\d+ <([\w.]+)> (.*)$/.exec(line);
  if (!match) return false;
  const [, file, tag, hits] = match;
  if (CONTROL_ALLOWLIST[`${file} <${tag}>`]) return true;
  if (LOCKED_COMPONENTS[tag] && READS_LOCK.test(readFileSync(join(SRC, LOCKED_COMPONENTS[tag].file), 'utf8'))) return true;
  return hits.split(', ').every((hit) => CONTROL_ALLOWLIST[`${file}: ${hit}`]);
};

// Parsing every source file is slow under load: a generous limit.
describe('L-4: every file that reaches a gated action reads the canvas lock', { timeout: 120_000 }, () => {
  const files = walk(SRC, /\.tsx?$/).filter((path) => !path.endsWith('store/graphStore.ts'))
    .map((path) => ({ path, file: relative(SRC, path), source: readFileSync(path, 'utf8') }));
  const stores = storeNames(files);
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
    const found = files.filter(({ path, source }) => path.endsWith('.tsx') && READS_LOCK.test(source))
      .flatMap(({ file, source }) => unlockedControls(source, file, resolveSource))
      .filter((line) => !allowed(line));
    expect(found).toEqual([]);
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
const FILL_TOKEN = /background(?:-color)?\s*:\s*var\(--(?:sr-accent|sr-error|sr-danger|sr-ink|sr-ink-bold|an-ink)\b/i;
/** Fix round 2 of PR #200 (review 2, M-3 and L-5): the colour forms a
 * fill is written in: hex, rgb()/rgba() (comma or space syntax, alpha as a
 * number or %), hsl()/hsla(), white, and a gradient's first stop
 * (background or background-image). A colour with alpha under 0.5 is a
 * translucent surface, no fill. */
function parseColor(raw: string): { r: number; g: number; b: number; a: number } | null {
  const value = raw.trim().toLowerCase();
  if (/^white\b/.test(value)) return { r: 255, g: 255, b: 255, a: 1 };
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\b/.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const [r, g, b] = [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16));
    const a = full.length === 8 ? Number.parseInt(full.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)/.exec(value);
  if (!fn) return null;
  const parts = fn[2].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
  const num = (part: string | undefined, scale: number) => (part === undefined ? NaN
    : part.endsWith('%') ? Number.parseFloat(part) / 100 * scale : Number.parseFloat(part));
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? Number.parseFloat(parts[3]) / 100 : Number.parseFloat(parts[3]);
  if (fn[1].startsWith('rgb')) {
    const [r, g, b] = [0, 1, 2].map((at) => num(parts[at], 255));
    return [r, g, b, alpha].some(Number.isNaN) ? null : { r, g, b, a: alpha };
  }
  const h = Number.parseFloat(parts[0]); const sat = num(parts[1], 1); const light = num(parts[2], 1);
  if ([h, sat, light, alpha].some(Number.isNaN)) return null;
  const k = (n: number) => (n + h / 30) % 12;
  const f = (n: number) => light - sat * Math.min(light, 1 - light) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255, a: alpha };
}
function solidFill(body: string): boolean {
  if (FILL_TOKEN.test(body) || /background(?:-image)?\s*:[^;]*gradient\([^;]*var\(--(?:sr-accent|sr-error|sr-danger|sr-ink)\b/i.test(body)) return true;
  const declared = /(?:^|;)\s*background(?:-color|-image)?\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim().toLowerCase() ?? '';
  // A gradient's first stop.
  const value = /gradient\(/.test(declared) ? declared.replace(/^[^(]*gradient\(\s*(?:(?:to [a-z ]+|-?[\d.]+deg|circle|ellipse)[^,]*,\s*)?/, '') : declared;
  const color = parseColor(value);
  if (!color || color.a < 0.5) return false;
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
      for (const one of selector.split(',')) {
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
  const filledRule = rules.find(({ selector, body }) => /:disabled/.test(selector) && /background:\s*var\(--sr-disabled-fill/.test(body));
  const unfilledRule = rules.find(({ selector, body }) => /:disabled/.test(selector) && /background:\s*transparent/.test(body));
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
        for (const one of selector.split(',')) {
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

  it('M-1: the disabled outline is the plain edge (0.06), never the brighter 0.12; M-3: a disabled toast action never changes on hover', () => {
    const tokens = cssTokens();
    expect(parseColor(resolveVar('var(--sr-disabled-edge)', tokens))?.a).toBeCloseTo(0.06, 3);
    for (const name of ['canvas-undo-notice__action', 'moodboard-board-toast__action']) {
      const hovers = walk(SRC, /\.css$/).flatMap((path) => cssRules(readFileSync(path, 'utf8')).flatMap(({ selector }) => selector.split(',')))
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
      for (const one of selector.split(',').map((part) => part.trim())) {
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
      else if (property === 'background' || property === 'background-color') look.background = value;
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

/** Controls whose look isn't a text label: what they show (GM answer 6). */
const NO_LABEL: Record<string, string> = {
  'cinema-shot-panel__variation': 'an image thumbnail: its outline is its look',
  'remotion-properties-panel__anchor-button': 'an empty 18 px anchor cell: its outline and fill are its look',
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
  for (const { classes, body } of lists) {
    const filled = /var\(--sr-disabled-fill/.test(/background:[^;]*/.exec(body)?.[0] ?? '');
    for (const className of classes) {
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
      if (!NO_LABEL[className]) {
        if (!label) problem = `no resting label colour found (${JSON.stringify(look)})`;
        else if (filled && FILL_SHOWS_STATE[className]) {
          if (contrast(bg, CANVAS) <= contrast(disabledBg, CANVAS)) problem = 'its fill is no brighter than the grey fill';
          // The list stays true: only labels that really are under the grey's.
          else if (disabledLabel < enabledLabel) problem = 'its label is brighter than the grey: drop it from FILL_SHOWS_STATE';
        } else if (disabledLabel >= enabledLabel) problem = `disabled label ${disabledLabel.toFixed(2)}:1 is not dimmer than enabled ${enabledLabel.toFixed(2)}:1`;
      }
      if (!problem && disabledEdge > enabledEdge + 1e-6) problem = `disabled edge ${disabledEdge.toFixed(2)}:1 is brighter than enabled ${enabledEdge.toFixed(2)}:1`;
      rows.push({ className, enabled: { label: enabledLabel, edge: enabledEdge }, disabled: { label: disabledLabel, edge: disabledEdge }, problem });
    }
  }
  return rows;
}
