import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Design: a person never reads a stored value, and "You" leads a line but does not sit
// mid-sentence. check:copy reads the strings of the shared copy rules (also run by the
// backend); this is the TSX-shape check beside it. Under src, in every .tsx, it fails:
//   1. an <option> whose visible text is the same expression as its value attribute
//      (`<option value={role}>{role}</option>`): label it through a map in lib/commonsTypes;
//   2. an <option> with no value attribute whose only child is a JSX expression: its value is
//      its shown text by construction, so it shows the stored value;
//   3. "by You" written out in a string or JSX text, and "by {actorLabel(...)}" where the
//      call is commonsFormat's leading form (no `{ midSentence: true }`): mid-sentence the
//      local person reads "you".
// trash.ts's actorLabel already returns "you" and takes a `by` object; only a call whose
// argument is a bare string actor (commonsFormat's) is read as the leading form. There is no
// baseline: the check starts at zero.

const SRC = join(process.cwd(), 'src');

/** An option that shows its value on purpose. By file (under src) and the value expression, with the reason. */
export const ALLOWED = [
  { file: 'components/cinema-studio/CinemaSharedControls.tsx', value: 'ratio', why: 'an aspect ratio ("16:9") is the thing a person reads; its value is not an enum word' },
  { file: 'components/cinema-studio/CinemaArtDirectionControls.tsx', value: 'value.method', why: 'the fallback for a palette method the app does not know (an older or newer scene file): shown as it is rather than hidden; outside Commons, for design to rule on' },
];

function collectTsx(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectTsx(full));
    else if (name.endsWith('.tsx') && !/\.test\.tsx$/.test(name)) out.push(full);
  }
  return out;
}

const exprText = (node, sf) => node.getText(sf).replace(/\s+/g, '');

function attrExpression(attr, sf) {
  const init = attr.initializer;
  if (!init) return null;
  if (ts.isJsxExpression(init) && init.expression) return exprText(init.expression, sf);
  return null;
}

/** The hits in one source text: { line, reason }. */
export function findEnumLabelHits(text, file = 'x.tsx') {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits = [];
  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node) => {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === 'option') {
      const valueAttr = node.openingElement.attributes.properties
        .find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'value');
      const value = valueAttr ? attrExpression(valueAttr, sf) : null;
      const kids = node.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
      if (!valueAttr && kids.length === 1 && ts.isJsxExpression(kids[0]) && kids[0].expression) {
        hits.push({ line: at(node), value: exprText(kids[0].expression, sf), reason: '<option> has no value attribute and shows an expression: its value is its text, so a stored value is shown. Give it value={...} and a label' });
      }
      if (value && kids.length === 1 && ts.isJsxExpression(kids[0]) && kids[0].expression
        && exprText(kids[0].expression, sf) === value) {
        hits.push({ line: at(node), value, reason: `<option> shows its own value (${value}) as text: label it through a map, not the stored value` });
      }
    }
    if (ts.isJsxText(node) && /\bby You\b/.test(node.text)) {
      hits.push({ line: at(node), reason: 'literal "by You": mid-sentence the local person reads "you"' });
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /\bby You\b/.test(node.text)) {
      hits.push({ line: at(node), reason: 'literal "by You": mid-sentence the local person reads "you"' });
    }
    // "by {actorLabel(x)}" in JSX text, or `by ${actorLabel(x)}` in a template.
    if (ts.isJsxExpression(node) && node.expression && ts.isCallExpression(node.expression)) {
      const prev = node.parent.children?.[node.parent.children.indexOf(node) - 1];
      if (prev && ts.isJsxText(prev) && /\bby\s*$/.test(prev.text)) leadingForm(node.expression, at(node));
    }
    if (ts.isTemplateSpan(node) && ts.isCallExpression(node.expression)) {
      const parent = node.parent;
      const before = parent.head === undefined ? '' : (parent.templateSpans.indexOf(node) === 0
        ? parent.head.text : parent.templateSpans[parent.templateSpans.indexOf(node) - 1].literal.text);
      if (/\bby\s*$/.test(before)) leadingForm(node.expression, at(node));
    }
    ts.forEachChild(node, visit);
  };
  function leadingForm(call, line) {
    if (call.expression.getText(sf) !== 'actorLabel') return;
    const [arg, opts] = call.arguments;
    if (!arg) return;
    if (opts && /midSentence:\s*true/.test(opts.getText(sf))) return;
    // trash.ts's actorLabel takes an object (`by`) and already reads "you".
    if (/(^|\.)(by|pinnedBy|coverBy|deletedBy)$/.test(arg.getText(sf))) return;
    hits.push({ line, reason: 'actorLabel(...) after "by" without { midSentence: true }: the leading form reads "You"' });
  }
  visit(sf);
  return hits;
}

function main() {
  const problems = [];
  const used = new Set();
  for (const file of collectTsx(SRC)) {
    const rel = relative(SRC, file);
    for (const hit of findEnumLabelHits(readFileSync(file, 'utf8'), file)) {
      const allowed = ALLOWED.findIndex((a) => a.file === rel && a.value === hit.value);
      if (allowed >= 0) used.add(allowed);
      else problems.push({ file: rel, ...hit });
    }
  }
  ALLOWED.forEach((a, i) => {
    if (!used.has(i)) problems.push({ file: a.file, line: 0, reason: `ALLOWED entry for ${a.value} no longer matches anything: delete it` });
  });
  if (problems.length > 0) {
    console.error('check:enum-labels found person-facing stored values or a leading "You" mid-sentence:');
    for (const p of problems) console.error(`  src/${p.file}:${p.line} ${p.reason}`);
    process.exit(1);
  }
  console.log('check:enum-labels ok');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
