// backendText("…") hides a string from the straight-apostrophe ratchet, so it may only wrap the
// backend's own words used as a key of an errorCopy match table, and each must be in the backend.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '../../src');
const BACKEND = join(__dirname, '../../../backend');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

interface Site { file: string; text: string; table: string | null; isKey: boolean }

/** Every backendText(...) call in src and where it sits. */
function sites(): Site[] {
  const found: Site[] = [];
  for (const path of walk(SRC)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('backendText')) continue;
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'backendText') {
        const arg = node.arguments[0];
        const literal = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) ? arg.text : '<not a literal>';
        // A Map key: the first element of a [key, value] pair inside `new Map([...])` of a named const.
        const pair = node.parent;
        const list = pair?.parent;
        const map = list?.parent;
        const isKey = !!pair && ts.isArrayLiteralExpression(pair) && pair.elements[0] === node
          && !!list && ts.isArrayLiteralExpression(list) && !!map && ts.isNewExpression(map)
          && ts.isIdentifier(map.expression) && map.expression.text === 'Map';
        const decl = map?.parent;
        const table = decl && ts.isVariableDeclaration(decl) && ts.isIdentifier(decl.name) ? decl.name.text : null;
        found.push({ file: relative(SRC, path), text: literal, table, isKey });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return found.filter((s) => s.file !== 'lib/backendText.ts');
}

describe('backendText stays a match-string marker', () => {
  it('is used only as a key of LOAD_BECAUSE or CLOSE_BECAUSE in lib/errorCopy.ts', () => {
    const all = sites();
    expect(all.length).toBeGreaterThan(0);
    const bad = all.filter((s) => s.file !== 'lib/errorCopy.ts' || !s.isKey || !['LOAD_BECAUSE', 'CLOSE_BECAUSE'].includes(s.table ?? ''));
    expect(bad.map((s) => `${s.file}: ${s.text}`)).toEqual([]);
  });

  it('every wrapped key is the backend\'s own text, verbatim', () => {
    const backend = ['routes/commons.py', 'commons/actors.py', 'commons/evaluation.py', 'commons/person_copy.py', 'services/refusal_copy.py']
      .map((f) => readFileSync(join(BACKEND, f), 'utf8')).join('\n');
    const all = sites();
    expect(all.length).toBeGreaterThan(0);
    for (const { text } of all) {
      // The gone line is built from its parts (refusal_copy.gone("reference", "references")).
      if (text.startsWith("That reference isn't there anymore")) {
        expect(backend).toContain("That {thing} isn't there anymore. Reload to get the latest {things}.");
        // ...and the backend still raises it with these parts.
        expect(backend).toContain('"reference", "references"');
        expect(text).toBe("That reference isn't there anymore. Reload to get the latest references.");
        continue;
      }
      // A whole Python string literal, not a substring: 'not found' must not pass on "asset not found".
      const literal = new RegExp(`(["'])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`);
      expect(literal.test(backend), text).toBe(true);
    }
  });

  it('every LOAD_BECAUSE and CLOSE_BECAUSE key is wrapped, so each is checked against the backend', async () => {
    const { CLOSE_BECAUSE, LOAD_BECAUSE } = await import('../../src/lib/errorCopy');
    for (const [name, table] of [['LOAD_BECAUSE', LOAD_BECAUSE], ['CLOSE_BECAUSE', CLOSE_BECAUSE]] as const) {
      const wrapped = new Set(sites().filter((s) => s.table === name).map((s) => s.text));
      expect([...table.keys()].filter((k) => !wrapped.has(k)), name).toEqual([]);
    }
  });
});
