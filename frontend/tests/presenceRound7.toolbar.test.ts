/**
 * GM r8 (3), PR #204 round 7: no refusal or error sentence in a toolbar row. A screen's lines go
 * to the app's notice region (notify, InNoticeRegion); a toolbar row holds controls and states.
 * The ratchet reads every component: inside a toolbar row (a WorkspaceHeader, or an element whose
 * class names a toolbar, a topbar or a header bar), no `role="alert"` and no child expression
 * that reads an error, a refusal or a failure.
 *
 * Round 9 (review 7 LOW-3) makes it structural, what a row may render: no line component at all
 * (LineText, FailureLines, CommonsErrorLine: tests/lineRegistration.ratchet.test.ts sends every
 * line through one, so a line can't hide behind a neutral name), no sentence in literal text, no
 * `dangerouslySetInnerHTML`, no alert role through a spread; a local helper's call is read
 * through its return values, and a row's class is read from a constant, a helper's literals and
 * a template's text too.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');

function tsxFiles(dir = SRC): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') && !name.includes('.test.') ? [path] : [];
  });
}

const ROW_CLASS = /(?:^|[\s_-])(?:toolbar|topbar|header-bar)(?:$|[\s_-])|__topbar\b|__toolbar\b/;
const ROW_TAGS = new Set(['WorkspaceHeader']);
const SAYS_FAILURE = /(?:error|refus|fail)/i;

/** A const's string value in the same file (`const BAR = 'canvas-toolbar'`), for a class read from it (T10). */
function constText(name: ts.Identifier): string {
  const source = name.getSourceFile();
  let found = '';
  const look = (node: ts.Node) => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name.text && node.initializer) {
      found = classWords(node.initializer, false);
      return;
    }
    ts.forEachChild(node, look);
  };
  look(source);
  return found;
}

/** Every word a class expression can hold: literals, a template's text (T14), a helper's
 * arguments (T15), a constant's value (T10), each part apart. */
function classWords(expression: ts.Node, follow = true): string {
  const words: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) { words.push(node.text); return; }
    if (ts.isTemplateExpression(node)) {
      words.push(node.head.text);
      for (const span of node.templateSpans) { walk(span.expression); words.push(span.literal.text); }
      return;
    }
    if (follow && ts.isIdentifier(node)) { words.push(constText(node)); return; }
    ts.forEachChild(node, walk);
  };
  walk(expression);
  return words.join(' ');
}

function className(element: ts.JsxOpeningLikeElement): string {
  for (const attr of element.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name) || attr.name.text !== 'className' || !attr.initializer) continue;
    if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
    if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) return classWords(attr.initializer.expression);
  }
  return '';
}

/** The components that render a line (tests/lineRegistration.ratchet.test.ts): none belongs in a row. */
const LINE_TAGS = new Set(['LineText', 'FailureLines', 'CommonsErrorLine']);
/** PR #204 round 11 (GM r18): a lock's own line ("You can <verb> when this tab is connected as
 * you.", made from its verb alone: components/PersonLock) describes the control it sits under, so a
 * locked control in a row (the Commons' Add) keeps it there. It holds no refusal or failure. */
const LOCK_LINE_TAGS = new Set(['PersonLockLine']);
/** A sentence in literal text (T17): a capital, a space, and a full stop, ! or ?. A label ("Saved",
 * "Save failed") or a state or menu item that trails off ("Preparing generation…", "Clear canvas…") isn't one. */
const SENTENCE = /^[A-Z“"].*\s.*[.!?]["”]?$/s;

/** A popover or dialog opened from the row is its own surface, with its own lines. */
function ownSurface(node: ts.Node): boolean {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  if (!opening) return false;
  return opening.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name)
    && attr.name.text === 'role' && !!attr.initializer && ts.isStringLiteral(attr.initializer)
    && /^(?:dialog|alertdialog|menu|listbox)$/.test(attr.initializer.text));
}

