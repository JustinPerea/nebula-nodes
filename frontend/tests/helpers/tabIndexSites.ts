/**
 * PR #204 round 18h (review 16 focus LOW-1): every place src gives an element tabindex -1, found
 * from the syntax tree rather than one spelling: `tabIndex={-1}`, `tabIndex="-1"`,
 * `tabIndex={ -1 }`, `tabIndex={cond ? -1 : undefined}`, `{ tabIndex: -1 }` in a spread,
 * `el.tabIndex = -1` and `setAttribute('tabindex', '-1')`, in .ts and .tsx alike.
 */
import ts from 'typescript';

export interface TabIndexSite {
  /** The element's opening tag as written (JSX), else the statement that sets it. */
  element: string;
  /** Its tag name (JSX), else ''. */
  tag: string;
  /** Whether -1 is one branch of a choice (a roving tab stop: 0 for the current, -1 for the rest). */
  roving: boolean;
}

const isMinusOne = (node: ts.Node): boolean =>
  (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken
    && ts.isNumericLiteral(node.operand) && node.operand.text === '1')
  || (ts.isStringLiteral(node) && node.text.trim() === '-1');

function holdsMinusOne(node: ts.Node): boolean {
  if (isMinusOne(node)) return true;
  let found = false;
  node.forEachChild((child) => { if (!found && !ts.isFunctionLike(child)) found = holdsMinusOne(child); });
  return found;
}

const isChoice = (node: ts.Node): boolean => {
  let found = false;
  const visit = (n: ts.Node) => {
    if (found) return;
    if (ts.isConditionalExpression(n)) {
      const branches = [n.whenTrue, n.whenFalse].map((b) => (ts.isParenthesizedExpression(b) ? b.expression : b));
      // Both branches tab stops (0 and -1): a roving stop. -1 or nothing: still a -1 target.
      if (branches.some(isMinusOne) && branches.some((b) => ts.isNumericLiteral(b) && b.text === '0')) found = true;
    }
    n.forEachChild(visit);
  };
  visit(node);
  return found;
};

const nameOf = (name: ts.Node | undefined) => (name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : '');

export function tabIndexSites(source: string, fileName: string): TabIndexSite[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const sites: TabIndexSite[] = [];
  const opening = (node: ts.Node): ts.JsxOpeningLikeElement | undefined => {
    for (let at: ts.Node | undefined = node; at; at = at.parent) {
      if (ts.isJsxOpeningElement(at) || ts.isJsxSelfClosingElement(at)) return at;
      if (ts.isFunctionLike(at)) return undefined;
    }
    return undefined;
  };
  const add = (node: ts.Node, value: ts.Node) => {
    const element = opening(node);
    const statement = (() => { let at: ts.Node = node; while (at.parent && !ts.isStatement(at) && !ts.isSourceFile(at.parent)) at = at.parent; return at; })();
    sites.push({
      element: element ? element.getText(sf) : statement.getText(sf),
      tag: element ? element.tagName.getText(sf) : '',
      roving: isChoice(value),
    });
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && nameOf(node.name) === 'tabIndex' && node.initializer && holdsMinusOne(node.initializer)) add(node, node.initializer);
    else if (ts.isPropertyAssignment(node) && nameOf(node.name).toLowerCase() === 'tabindex' && holdsMinusOne(node.initializer)) add(node, node.initializer);
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'tabIndex' && holdsMinusOne(node.right)) add(node, node.right);
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setAttribute'
      && node.arguments.length === 2 && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text.toLowerCase() === 'tabindex'
      && holdsMinusOne(node.arguments[1])) add(node, node.arguments[1]);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}
