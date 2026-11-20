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
//   3. a badge (className holds commons-badge or commons-source) whose text is JSX text starting
//      with a lower-case letter, or a bare identifier or property access (a stored value shown as
//      is): badges are labels in sentence case, drawn from a label map (design). A map lookup
//      (`ROLE_LABELS[x]`) or a call passes; the runtime test in tests/commonsBadgeCase.test.tsx
//      checks the words themselves;
//   4. "by You" written out in a string or JSX text, and "by {actorLabel(...)}" where the
//      call is commonsFormat's leading form (no `{ midSentence: true }`): mid-sentence the
//      local person reads "you".
// trash.ts's actorLabel already returns "you" and takes a `by` object; only a call whose
// argument is a bare string actor (commonsFormat's) is read as the leading form. There is no
// baseline: the check starts at zero.

const SRC = join(process.cwd(), 'src');

/** An option that shows its value on purpose. By file (under src) and the value expression, with the reason. */
export const ALLOWED = [
  { file: 'components/commons/CommonsDetail.tsx', value: 'badge.label', why: 'analysisBadge() returns a label from STATE_LABELS (sentence case); the runtime test covers every state' },
  { file: 'components/commons/CommonsDetail.tsx', value: 'membership.brand', why: 'a brand badge shows the brand\'s own name, which is not a stored enum value' },
  { file: 'components/commons/CommonsDetail.tsx', value: 'label', why: 'sourceLabel() returns the words (Corrected, Code, Model: id); the runtime test covers them' },
  { file: 'components/commons/CommonsGrid.tsx', value: 'badge.text', why: 'the tile renders a list of badges built in tileBadges() from label maps; the runtime test covers each' },
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

/** Peel off String(x), `${x}`, parentheses, `as` casts and `!` so the underlying expression compares. */
export function unwrap(node) {
  let cur = node;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)
      || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else if (ts.isCallExpression(cur) && ts.isIdentifier(cur.expression) && cur.expression.text === 'String'
      && cur.arguments.length === 1) cur = cur.arguments[0];
    else if (ts.isTemplateExpression(cur) && cur.head.text === '' && cur.templateSpans.length === 1
      && cur.templateSpans[0].literal.text === '') cur = cur.templateSpans[0].expression;
    else return cur;
  }
}

/** A stored value shown as is: an identifier, or a property access chain rooted at one (no call, no map lookup). */
function isBare(node) {
  const n = unwrap(node);
  if (ts.isIdentifier(n)) return true;
  if (ts.isPropertyAccessExpression(n)) return isBare(n.expression);
  return false;
}

const exprText = (node, sf) => node.getText(sf).replace(/\s+/g, '');

function attrExpression(attr, sf) {
  const init = attr.initializer;
  if (!init) return null;
  if (ts.isJsxExpression(init) && init.expression) return exprText(unwrap(init.expression), sf);
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
        hits.push({ line: at(node), value: exprText(unwrap(kids[0].expression), sf), reason: '<option> has no value attribute and shows an expression: its value is its text, so a stored value is shown. Give it value={...} and a label' });
      }
      if (value && kids.length === 1 && ts.isJsxExpression(kids[0]) && kids[0].expression
        && exprText(unwrap(kids[0].expression), sf) === value) {
        hits.push({ line: at(node), value, reason: `<option> shows its own value (${value}) as text: label it through a map, not the stored value` });
      }
    }
    if (ts.isJsxElement(node) && isBadge(node.openingElement)) badgeHits(node);
    if (ts.isJsxText(node) && /\bby You\b/.test(node.text)) {
      hits.push({ line: at(node), reason: 'literal "by You": mid-sentence the local person reads "you"' });
    }
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /\bby You\b/.test(node.text)) {
      hits.push({ line: at(node), reason: 'literal "by You": mid-sentence the local person reads "you"' });
    }
    // "by {actorLabel(x)}" in JSX text, or `by ${actorLabel(x)}` in a template.
    if (ts.isJsxExpression(node) && node.expression && ts.isCallExpression(node.expression)) {
      if (/\bby\s*$/.test(textBefore(node))) leadingForm(node.expression, at(node));
    }
    // 'Added by ' + actorLabel(x)
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      && ts.isCallExpression(unwrap(node.right)) && /\bby\s*$/.test(stringTail(node.left))) {
      leadingForm(unwrap(node.right), at(node));
    }
    if (ts.isTemplateSpan(node) && ts.isCallExpression(node.expression)) {
      const parent = node.parent;
      const before = parent.head === undefined ? '' : (parent.templateSpans.indexOf(node) === 0
        ? parent.head.text : parent.templateSpans[parent.templateSpans.indexOf(node) - 1].literal.text);
      if (/\bby\s*$/.test(before)) leadingForm(node.expression, at(node));
    }
    ts.forEachChild(node, visit);
  };
  /** The text just before a JSX expression, skipping whitespace-only siblings and `{' '}`. */
  function textBefore(node) {
    const kids = node.parent.children;
    if (!kids) return '';
    let i = kids.indexOf(node) - 1;
    while (i >= 0) {
      const k = kids[i];
      const blank = (ts.isJsxText(k) && k.text.trim() === '')
        || (ts.isJsxExpression(k) && k.expression && (ts.isStringLiteral(k.expression) || ts.isNoSubstitutionTemplateLiteral(k.expression)) && k.expression.text.trim() === '');
      if (!blank) return ts.isJsxText(k) ? k.text : '';
      i -= 1;
    }
    return '';
  }
  /** The trailing string of the left side of a `+`: a literal, or the right end of a longer concatenation. */
  function stringTail(node) {
    const n = unwrap(node);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return stringTail(n.right);
    return '';
  }
  function isBadge(opening) {
    const cls = opening.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(sf) === 'className');
    if (!cls || !cls.initializer) return false;
    return /commons-(badge|source)\b/.test(cls.initializer.getText(sf));
  }
  function badgeHits(el) {
    const kids = el.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
    for (const kid of kids) {
      if (ts.isJsxText(kid) && /^[a-z]/.test(kid.text.trim())) {
        hits.push({ line: at(kid), value: kid.text.trim(), reason: `badge text "${kid.text.trim()}" starts lower case: badges are sentence case` });
      }
      if (ts.isJsxExpression(kid) && kid.expression && isBare(kid.expression)) {
        hits.push({ line: at(kid), value: exprText(unwrap(kid.expression), sf), reason: `badge shows ${exprText(unwrap(kid.expression), sf)} as is: draw its words from a label map` });
      }
    }
  }
  function leadingForm(call, line) {
    const callee = call.expression;
    const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(sf);
    if (name !== 'actorLabel') return;
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
