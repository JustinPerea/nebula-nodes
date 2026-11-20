import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import type { SheetRule } from './cssCascade';

/** A search field the scan found, and the name a list uses to vouch for it. */
export interface FoundSearch { id: string; kind: 'shell' | 'field'; file: string }

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

/** The app's component sources as { file, text }. */
export function componentSources(srcDir: string): Array<{ file: string; text: string }> {
  return tsxFiles(srcDir).sort().map((path) => ({ file: relative(srcDir, path), text: readFileSync(path, 'utf8') }));
}

function tagName(el: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return (ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName).getText();
}
function attrsOf(el: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(el) ? el.openingElement.attributes : el.attributes;
}
/** The literal text of an attribute (string or template pieces; `${}` parts are dropped). */
function attrText(el: ts.JsxElement | ts.JsxSelfClosingElement, name: string): string | null {
  for (const a of attrsOf(el).properties) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== name || !a.initializer) continue;
    const parts: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) parts.push(n.text);
      ts.forEachChild(n, visit);
    };
    visit(a.initializer);
    return parts.join(' ');
  }
  return null;
}
const classesOf = (el: ts.JsxElement | ts.JsxSelfClosingElement) => (attrText(el, 'className') ?? '').split(/\s+/).filter(Boolean);

/** True when a rule at rest gives `cls` a border or a fill you can see. */
export function hasVisibleBox(cls: string, rules: SheetRule[]): boolean {
  const end = new RegExp(`\\.${cls.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&')}$`);
  return rules.some((r) => r.state === '' && end.test(r.base) && r.decls.some((d) => {
    if (d.prop === 'border') return !/^(0|none)\b/.test(d.value.trim());
    if (d.prop === 'background' || d.prop === 'background-color') return !/^(none|transparent|inherit|initial|unset)\b/.test(d.value.trim());
    return false;
  }));
}

const isSearchInput = (el: ts.JsxElement | ts.JsxSelfClosingElement) =>
  tagName(el) === 'input' && (attrText(el, 'type') === 'search' || attrText(el, 'role') === 'searchbox'
    || /^search\b/i.test(attrText(el, 'placeholder') ?? '') || /^search\b/i.test(attrText(el, 'aria-label') ?? '')
    // An aria-label spread in as an object (`'aria-label': 'Search commands'`) is not a JSX attribute.
    || /['"]aria-label['"]\s*:\s*['"]search\b/i.test(el.getText()));

/**
 * Finds the search fields in component sources, by two rules:
 *  1. A wrapper element (not an input) whose class has "search" in it and which holds an input is a shell.
 *  2. An input that is type="search", has role searchbox, or has a placeholder or aria-label starting
 *     "Search": if its direct parent has a class with "search" in it or a visible box in the CSS (a border
 *     or a fill at rest), that parent class is a shell. Otherwise the input is reported as a field, named by its own class or,
 *     with none, by its file and label.
 */
export function discoverSearch(sources: Array<{ file: string; text: string }>, rules: SheetRule[]): FoundSearch[] {
  const found = new Map<string, FoundSearch>();
  const add = (f: FoundSearch) => { if (!found.has(f.id)) found.set(f.id, f); };
  for (const { file, text } of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const holdsInput = (el: ts.Node): boolean => {
      let hit = false;
      const visit = (n: ts.Node): void => {
        if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && tagName(n) === 'input') hit = true;
        if (!hit) ts.forEachChild(n, visit);
      };
      ts.forEachChild(el, visit);
      return hit;
    };
    const visit = (n: ts.Node): void => {
      if (ts.isJsxElement(n) && tagName(n) !== 'input') {
        for (const c of classesOf(n)) if (/search/i.test(c) && holdsInput(n)) add({ id: c, kind: 'shell', file });
      }
      if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && isSearchInput(n)) {
        const parent = n.parent && ts.isJsxElement(n.parent) ? n.parent : null;
        const boxed = parent ? classesOf(parent).find((c) => /search/i.test(c) || hasVisibleBox(c, rules)) : undefined;
        if (boxed) add({ id: boxed, kind: 'shell', file });
        else {
          const own = classesOf(n).find((c) => /search/i.test(c)) ?? classesOf(n)[0];
          const label = attrText(n, 'aria-label') ?? attrText(n, 'placeholder') ?? attrText(n, 'name') ?? 'input';
          add({ id: own ?? `${file.split('/').pop()}: ${label}`, kind: 'field', file });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return [...found.values()];
}
