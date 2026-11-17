import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Every heading Nebula's source gives a failure, read from the call sites: the first argument of apiRequest,
 * requestError and `new FailureNotice(` / `new RequestFailedError(`, the second of withHeading, failureMessage and
 * failureUnder, a `heading:` property, and a constant named …HEADING. Only literals count (a template's slots read
 * as "x"). tests/becauseClause.test.ts names the ones failedWhat can't read.
 */
const SRC = join(__dirname, '../../src');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FIRST_ARG = new Set(['apiRequest', 'requestError']);
const SECOND_ARG = new Set(['withHeading', 'failureMessage', 'failureUnder']);
const CLASS_FIRST_ARG = new Set(['FailureNotice', 'RequestFailedError', 'ConnectionLostError']);

/** The string constants of the file being read, so apiRequest(SAVE_CHARACTER, …) is read through its constant. */
let constants = new Map<string, string>();

function literal(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node)) return constants.get(node.text) ?? null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map((span) => `x${span.literal.text}`).join('');
  return null;
}

export interface HeadingSite { file: string; heading: string }

export function headingSites(): HeadingSite[] {
  const found: HeadingSite[] = [];
  for (const path of walk(SRC)) {
    const text = readFileSync(path, 'utf8');
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    constants = new Map();
    const collect = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) constants.set(node.name.text, node.initializer.text);
      ts.forEachChild(node, collect);
    };
    collect(file);
    const add = (node: ts.Node | undefined) => {
      const heading = literal(node);
      if (heading !== null) found.push({ file: relative(SRC, path), heading });
    };
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const name = node.expression.text;
        if (FIRST_ARG.has(name)) add(node.arguments[0]);
        if (SECOND_ARG.has(name)) add(node.arguments[1]);
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && CLASS_FIRST_ARG.has(node.expression.text)) add(node.arguments?.[0]);
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'heading') add(node.initializer);
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /HEADING$/.test(node.name.text)) add(node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found.filter((site) => site.heading.trim() !== '');
}
