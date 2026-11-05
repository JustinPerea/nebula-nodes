import ts from 'typescript';

/**
 * fix/file-param-upload-edits: a node's params spread from an object read
 * before an await (or outside a `.then` callback) and written after it
 * reverts whatever changed meanwhile: the person's typing, or an agent's
 * edit through MCP or the CLI. The Inspector's file upload did that
 * (`{ ...activeNodeData.params, [key]: filePath }` in the upload's `.then`);
 * #208's palette did it before writeParamNow.
 *
 * A finding is a spread whose expression ends in `params` (`...params`,
 * `...node.data.params`, `...activeNodeData.params`) where
 *  - it sits inside a function passed to `.then`/`.catch`/`.finally`, and
 *    the root of the expression (`activeNodeData`, `node`, `params`) is
 *    declared outside that function; or
 *  - it sits after an `await` in an async function (the await at that
 *    function's own level, before the spread), and the root is declared
 *    before that await.
 * A spread may opt out with `// stale-params-ok: <reason>` on its own line or
 * the line above; the reason is required.
 */

export interface StaleSpread { line: number; text: string; why: 'then' | 'await' }

const OPT_OUT = /stale-params-ok:\s*\S/;
const THEN_NAMES = new Set(['then', 'catch', 'finally']);

function rootName(expr: ts.Expression): string | null {
  let current: ts.Expression = expr;
  for (;;) {
    if (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
    } else if (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
      current = current.expression;
    } else break;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function endsInParams(expr: ts.Expression): boolean {
  let current: ts.Expression = expr;
  while (ts.isParenthesizedExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) current = current.expression;
  if (ts.isIdentifier(current)) return current.text === 'params';
  if (ts.isPropertyAccessExpression(current)) return current.name.text === 'params';
  return false;
}

/** The object is written as a node's params: `{ params: { ...p, k } }`. */
function isParamsValue(object: ts.Node): boolean {
  const owner = object.parent;
  return Boolean(owner && ts.isPropertyAssignment(owner) && owner.initializer === object
    && (ts.isIdentifier(owner.name) || ts.isStringLiteral(owner.name)) && owner.name.text === 'params');
}

function bindsName(name: ts.BindingName, wanted: string): boolean {
  if (ts.isIdentifier(name)) return name.text === wanted;
  return name.elements.some((element) => !ts.isOmittedExpression(element) && bindsName(element.name, wanted));
}

/** Where `name` is declared as seen from `from`: the declaring node, or null
 * (a global, an import: outside every function). */
function declarationOf(name: string, from: ts.Node): ts.Node | null {
  let scope: ts.Node | undefined = from.parent;
  while (scope) {
    if (ts.isFunctionLike(scope)) {
      for (const param of (scope as ts.SignatureDeclaration).parameters) {
        if (bindsName(param.name, name)) return param;
      }
    }
    if (ts.isCatchClause(scope) && scope.variableDeclaration && bindsName(scope.variableDeclaration.name, name)) {
      return scope.variableDeclaration;
    }
    const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)
      ? scope.statements
      : null;
    if (statements) {
      for (const statement of statements) {
        if (ts.isVariableStatement(statement)) {
          for (const decl of statement.declarationList.declarations) if (bindsName(decl.name, name)) return decl;
        } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
          return statement;
        }
      }
    }
    if ((ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope))
      && scope.initializer && ts.isVariableDeclarationList(scope.initializer)) {
      for (const decl of scope.initializer.declarations) if (bindsName(decl.name, name)) return decl;
    }
    scope = scope.parent;
  }
  return null;
}

const contains = (outer: ts.Node, inner: ts.Node) => inner.pos >= outer.pos && inner.end <= outer.end;

/** The awaits of `fn` at its own level (not in a nested function). */
function ownAwaits(fn: ts.FunctionLikeDeclaration): ts.AwaitExpression[] {
  const found: ts.AwaitExpression[] = [];
  const visit = (node: ts.Node) => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  if (fn.body) visit(fn.body);
  return found;
}

function isThenCallback(fn: ts.Node): boolean {
  const call = fn.parent;
  return Boolean(call && ts.isCallExpression(call) && call.arguments.some((arg) => arg === fn)
    && ts.isPropertyAccessExpression(call.expression) && THEN_NAMES.has(call.expression.name.text));
}

function staleWhy(spread: ts.SpreadAssignment | ts.SpreadElement, sourceFile: ts.SourceFile): StaleSpread['why'] | null {
  const root = rootName(spread.expression);
  if (!root) return null;
  const decl = declarationOf(root, spread);
  for (let fn: ts.Node | undefined = spread.parent; fn; fn = fn.parent) {
    if (!ts.isFunctionLike(fn) || !('body' in fn)) continue;
    const fnDecl = fn as ts.FunctionLikeDeclaration;
    if (isThenCallback(fnDecl) && (!decl || !contains(fnDecl, decl))) return 'then';
    if (fnDecl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
      const spreadStart = spread.getStart(sourceFile);
      const before = ownAwaits(fnDecl).filter((a) => a.end <= spreadStart);
      // Declared before one of those awaits (or outside this function).
      if (before.some((a) => !decl || decl.end <= a.getStart(sourceFile))) return 'await';
    }
  }
  return null;
}

export function staleParamsSpreads(source: string, file = 'x.tsx'): StaleSpread[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true,
    file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
  const lines = source.split('\n');
  const found: StaleSpread[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isSpreadAssignment(node) || (ts.isSpreadElement(node) && ts.isObjectLiteralExpression(node.parent)))
      && (endsInParams(node.expression) || isParamsValue(node.parent))) {
      const why = staleWhy(node, sourceFile);
      if (why) {
        const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
        if (!OPT_OUT.test(lines[line] ?? '') && !OPT_OUT.test(lines[line - 1] ?? '')) {
          found.push({ line: line + 1, text: node.getText(sourceFile), why });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
