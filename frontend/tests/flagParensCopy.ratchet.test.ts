/**
 * Person copy names a NEBULA_ flag in the sentence, never in parentheses (GM r38.1). A flag in
 * parens reads as an aside the person can skip, when it's the one thing they need: "Restart
 * Nebula with NEBULA_COMMONS_ENABLED=1 to review this proposal." The backend half of this check
 * is backend/tests/test_flag_parens_copy.py.
 *
 * This scans every string, template and JSX text in src (comments aside, which no person reads).
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..', 'src');
// Round 18l (review 17 logic NIT-2): anywhere inside the parens, not only first.
const FLAG_IN_PARENS = /\([^)]*\bNEBULA_[A-Z0-9_]+/;
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : files(path);
  return /\.tsx?$/.test(name) && !name.includes('.test.') ? [path] : [];
});

const TEXT_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
]);

function offenders(source: string, name: string): string[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true,
    name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (TEXT_KINDS.has(node.kind) && FLAG_IN_PARENS.test((node as ts.LiteralLikeNode).text)) {
      found.push(`${name}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('no person line puts a NEBULA_ flag in parentheses', () => {
  it('holds across src', () => {
    const found = files(SRC).flatMap((path) => offenders(readFileSync(path, 'utf8'), relative(SRC, path)));
    expect(found).toEqual([]);
  });

  it('catches a flag in parens in a string, a template and JSX text, and skips comments', () => {
    expect(offenders("const a = 'Start it (NEBULA_X), then try again.';", 'a.ts')).toHaveLength(1);
    expect(offenders('const b = `Start ${n} (NEBULA_X) now`;', 'b.ts')).toHaveLength(1);
    expect(offenders('const c = <p>Start it (NEBULA_X).</p>;', 'c.tsx')).toHaveLength(1);
    expect(offenders('// a comment (NEBULA_X)\nconst d = 1;', 'd.ts')).toHaveLength(0);
    expect(offenders("const e = 'Restart Nebula with NEBULA_X=1.';", 'e.ts')).toHaveLength(0);
    // Round 18l (NIT-2): a flag later in the parens too.
    expect(offenders("const f = 'Start it (set NEBULA_X=1), then try again.';", 'f.ts')).toHaveLength(1);
    expect(offenders("const g = 'Start it (the budget, NEBULA_X) now.';", 'g.ts')).toHaveLength(1);
    expect(offenders("const h = 'Start it (now). Restart with NEBULA_X=1.';", 'h.ts')).toHaveLength(0);
  });
});
