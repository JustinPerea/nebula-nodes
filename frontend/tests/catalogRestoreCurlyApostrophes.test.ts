import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * GM r16 on PR #199, 5: the person-facing copy of the catalog restore, the
 * kept canvas and its locks uses the curly ’ throughout. This ratchet fails
 * any string literal or template text (never a comment) in those files with
 * a straight apostrophe between two letters ("isn't", "Nebula's").
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

/** Every file whose literals are all copy; or only the named constants'. */
const COPY: { file: string; only?: string[] }[] = [
  { file: 'components/projects/catalogRestoreCopy.ts' },
  { file: 'components/projects/KeptEditsNotice.tsx' },
  { file: 'lib/keptCanvas.ts' },
  { file: 'store/projectStore.ts', only: ['RESTORED_LIST_RELOAD', 'RESTORED_LIST_UNSAVED'] },
];

const STRAIGHT = /[A-Za-z](?:\\)?'[A-Za-z]/;

function straightApostrophes(fileName: string, text: string, only?: string[]): string[] {
  const kind = fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const strings = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) {
      const inImport = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent);
      const raw = node.getText(source);
      if (!inImport && STRAIGHT.test(raw)) found.push(raw);
    }
    ts.forEachChild(node, strings);
  };
  const visit = (node: ts.Node): void => {
    if (only && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && only.includes(node.name.text)) {
      if (node.initializer) strings(node.initializer);
      return;
    }
    if (!only) { strings(node); return; }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('GM r16, 5: curly apostrophes in the restore and kept-canvas copy', () => {
  for (const { file, only } of COPY) {
    it(`${file}${only ? ` (${only.join(', ')})` : ''} has no straight apostrophe between letters`, () => {
      const text = readFileSync(path.join(SRC, file), 'utf8');
      expect(straightApostrophes(file, text, only)).toEqual([]);
      if (only) {
        for (const name of only) expect(text).toContain(`const ${name} =`);
      }
    });
  }

  it('catches one in a literal, a template and JSX, and never in a comment', () => {
    const planted = [
      "// Nebula's comment is fine",
      "const A = \"It's over.\";",
      "const B = 'isn\\'t';",
      'const C = `${x} won\'t save`;',
      "const D = <p>Nebula's list</p>;",
      'const E = "Nebula’s list";',
    ].join('\n');
    expect(straightApostrophes('planted.tsx', planted)).toHaveLength(4);
    expect(straightApostrophes('planted.tsx', planted, ['E'])).toEqual([]);
  });
});