/** Round 8 (review 6 LOW-4, T3): helpers whose call is a refusal or failure sentence, whatever the name it lands in. */
const SENTENCE_CALLS = new Set(['notConnectedBecause', 'personRequiredCopy', 'markReadRefusedCopy', 'failureMessage',
  'failureCopy', 'failureUnder', 'generateRefusedCopy']);
const isFunctionLike = (node: ts.Node): node is ts.FunctionLikeDeclaration =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);

/** The string literals an attribute's value can take (`"alert"`, `{'alert'}`, `{x ? 'alert' : 'status'}`). */
function literalsOf(initializer: ts.JsxAttributeValue | undefined): string[] {
  if (!initializer) return [];
  if (ts.isStringLiteral(initializer)) return [initializer.text];
  const found: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node)) found.push(node.text);
    ts.forEachChild(node, walk);
  };
  walk(initializer);
  return found;
}

interface Unit { path: string; source: ts.SourceFile }

/** Each offending part inside a toolbar row, as `file:line text`. */
export function toolbarFailures(files: { path: string; text: string }[]): string[] {
  const units: Unit[] = files.map(({ path, text }) => ({ path, source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX) }));
  const unitOf = (node: ts.Node) => units.find((unit) => unit.source === node.getSourceFile())!;
  // Every component declared in the files (a function, or a const holding one), and every JSX use.
  const components = new Map<string, ts.FunctionLikeDeclaration[]>();
  const uses = new Map<string, ts.JsxOpeningLikeElement[]>();
  const imports = new Map<ts.SourceFile, Map<string, string>>();
  // `const WorldPreview = memo(WorldPreviewComponent)`: uses of the one are uses of the other.
  const aliases = new Map<string, string[]>();
  for (const { source } of units) {
    const named = new Map<string, string>();
    imports.set(source, named);
    const index = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) components.set(node.name.text, [...(components.get(node.name.text) ?? []), node]);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        let init: ts.Node = node.initializer;
        while (ts.isCallExpression(init) && init.arguments[0]) init = init.arguments[0]; // memo(...), forwardRef(...)
        if (isFunctionLike(init)) components.set(node.name.text, [...(components.get(node.name.text) ?? []), init]);
        if (ts.isIdentifier(init) && init !== node.initializer) aliases.set(init.text, [...(aliases.get(init.text) ?? []), node.name.text]);
      }
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ts.isIdentifier(node.tagName)) {
        uses.set(node.tagName.text, [...(uses.get(node.tagName.text) ?? []), node]);
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause) {
        const from = node.moduleSpecifier.text;
        if (node.importClause.name) named.set(node.importClause.name.text, from);
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) named.set(item.name.text, from);
      }
      ts.forEachChild(node, index);
    };
    index(source);
  }

  const bad: string[] = [];
  const where = (node: ts.Node) => {
    const { path, source } = unitOf(node);
    return `${relative(SRC, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  };

  /** The declaration `name` refers to at `from`: the innermost scope's variable or parameter. */
  function declarationOf(name: string, from: ts.Node): ts.Node | null {
    for (let scope: ts.Node | undefined = from.parent; scope; scope = scope.parent) {
      if (!isFunctionLike(scope) && !ts.isSourceFile(scope)) continue;
      let found: ts.Node | null = null;
      const look = (node: ts.Node) => {
        if (found) return;
        if (node !== scope && isFunctionLike(node)) return;
        if ((ts.isVariableDeclaration(node) || ts.isBindingElement(node) || ts.isParameter(node))
          && ts.isIdentifier(node.name) && node.name.text === name) { found = node; return; }
        ts.forEachChild(node, look);
      };
      if (isFunctionLike(scope)) { for (const parameter of scope.parameters) look(parameter); if (scope.body) look(scope.body); } else look(scope);
      if (found) return found;
    }
    return null;
  }

  /** The component a parameter belongs to, by name. */
  function componentName(fn: ts.FunctionLikeDeclaration): string | null {
    if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
    let node: ts.Node = fn.parent;
    while (ts.isCallExpression(node)) node = node.parent;
    return ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : null;
  }

  /**
   * What a value rendered as text can say (round 8, T4): the names it reads, and where a neutral
   * name gets its value (a local, a state's setter calls, the prop its component's uses pass).
   * Only the value's own path: a condition (`a ? b : c`'s `a`, `a && b`'s `a`, a comparison) and
   * a key (`labels[state]`) aren't what is shown, and a handler isn't a line. A store selector
   * (`useStore((s) => s.lastRunFailure)`) is read, as JSX it yields is read as the row's.
   */
  function reads(expression: ts.Node, said: string[], seen: Set<ts.Node>, depth = 0): void {
    if (depth > 4 || seen.has(expression)) return;
    seen.add(expression);
    const read = (part: ts.Node): void => {
      if (ts.isArrowFunction(part) || ts.isFunctionExpression(part)) {
        const call = part.parent;
        if (ts.isArrowFunction(part) && !ts.isBlock(part.body) && ts.isCallExpression(call)
          && /^use[A-Z]/.test(ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : call.expression.getText())) read(part.body);
        return;
      }
      if (ts.isJsxElement(part) || ts.isJsxSelfClosingElement(part) || ts.isJsxFragment(part)) { inRow(part); return; }
      if (ts.isJsxAttributes(part)) return;
      if (ts.isParenthesizedExpression(part) || ts.isAsExpression(part) || ts.isNonNullExpression(part)) { read(part.expression); return; }
      if (ts.isConditionalExpression(part)) { read(part.whenTrue); read(part.whenFalse); return; }
      if (ts.isBinaryExpression(part)) {
        const op = part.operatorToken.kind;
        if (op === ts.SyntaxKind.AmpersandAmpersandToken) { read(part.right); return; }
        if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.PlusToken) {
          read(part.left); read(part.right);
        }
        return; // a comparison or arithmetic: not text
      }
      if (ts.isPrefixUnaryExpression(part)) return;
      if (ts.isObjectLiteralExpression(part)) {
        // Its values, not its keys.
        for (const property of part.properties) {
          if (ts.isPropertyAssignment(property)) read(property.initializer);
          else if (ts.isShorthandPropertyAssignment(property)) read(property.name);
          else if (ts.isSpreadAssignment(property)) read(property.expression);
        }
        return;
      }
      if (ts.isElementAccessExpression(part)) { read(part.expression); return; }
      if (ts.isCallExpression(part)) {
        const callee = ts.isIdentifier(part.expression) ? part.expression.text
          : ts.isPropertyAccessExpression(part.expression) ? part.expression.name.text : '';
        if (SENTENCE_CALLS.has(callee)) said.push(`${callee}()`);
        // T18 (review 7 LOW-3): a local helper is read through what it returns.
        if (ts.isIdentifier(part.expression)) returnsOf(part.expression, said, seen, depth);
        if (ts.isPropertyAccessExpression(part.expression)) read(part.expression.expression);
        for (const argument of part.arguments) read(argument);
        return;
      }
      if (ts.isPropertyAccessExpression(part)) {
        if (SAYS_FAILURE.test(part.name.text)) said.push(part.name.text);
        read(part.expression);
        return;
      }
      if (ts.isIdentifier(part)) {
        if (SAYS_FAILURE.test(part.text)) said.push(part.text);
        else follow(part, said, seen, depth + 1);
        return;
      }
      ts.forEachChild(part, read);
    };
    read(expression);
  }

  /** What a local function returns, read as text (T18): `function lineFor(x) { return failureMessage(x, 'x'); }`. */
  function returnsOf(name: ts.Identifier, said: string[], seen: Set<ts.Node>, depth: number): void {
    const unit = name.getSourceFile();
    const fns: ts.FunctionLikeDeclaration[] = [];
    const declared = declarationOf(name.text, name);
    if (declared && ts.isVariableDeclaration(declared) && declared.initializer && isFunctionLike(declared.initializer)) fns.push(declared.initializer);
    const look = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === name.text && node.getSourceFile() === unit) fns.push(node);
      ts.forEachChild(node, look);
    };
    if (fns.length === 0) look(unit);
    for (const fn of fns) {
      if (seen.has(fn) || !fn.body) continue;
      seen.add(fn);
      if (!ts.isBlock(fn.body)) { reads(fn.body, said, seen, depth + 1); continue; }
      const returns = (node: ts.Node) => {
        if (node !== fn && isFunctionLike(node)) return;
        if (ts.isReturnStatement(node) && node.expression) reads(node.expression, said, seen, depth + 1);
        ts.forEachChild(node, returns);
      };
      returns(fn.body);
    }
  }

  function follow(name: ts.Identifier, said: string[], seen: Set<ts.Node>, depth: number): void {
    const declaration = declarationOf(name.text, name);
    if (!declaration || seen.has(declaration)) return;
    seen.add(declaration);
    if (ts.isVariableDeclaration(declaration)) {
      if (declaration.initializer) reads(declaration.initializer, said, seen, depth);
      return;
    }
    if (ts.isBindingElement(declaration)) {
      const pattern = declaration.parent;
      let holder: ts.Node = pattern.parent;
      if (ts.isArrayBindingPattern(pattern) && ts.isVariableDeclaration(holder) && holder.initializer
        && ts.isCallExpression(holder.initializer) && /use(?:State|Reducer)$/.test(holder.initializer.expression.getText())) {
        // A state value: what it starts as, and everything its setter is called with.
        reads(holder.initializer, said, seen, depth);
        const setter = pattern.elements[1];
        if (setter && ts.isBindingElement(setter) && ts.isIdentifier(setter.name)) {
          const setterName = setter.name.text;
          const scope = holder.getSourceFile();
          const calls = (node: ts.Node) => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === setterName) {
              for (const argument of node.arguments) reads(argument, said, seen, depth);
            }
            ts.forEachChild(node, calls);
          };
          calls(scope);
        }
        return;
      }
      if (ts.isVariableDeclaration(holder) && holder.initializer) { reads(holder.initializer, said, seen, depth); return; }
      while (ts.isBindingElement(holder) || ts.isObjectBindingPattern(holder) || ts.isArrayBindingPattern(holder)) holder = holder.parent;
      if (ts.isParameter(holder)) {
        const prop = declaration.propertyName && ts.isIdentifier(declaration.propertyName) ? declaration.propertyName.text : name.text;
        props(holder, prop, name, said, seen, depth);
      }
      return;
    }
    if (ts.isParameter(declaration)) props(declaration, null, name, said, seen, depth);
  }

  /** A prop: what every use of its component passes for it. A component no file uses can't be followed. */
  function props(parameter: ts.ParameterDeclaration, prop: string | null, name: ts.Identifier, said: string[], seen: Set<ts.Node>, depth: number): void {
    const fn = parameter.parent;
    if (!isFunctionLike(fn)) return;
    const component = componentName(fn);
    // A callback's parameter (a selector's state, a map's item) isn't a prop: what it reads is read where it is used.
    if (!component || !/^[A-Z]/.test(component)) return;
    const found = [component, ...(aliases.get(component) ?? [])].flatMap((each) => uses.get(each) ?? []);
    if (found.length === 0) { said.push(`${name.text} (a prop no use can be followed for)`); return; }
    for (const use of found) {
      for (const attr of use.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attr)) { reads(attr.expression, said, seen, depth); continue; }
        if (!ts.isIdentifier(attr.name) || (prop !== null && attr.name.text !== prop)) continue;
        if (attr.initializer) reads(attr.initializer.kind === ts.SyntaxKind.JsxExpression ? (attr.initializer as ts.JsxExpression).expression ?? attr.initializer : attr.initializer, said, seen, depth);
      }
    }
  }

  const visitedComponents = new Set<ts.FunctionLikeDeclaration>();
  /** Everything a toolbar row holds, components it renders included (T1), attribute JSX included (T2). */
  function inRow(node: ts.Node): void {
    const visit = (part: ts.Node) => {
      if (ownSurface(part)) return;
      // T7: a role or aria-live through a spread of an object literal.
      if (ts.isJsxSpreadAttribute(part)) {
        const object = ts.isParenthesizedExpression(part.expression) ? part.expression.expression : part.expression;
        if (ts.isObjectLiteralExpression(object)) {
          for (const property of object.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const key = property.name.getText().replace(/['"]/g, '');
            if (key === 'role' && literalsOf(property.initializer as ts.JsxAttributeValue).includes('alert')) bad.push(`${where(part)} role="alert"`);
            if (key === 'aria-live' && literalsOf(property.initializer as ts.JsxAttributeValue).includes('assertive')) bad.push(`${where(part)} aria-live="assertive"`);
          }
        }
      }
      // T17: a sentence in literal text, as JSX text or a literal in an expression.
      if (ts.isJsxText(part) && SENTENCE.test(part.text.trim())) bad.push(`${where(part)} "${part.text.trim()}"`);
      if (ts.isJsxExpression(part) && part.expression && !ts.isJsxAttribute(part.parent) && ts.isStringLiteralLike(part.expression)
        && SENTENCE.test(part.expression.text.trim())) bad.push(`${where(part)} "${part.expression.text.trim()}"`);
      if (ts.isJsxAttribute(part) && ts.isIdentifier(part.name)) {
        const attr = part.name.text;
        // T13: markup set from a string can be any line.
        if (attr === 'dangerouslySetInnerHTML') bad.push(`${where(part)} dangerouslySetInnerHTML`);
        if (attr === 'role' && literalsOf(part.initializer).includes('alert')) bad.push(`${where(part)} role="alert"`);
        if (attr === 'aria-live' && literalsOf(part.initializer).includes('assertive')) bad.push(`${where(part)} aria-live="assertive"`);
        // JSX passed as an attribute (navigation={<span>…</span>}) is in the row too.
        if (part.initializer && ts.isJsxExpression(part.initializer) && part.initializer.expression) {
          const jsx = (inner: ts.Node) => {
            if (ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner) || ts.isJsxFragment(inner)) { visit(inner); return; }
            ts.forEachChild(inner, jsx);
          };
          jsx(part.initializer.expression);
        }
        return;
      }
      if (ts.isJsxExpression(part) && part.expression && !ts.isJsxAttribute(part.parent)) {
        const said: string[] = [];
        reads(part.expression, said, new Set());
        if (said.length > 0) bad.push(`${where(part)} ${[...new Set(said)].join(',')}`);
      }
      if ((ts.isJsxOpeningElement(part) || ts.isJsxSelfClosingElement(part)) && ts.isIdentifier(part.tagName)
        && LINE_TAGS.has(part.tagName.text)) {
        bad.push(`${where(part)} <${part.tagName.text}> (a line)`);
        return;
      }
      if ((ts.isJsxOpeningElement(part) || ts.isJsxSelfClosingElement(part)) && ts.isIdentifier(part.tagName)
        && LOCK_LINE_TAGS.has(part.tagName.text)) {
        // Only its lock: a child or any other attribute could carry a line.
        const attrs = part.attributes.properties;
        const plain = attrs.every((a) => ts.isJsxAttribute(a) && ['lock', 'place', 'className'].includes(a.name.getText()))
          && (ts.isJsxSelfClosingElement(part) || (ts.isJsxElement(part.parent) && part.parent.children.every((c) => ts.isJsxText(c) && !c.text.trim())));
        if (!plain) bad.push(`${where(part)} <${part.tagName.text}> (a lock line with more than its lock)`);
        return;
      }
      if ((ts.isJsxOpeningElement(part) || ts.isJsxSelfClosingElement(part)) && ts.isIdentifier(part.tagName)
        && /^[A-Z]/.test(part.tagName.text) && !ROW_TAGS.has(part.tagName.text)) {
        child(part.tagName);
      }
      ts.forEachChild(part, visit);
    };
    visit(node);
  }

  /** A component inside a row (T1): its own JSX is in the row. One that can't be found fails closed. */
  function child(tag: ts.Identifier): void {
    const declared = components.get(tag.text);
    if (declared && declared.length > 0) {
      for (const fn of declared) {
        if (visitedComponents.has(fn)) continue;
        visitedComponents.add(fn);
        if (fn.body) inRow(fn.body);
      }
      return;
    }
    if (fromPackage(tag, new Set())) return;
    bad.push(`${where(tag)} <${tag.text}> (a component that can't be followed)`);
  }

  /** Whether a component name comes only from packages (an icon, a library primitive), which render only
   * what the row passes them (read here): imported from one, or a local picked from a map of them. */
  function fromPackage(name: ts.Identifier, seen: Set<ts.Node>): boolean {
    const from = imports.get(name.getSourceFile())?.get(name.text);
    if (from !== undefined) return !from.startsWith('.');
    const declaration = declarationOf(name.text, name);
    if (!declaration || seen.has(declaration) || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return false;
    seen.add(declaration);
    const names: ts.Identifier[] = [];
    const collect = (part: ts.Node) => {
      if (ts.isElementAccessExpression(part)) { collect(part.expression); return; }
      if (ts.isPropertyAssignment(part)) { collect(part.initializer); return; }
      if (ts.isPropertyAccessExpression(part)) { collect(part.expression); return; }
      if (ts.isIdentifier(part)) { names.push(part); return; }
      ts.forEachChild(part, collect);
    };
    collect(declaration.initializer);
    return names.length > 0 && names.every((each) => fromPackage(each, seen));
  }

  for (const { source } of units) {
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        const opening = node.openingElement;
        const tag = opening.tagName.getText(source);
        if (ROW_TAGS.has(tag) || ROW_CLASS.test(className(opening))) {
          inRow(opening.attributes);
          for (const element of node.children) inRow(element);
          return;
        }
      }
      // A row with no children can still carry JSX in its attributes (T2).
      if (ts.isJsxSelfClosingElement(node) && (ROW_TAGS.has(node.tagName.getText(source)) || ROW_CLASS.test(className(node)))) {
        inRow(node.attributes);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...new Set(bad)];
}

describe('GM r8 (3): no refusal or error sentence in a toolbar row', () => {
  it('every toolbar row in the app holds none', { timeout: 120_000 }, () => {
    const files = tsxFiles().map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    expect(toolbarFailures(files)).toEqual([]);
  });

  it('mutant: Generate\'s old error span in Creator Studio\'s header fails it', () => {
    const path = join(SRC, 'components/create-studio/Fixture.tsx');
    const text = `export function F({ generationError }: { generationError: string | null }) {
      return <WorkspaceHeader title="Creator Studio" className="create-view__topbar">
        {generationError && <span className="create-view__run-error" role="alert">{generationError}</span>}
      </WorkspaceHeader>;
    }`;
    const found = toolbarFailures([{ path, text }]);
    expect(found).toContain('components/create-studio/Fixture.tsx:3 role="alert"');
    expect(found).toContain('components/create-studio/Fixture.tsx:3 generationError');
  });

  it('mutant: an error line in a toolbar row by class fails it; a status beside it passes', () => {
    const path = join(SRC, 'components/Fixture.tsx');
    const failing = `export function F({ saveError, status }: { saveError: string; status: string }) {
      return <div className="canvas-toolbar"><span>{status}</span><span>{saveError}</span></div>;
    }
    export const G = () => <F status="Saved" saveError="Couldn’t save." />;`;
    const passing = `export function F({ status, error }: { status: string; error: string }) {
      return <div className="canvas-toolbar"><span role="status">{status}</span>
        <div role="dialog"><p role="alert">{error}</p></div></div>;
    }
    export const G = () => <F status="Saved" error="Couldn’t save." />;`;
    expect(toolbarFailures([{ path, text: failing }])).toEqual(['components/Fixture.tsx:2 saveError']);
    expect(toolbarFailures([{ path, text: passing }])).toEqual([]);
  });

  // Round 8, review 6 LOW-4: the reviewer's six forms, each now caught, each for its own reason.
  const probe = (text: string) => toolbarFailures([{ path: join(SRC, 'components/create-studio/Probe.tsx'), text }]);
  it('T1: a component in the row is read as the row (a failure in RunLine)', () => {
    expect(probe(`function RunLine() { const e = useGraphStore((s) => s.lastRunFailure); return <span>{e}</span>; }
      export function F() { return <WorkspaceHeader title="x"><RunLine /></WorkspaceHeader>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 lastRunFailure']);
  });

  it('T1: a local component that can\'t be found fails closed; a package\'s doesn\'t', () => {
    expect(probe(`import { Line } from './line';
      export function F() { return <WorkspaceHeader title="x"><Line /></WorkspaceHeader>; }`))
      .toEqual(['components/create-studio/Probe.tsx:2 <Line> (a component that can\'t be followed)']);
    expect(probe(`import { Save } from 'lucide-react';
      export function F() { return <WorkspaceHeader title="x"><Save size={14} /></WorkspaceHeader>; }`)).toEqual([]);
  });

  it('T2: JSX passed as an attribute is in the row', () => {
    expect(probe(`export function F({ runError }: { runError: string }) { return <WorkspaceHeader title="x" navigation={<span role="alert">{runError}</span>} />; }
      export const G = () => <F runError="x" />;`))
      .toEqual(['components/create-studio/Probe.tsx:1 role="alert"', 'components/create-studio/Probe.tsx:1 runError']);
  });

  it('T3: a refusal sentence\'s helper is a sentence, whatever it is called', () => {
    expect(probe(`export function F() { return <WorkspaceHeader title="x"><span>{notConnectedBecause('generate')}</span></WorkspaceHeader>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 notConnectedBecause()']);
  });

  it('T4: a neutral name is followed to its value: a prop\'s uses, a state\'s setter, a local', () => {
    expect(probe(`export function F({ line }: { line: string }) { return <WorkspaceHeader title="x"><span>{line}</span></WorkspaceHeader>; }
      export const G = ({ saveError }: { saveError: string }) => <F line={saveError} />;`))
      .toEqual(['components/create-studio/Probe.tsx:1 saveError']);
    expect(probe(`export function F() { const [line, setLine] = useState(''); const go = () => setLine(failureMessage(1, 'x'));
      return <WorkspaceHeader title="x"><span>{line}</span></WorkspaceHeader>; }`))
      .toEqual(['components/create-studio/Probe.tsx:2 failureMessage()']);
    expect(probe(`export function F({ run }: { run: { failure: string } }) { const line = run.failure;
      return <WorkspaceHeader title="x"><span>{line}</span></WorkspaceHeader>; }
      export const G = () => <F run={{ failure: '' }} />;`))
      .toEqual(['components/create-studio/Probe.tsx:2 failure']);
    // A prop no use can be followed for fails closed (the reviewer's T4 as written).
    expect(probe(`export function F({ line }: { line: string }) { return <WorkspaceHeader title="x"><span>{line}</span></WorkspaceHeader>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 line (a prop no use can be followed for)']);
    // What `a && b` shows is `b`, read; its condition `a` isn't.
    expect(probe(`export function F({ failed }: { failed: boolean }) {
      return <WorkspaceHeader title="x"><span>{failed && failureMessage(1, 'x')}</span></WorkspaceHeader>; }
      export const G = () => <F failed />;`))
      .toEqual(['components/create-studio/Probe.tsx:2 failureMessage()']);
    // A condition or a key isn't what is shown.
    expect(probe(`export function F({ state }: { state: 'ok' | 'error' }) { const label = LABELS[state];
      return <WorkspaceHeader title="x">{state === 'error' && <span>Save failed</span>}<span>{label}</span></WorkspaceHeader>; }
      const LABELS = { ok: 'Saved', error: 'Save failed' };
      export const G = () => <F state="ok" />;`)).toEqual([]);
  });

  it('T5: aria-live="assertive" in the row', () => {
    expect(probe(`export function F() { return <div className="canvas-toolbar"><span aria-live="assertive">x</span></div>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 aria-live="assertive"']);
  });

  // Round 9, review 7 LOW-3: the reviewer's six more forms, each caught.
  it('T18: a local helper that wraps a sentence helper is read through its return', () => {
    expect(probe(`function lineFor(x: unknown) { return failureMessage(x, 'x'); }
      export function F({ x }: { x: unknown }) { return <WorkspaceHeader title="x"><span>{lineFor(x)}</span></WorkspaceHeader>; }
      export const G = () => <F x={1} />;`)).toEqual(['components/create-studio/Probe.tsx:2 failureMessage()']);
    expect(probe(`const lineFor = (x: unknown) => notConnectedBecause(String(x));
      export function F() { return <WorkspaceHeader title="x"><span>{lineFor(1)}</span></WorkspaceHeader>; }`))
      .toEqual(['components/create-studio/Probe.tsx:2 notConnectedBecause()']);
  });

  it('T7: a role through a spread', () => {
    expect(probe(`export function F() { return <div className="canvas-toolbar"><span {...{ role: 'alert' }}>x</span></div>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 role="alert"']);
  });

  it('T10, T15, T14: a row class from a constant, a helper or a template', () => {
    expect(probe(`const BAR = 'canvas-toolbar'; export function F() { return <div className={BAR}><span role="alert">x</span></div>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 role="alert"']);
    expect(probe(`export function F() { return <div className={cn('canvas-toolbar', 'wide')}><span role="alert">x</span></div>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 role="alert"']);
    expect(probe(`export function F({ wide }: { wide: boolean }) { return <div className={\`canvas-toolbar\${wide ? ' wide' : ''}\`}><span role="alert">x</span></div>; }
      export const G = () => <F wide />;`)).toEqual(['components/create-studio/Probe.tsx:1 role="alert"']);
  });

  it('T13: dangerouslySetInnerHTML in a row', () => {
    expect(probe(`export function F() { return <div className="canvas-toolbar"><span dangerouslySetInnerHTML={{ __html: x }} /></div>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 dangerouslySetInnerHTML']);
  });

  it('T17: a literal sentence; a label passes', () => {
    expect(probe(`export function F() { return <div className="canvas-toolbar">{'Nebula couldn’t start the generation. Try again.'}</div>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 "Nebula couldn’t start the generation. Try again."']);
    expect(probe(`export function F() { return <div className="canvas-toolbar"><span>Couldn’t save the board.</span></div>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 "Couldn’t save the board."']);
    expect(probe(`export function F() { return <div className="canvas-toolbar"><span>Saved</span><span>Save failed</span><span>Saving…</span></div>; }`)).toEqual([]);
  });

  it('structural: a line component in a row fails, whatever it is handed', () => {
    // Round 11: a lock's own line passes; with anything more it fails.
    expect(probe('export const F = () => <WorkspaceHeader title="x"><button {...lock.control()}>Add</button><PersonLockLine lock={lock} place="control" className="a" /></WorkspaceHeader>;')).toEqual([]);
    expect(probe('export const F = () => <WorkspaceHeader title="x"><PersonLockLine lock={lock} place="control" {...extra} /></WorkspaceHeader>;'))
      .toEqual(['components/create-studio/Probe.tsx:1 <PersonLockLine> (a lock line with more than its lock)']);
    expect(probe(`export function F({ x }: { x: string }) { return <WorkspaceHeader title="x"><LineText text={x} /></WorkspaceHeader>; }
      export const G = () => <F x="Saved" />;`)).toEqual(['components/create-studio/Probe.tsx:1 <LineText> (a line)']);
    expect(probe(`export function F({ x }: { x: string }) { return <div className="canvas-toolbar"><FailureLines failure={x} /></div>; }
      export const G = () => <F x="Saved" />;`)).toEqual(['components/create-studio/Probe.tsx:1 <FailureLines> (a line)']);
  });

  it('T6: a role read from an expression', () => {
    expect(probe(`export function F() { return <div className="canvas-toolbar"><span role={'alert'}>x</span></div>; }`))
      .toEqual(['components/create-studio/Probe.tsx:1 role="alert"']);
    expect(probe(`export function F({ a }: { a: boolean }) { return <div className="canvas-toolbar"><span role={a ? 'alert' : 'status'}>x</span></div>; }
      export const G = () => <F a />;`)).toEqual(['components/create-studio/Probe.tsx:1 role="alert"']);
  });
});
