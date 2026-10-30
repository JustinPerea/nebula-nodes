/**
 * GM r8 (3), PR #204 round 7: no refusal or error sentence in a toolbar row. A screen's lines go
 * to the app's notice region (notify, InNoticeRegion); a toolbar row holds controls and states.
 * The ratchet reads every component: inside a toolbar row (a WorkspaceHeader, or an element whose
 * class names a toolbar, a topbar or a header bar), no `role="alert"` and no child expression
 * that reads an error, a refusal or a failure.
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

function className(element: ts.JsxOpeningLikeElement): string {
  for (const attr of element.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !ts.isIdentifier(attr.name) || attr.name.text !== 'className' || !attr.initializer) continue;
    if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
    if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) return attr.initializer.expression.getText();
  }
  return '';
}

/** A popover or dialog opened from the row is its own surface, with its own lines. */
function ownSurface(node: ts.Node): boolean {
  const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : null;
  if (!opening) return false;
  return opening.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && ts.isIdentifier(attr.name)
    && attr.name.text === 'role' && !!attr.initializer && ts.isStringLiteral(attr.initializer)
    && /^(?:dialog|alertdialog|menu|listbox)$/.test(attr.initializer.text));
}

/** Each offending part inside a toolbar row, as `file:line text`. */
export function toolbarFailures(files: { path: string; text: string }[]): string[] {
  const bad: string[] = [];
  for (const { path, text } of files) {
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const where = (node: ts.Node) => `${relative(SRC, path)}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const inRow = (element: ts.JsxElement) => {
      const visit = (node: ts.Node) => {
        if (ownSurface(node)) return;
        if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'role' && node.initializer
          && ts.isStringLiteral(node.initializer) && node.initializer.text === 'alert') bad.push(`${where(node)} role="alert"`);
        if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
          const said: string[] = [];
          const read = (part: ts.Node) => {
            if (ts.isIdentifier(part) && SAYS_FAILURE.test(part.text)) said.push(part.text);
            if (ts.isPropertyAccessExpression(part) && SAYS_FAILURE.test(part.name.text)) said.push(part.name.text);
            // A handler or a component passed down is not a line.
            if (ts.isArrowFunction(part) || ts.isFunctionExpression(part) || ts.isJsxAttributes(part) || ownSurface(part)) return;
            ts.forEachChild(part, read);
          };
          read(node.expression);
          if (said.length > 0) bad.push(`${where(node)} ${said.join(',')}`);
        }
        ts.forEachChild(node, visit);
      };
      for (const child of element.children) visit(child);
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node)) {
        const opening = node.openingElement;
        const tag = opening.tagName.getText(source);
        if (ROW_TAGS.has(tag) || ROW_CLASS.test(className(opening))) { inRow(node); return; }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return bad;
}

describe('GM r8 (3): no refusal or error sentence in a toolbar row', () => {
  it('every toolbar row in the app holds none', () => {
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
    }`;
    const passing = `export function F({ status, error }: { status: string; error: string }) {
      return <div className="canvas-toolbar"><span role="status">{status}</span>
        <div role="dialog"><p role="alert">{error}</p></div></div>;
    }`;
    expect(toolbarFailures([{ path, text: failing }])).toEqual(['components/Fixture.tsx:2 saveError']);
    expect(toolbarFailures([{ path, text: passing }])).toEqual([]);
  });
});
