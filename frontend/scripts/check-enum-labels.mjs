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
//   3. a badge (className holds commons-badge or commons-source) whose first visible content, at
//      any depth, is lower-case JSX text, a lower-case string literal or a template literal with a
//      lower-case head (also in a conditional's branches and in each operand of ??, ||, and the
//      shown right side of &&), or that shows a stored value anywhere: a property chain on a plain
//      object (`s.state`), an element access outside an ALL_CAPS *LABEL* map (`row[field]`,
//      `s.tags[0].name`, `ROLES[0]`), a property of a call that is not a *Label or *Badge call
//      (`get(s).state`), a method call on a stored value (`s.state.toLowerCase()`), or a case
//      change on any value (`enumValueLabel(f, v).toLowerCase()`). A concatenation is read like a
//      template (`'in ' + s.state`). A length and number formatting (`row.count.toFixed(1)`) pass. Badges
//      are labels in sentence case, drawn from a label map (design). Text after a number
//      (`{n} items`), a map lookup (`ROLE_LABELS[x]`, `SIGHTING_STATE[s.state]!.label`), a
//      *Label or *Badge call and a plain function call pass. A bare identifier (`{count}`) passes
//      too: it may be a number, so the check cannot tell it from a stored word. That is the
//      trade-off; the runtime test in tests/commonsBadgeCase.test.tsx covers mapped values;
//   4. "by You" written out in a string or JSX text, and "by {actorLabel(...)}" where the
//      call is commonsFormat's leading form (no `{ midSentence: true }`): mid-sentence the
//      local person reads "you".
//   5. a person label with a parenthesised aside at its end ("Ignore (comma separated)", "Name
//      (optional)", "Mode (beta)"): the note goes beside or under the label, as an aside or a
//      placeholder, and a label reads as its name. A unit ("Duration (s)") and a key shortcut
//      ("Save (Ctrl+S)") pass, as does a sentence with parentheses in the middle. A parenthesised
//      "optional", "required", "beta", "experimental", "deprecated", "default" or "recommended"
//      fails anywhere in a text;
//      The word check ("(optional)" and the rest) also runs on every string in a .ts file under src
//      (the node definitions' placeholders, the lib's summaries); the trailing-aside shape does
//      not, outside JSX it is too noisy. A model or provider's own display name that other code
//      strips or matches is listed in ALLOWED_NAMES with its reason ("Jev Box (experimental)" became "Jev Box · experimental"; the old label stays in FORMER_DEFAULT_TITLES so saved nodes still read as unnamed).
//      The label shape passes a written-out unit ("Size (pixels)", "Duration (seconds)") and a
//      count ("Images (3)"); a brand in parentheses ("Claude (Anthropic)") is an aside and fails;
//   6. a date shown through `toLocaleString`, `toLocaleDateString`, `toLocaleTimeString` or
//      `Intl.DateTimeFormat` (called with or without `new`) where the receiver is a date (`new Date(x)`, or a name matching
//      date, when or moment, a camelCase `...At` or `...Date` suffix, or a snake_case `..._at`
//      or `..._date`; `format` and `elapsedTime` are not dates): write it with `writtenDate`,
//      `writtenDateTime` or `writtenTime` (lib/writtenDate), spelled out with no seconds
//      (design). Number formatting passes;
//   7. a plain " · " before "optional", "default", "required", "beta", "experimental",
//      "deprecated" or "recommended" in a .tsx text: a label built in the aside form is written
//      with `aside(label, note)` (lib/labelAside), whose space before the dot does not break, so
//      the dot never strands at the end of a wrapped line. Stored labels in the node
//      definitions keep the plain space (other code splits on it) and are .ts, not read here.
// trash.ts's actorLabel already returns "you" and takes a `by` object; only a call whose
// argument is a bare string actor (commonsFormat's) is read as the leading form. There is no
// baseline: the check starts at zero.

const SRC = join(process.cwd(), 'src');

/** A model or provider's display name with a parenthesised word, which other code strips or matches. By file and the text. */
export const ALLOWED_NAMES = [
  { file: 'lib/formerDefaultTitles.ts', value: 'Jev Box (experimental)', why: 'the label nodes saved before the rename still carry ("Jev Box (experimental)"); it is matched, never shown' },
];

/** An option that shows its value on purpose. By file (under src) and the value expression, with the reason. */
export const ALLOWED = [
  { file: 'lib/writtenDate.ts', value: "date.toLocaleDateString('en-US',{month:'long',day:'numeric'})", why: 'writtenDay is the one written-date helper: it spells the month out in English with the locale pinned, and every other date goes through it' },
  { file: 'components/commons/CommonsDetail.tsx', value: 'badge.label', why: 'analysisBadge() returns a label from STATE_LABELS (sentence case); the runtime test covers every state' },
  { file: 'components/commons/CommonsDetail.tsx', value: 'membership.brand', why: 'a brand badge shows the brand\'s own name, which is not a stored enum value' },
  { file: 'components/commons/CommonsGrid.tsx', value: 'badge.text', why: 'the tile renders a list of badges built in tileBadges() from label maps; the runtime test covers each' },
  { file: 'components/cinema-studio/CinemaSharedControls.tsx', value: 'ratio', why: 'an aspect ratio ("16:9") is the thing a person reads; its value is not an enum word' },
  { file: 'components/cinema-studio/CinemaArtDirectionControls.tsx', value: 'value.method', why: 'the fallback for a palette method the app does not know (an older or newer scene file): shown as it is rather than hidden; outside Commons, for design to rule on' },
];

function collectSources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectSources(full));
    else if (name.endsWith('.tsx') && !/\.test\.tsx$/.test(name)) out.push(full);
    else if (name.endsWith('.ts') && !/\.(?:test|d)\.ts$/.test(name)) out.push(full);
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

const isCaps = (n) => ts.isIdentifier(n) && /^[A-Z][A-Z0-9_]*$/.test(n.text);
/** The name a call goes by: `enumValueLabel` for `enumValueLabel(x)`, `label` for `a.label(x)`. */
function calleeName(call) {
  const callee = unwrap(call.expression);
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
}
const isLabelCall = (call) => /(Label|Badge)$/.test(calleeName(call));
/** An ALL_CAPS constant whose name says it holds labels (`ROLE_LABELS`, `LABELS`). */
const isLabelMap = (n) => isCaps(n) && /LABEL/.test(n.text);
const CASE_METHODS = new Set(['toLowerCase', 'toUpperCase', 'toLocaleLowerCase', 'toLocaleUpperCase']);
const NUMBER_METHODS = new Set(['toFixed', 'toLocaleString', 'toPrecision']);

/**
 * A stored value shown as it is. Fails: a property chain rooted at a plain object (`s.state`);
 * an element access whose object is not an ALL_CAPS label-map constant (`s['state']`,
 * `row[field]`, `s.tags[0].name`); a chain rooted at a call whose callee does not end in "Label"
 * or "Badge" (`get(s).state`); a method call on a stored access (`s.state.toLowerCase()`).
 * Passes: a chain rooted at a label-map lookup (`SIGHTING_STATE[s.state]!.label`) or at a
 * label/badge call (`analysisBadge(x).label`), a plain identifier, and a call to a function
 * (`pretty(x)`). A bare identifier passing is a trade-off (it may be a count); the runtime test
 * in tests/commonsBadgeCase.test.tsx checks the words of mapped values.
 */
function isStoredAccess(node) {
  const n = unwrap(node);
  if (ts.isPropertyAccessExpression(n)) {
    // A length is a count, not a stored word.
    if (n.name.text === 'length') return false;
    let root = unwrap(n.expression);
    while (ts.isPropertyAccessExpression(root)) root = unwrap(root.expression);
    // A property of an ALL_CAPS map lookup (`SIGHTING_STATE[s.state]!.label`) reads the map's entry.
    if (ts.isElementAccessExpression(root)) return !isCaps(unwrap(root.expression));
    if (ts.isCallExpression(root)) return !isLabelCall(root);
    return true;
  }
  // A lookup shown as it is passes only on a label map (`ROLE_LABELS[x]`); a list of stored
  // values (`ROLES[0]`, `AXES[i]`) shows the stored word.
  if (ts.isElementAccessExpression(n)) return !isLabelMap(unwrap(n.expression));
  if (ts.isCallExpression(n)) {
    const callee = unwrap(n.expression);
    if (!ts.isPropertyAccessExpression(callee)) return false;
    const method = callee.name.text;
    // Changing a label's case undoes the label map's words; number formatting shows a number.
    if (CASE_METHODS.has(method)) return true;
    if (NUMBER_METHODS.has(method)) return false;
    return !isLabelCall(n) && isStoredAccess(callee.expression);
  }
  return false;
}

const startsLower = (text) => /^[a-z]/.test(text.trim());
const isStringLiteral = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);

const exprText = (node, sf) => node.getText(sf).replace(/\s+/g, '');

function attrExpression(attr, sf) {
  const init = attr.initializer;
  if (!init) return null;
  if (ts.isJsxExpression(init) && init.expression) return exprText(unwrap(init.expression), sf);
  return null;
}

/** The hits in one source text: { line, reason }. */
export function findEnumLabelHits(text, file = 'x.tsx') {
  // A .ts file is read for its strings and its date formatting (the lib's date helpers are .ts);
  // the JSX rules are the .tsx shapes.
  const stringsOnly = file.endsWith('.ts');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, stringsOnly ? ts.ScriptKind.TS : ts.ScriptKind.TSX);
  const hits = [];
  const at = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const visit = (node) => {
    if (stringsOnly) {
      parenAsideHit(node);
      dateFormatHit(node);
      ts.forEachChild(node, visit);
      return;
    }
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
    parenAsideHit(node);
    dateFormatHit(node);
    ts.forEachChild(node, visit);
  };
  const TEXT_NODES = new Set([ts.SyntaxKind.JsxText, ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail]);
  function parenAsideHit(node) {
    if (!TEXT_NODES.has(node.kind)) return;
    const text = node.text.replace(/\s+/g, ' ').trim();
    // Whitespace collapses to one ordinary space first (a newline after the dot is a plain space), keeping U+00A0.
    const spaced = node.text.replace(/[ \t\r\n]+/g, ' ');
    if (!stringsOnly && /[ \u00a0]·(?!\u00a0) ?(?:optional|required|beta|experimental|deprecated|default|recommended)\b/.test(spaced)) {
      hits.push({ line: at(node), value: text, reason: `"${text}" builds the aside form without the no-break space after the dot: write it with aside(label, note) (lib/labelAside) so the dot starts the line with its note` });
    }
    // A status word after the dot starts lower case ("Google API · setup required", design).
    const capital = !stringsOnly && /\s·[\s\u00a0](?:Optional|Required|Default|Beta|Experimental|Deprecated|Recommended|Setup|Unavailable|Configured|Not checked)\b/.exec(node.text);
    if (capital) {
      hits.push({ line: at(node), value: text, reason: `"${capital[0].trim()}" after a middle dot starts with a capital: the word after the dot is lower case (" · setup required"); lower-case it where the label is joined (afterDot in lib/labelAside)` });
    }
    if (!stringsOnly && node.kind === ts.SyntaxKind.JsxText) dotThenExpression(node, spaced);
    const flagged = /\((?:optional|required|beta|experimental|deprecated|default|recommended)\)/i.exec(text);
    if (flagged) {
      hits.push({ line: at(node), value: text, reason: `"${flagged[0]}" in a person line: the note goes beside the label as an aside (" · optional"), or in a placeholder` });
      return;
    }
    if (stringsOnly) return;
    const label = /^[A-Z][^()]{0,40}?\s\(([^()]+)\)[.?!…]?$/.exec(text);
    if (!label) return;
    const aside = label[1];
    if (/^[^\s()]{1,5}$/.test(aside)) return; // a unit: "Duration (s)"
    if (/^[\d.,]+$/.test(aside)) return; // a count: "Images (3)"
    if (WRITTEN_UNITS.test(aside)) return; // a unit written out: "Size (pixels)"
    if (/^(?:[A-Za-z⌘⌥⇧^]+\+)*[A-Za-z0-9⌘⌥⇧^]+(?: or (?:[A-Za-z⌘⌥⇧^]+\+)*[A-Za-z0-9⌘⌥⇧^]+)?$/.test(aside) && /[+⌘⌥⇧]|^(?:Ctrl|Cmd|Shift|Alt)/.test(aside)) return; // a key shortcut
    hits.push({ line: at(node), value: text, reason: `"${text}" has a parenthesised aside: a label reads as its name; put the note beside it as an aside or a placeholder` });
  }
  const ASIDE_NOTE = /^(?:optional|required|beta|experimental|deprecated|default|recommended)\b/i;
  /** JSX text that ends in " · " (an ordinary space after the dot) with the note in the next node: `{label} · {'optional'}`. */
  function dotThenExpression(node, spaced) {
    if (!/ · $/.test(spaced)) return;
    const kids = node.parent.children;
    const next = kids[kids.indexOf(node) + 1];
    if (!next || !ts.isJsxExpression(next) || !next.expression) return;
    const expr = unwrap(next.expression);
    const literal = isStringLiteral(expr) ? expr.text : (ts.isTemplateExpression(expr) ? expr.head.text : null);
    if (literal === null || !ASIDE_NOTE.test(literal.trim())) return;
    hits.push({ line: at(node), value: exprText(next, sf), reason: `"· {${exprText(expr, sf)}}" builds the aside form from separate nodes with an ordinary space after the dot: write it with aside(label, note) (lib/labelAside) so the dot starts the line with its note` });
  }
  const WRITTEN_UNITS = /^(?:pixels?|seconds?|minutes?|hours?|days?|milliseconds?|frames?|bytes?|kilobytes?|megabytes?|gigabytes?|percent|degrees?|characters?|words?|tokens?)$/i;
  const FORMATTERS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);
  // These exist only on Date but read an ordinary name too often to flag on any receiver: they fail on a date receiver.
  const DATE_STRING_METHODS = new Set(['toDateString', 'toTimeString', 'toUTCString', 'toGMTString']);
  // toLocaleDateString and toLocaleTimeString exist only on Date: they are flagged on any receiver.
  // toLocaleString is also a Number method, so it is flagged only when the receiver is a date by name:
  // date, when, moment (any case), a camelCase `...At` / `...Date` suffix (`createdAt`), a snake_case
  // `..._at` / `..._date` (`last_scan_at`), or a time word as a whole word or a camelCase/snake_case
  // part (time, timestamp, ts, stamp: `resetTime`, `entry.ts`, `row.timestamp`). A duration is a
  // number (`elapsedTime`, `durationMs`, a Ms/Sec/Seconds suffix) and `format` is not a date.
  const nameParts = (name) => name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/_+/).filter(Boolean);
  const DURATION_PART = new Set(['elapsed', 'duration', 'ms', 'sec', 'secs', 'seconds']);
  // What is timed, in a "...Time" name that is a length of time (`renderTime`, `waitTime`, `latency`): it
  // excludes only the time-word match, so `lastRunAt` and `loadedAt` still read as dates.
  // A count of times or a bound ("maxTime", "minTime", "avgTime", "timeCount") is a number too.
  const TIMED_PART = new Set(['render', 'load', 'wait', 'latency', 'response', 'run', 'cpu', 'frame', 'total',
    'max', 'min', 'avg', 'mean', 'median', 'count', 'num', 'number', 'sum']);
  const TIME_PART = new Set(['time', 'timestamp', 'ts', 'stamp']);
  const DATE_NAME_CASED = (name) => {
    const parts = nameParts(name);
    if (parts.some((p) => DURATION_PART.has(p))) return false;
    if (/^(?:date|when|moment|at)$/i.test(name) || /[a-z](?:At|Date|Moment|When)$/.test(name) || /_(?:at|date)$/i.test(name)) return true;
    return !parts.some((p) => TIMED_PART.has(p)) && parts.some((p) => TIME_PART.has(p));
  };
  function nameOf(expr) {
    const n = unwrap(expr);
    if (ts.isIdentifier(n)) return n.text;
    if (ts.isPropertyAccessExpression(n)) return n.name.text;
    return '';
  }
  function isDateReceiver(expr) {
    const n = unwrap(expr);
    if (ts.isNewExpression(n)) return n.expression.getText(sf) === 'Date';
    if (ts.isCallExpression(n)) return /^Date\.(now|parse)$/.test(n.expression.getText(sf)) || n.expression.getText(sf) === 'Date';
    return DATE_NAME_CASED(nameOf(n));
  }
  function dateFormatHit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && FORMATTERS.has(node.expression.name.text)
      && (node.expression.name.text !== 'toLocaleString' || isDateReceiver(node.expression.expression))) {
      hits.push({ line: at(node), value: exprText(node, sf), reason: `${node.expression.name.text}() on a date shows the browser's raw format: use writtenDate, writtenDateTime or writtenTime (lib/writtenDate)` });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && DATE_STRING_METHODS.has(node.expression.name.text) && isDateReceiver(node.expression.expression)) {
      hits.push({ line: at(node), value: exprText(node, sf), reason: `${node.expression.name.text}() on a date shows a raw format: use writtenDate, writtenDateTime or writtenTime (lib/writtenDate)` });
    }
    // Intl.DateTimeFormat(...) with or without `new`: its output is a date a person reads.
    if ((ts.isNewExpression(node) || ts.isCallExpression(node)) && node.expression.getText(sf) === 'Intl.DateTimeFormat') {
      hits.push({ line: at(node), value: exprText(node, sf), reason: 'Intl.DateTimeFormat in a person line: use writtenDate, writtenDateTime or writtenTime (lib/writtenDate)' });
    }
  }
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
  /** Hits for one expression child. `first` is true when it is the badge's first visible content. */
  function badgeExpression(expr, first) {
    const n = unwrap(expr);
    const line = at(expr);
    if (isStoredAccess(n)) {
      hits.push({ line, value: exprText(n, sf), reason: `badge shows ${exprText(n, sf)} as is: draw its words from a label map` });
    } else if (first && isStringLiteral(n) && startsLower(n.text)) {
      hits.push({ line, value: n.text.trim(), reason: `badge text "${n.text.trim()}" starts lower case: badges are sentence case` });
    } else if (ts.isTemplateExpression(n)) {
      if (first && startsLower(n.head.text)) {
        hits.push({ line, value: n.head.text.trim(), reason: `badge text "${n.head.text.trim()}" starts lower case: badges are sentence case` });
      } else {
        const before = hits.length;
        n.templateSpans.forEach((span, i) => {
          if (hits.length === before) badgeExpression(span.expression, first && i === 0 && n.head.text.trim() === '');
        });
      }
    } else if (ts.isConditionalExpression(n)) {
      // One hit per conditional, whichever branch is first to fail.
      const before = hits.length;
      badgeExpression(n.whenTrue, first);
      if (hits.length === before) badgeExpression(n.whenFalse, first);
    } else if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      // `a ?? b` and `a || b` show either operand; in `a && b` the left is a condition, the right is shown.
      if (op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.BarBarToken) {
        const before = hits.length;
        badgeExpression(n.left, first);
        if (hits.length === before) badgeExpression(n.right, first);
      } else if (op === ts.SyntaxKind.AmpersandAmpersandToken) badgeExpression(n.right, first);
      else if (op === ts.SyntaxKind.PlusToken) {
        // A concatenation reads left to right: its first piece leads the badge, the rest follows it.
        const before = hits.length;
        badgeExpression(n.left, first);
        if (hits.length === before) badgeExpression(n.right, false);
      }
    }
  }
  /** Lower-case text fails only as the first visible content, at any depth ("2 images" is fine after a number); a stored-value access fails anywhere. */
  function badgeKids(el, first) {
    const kids = el.children.filter((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces));
    kids.forEach((kid, i) => {
      const isFirst = first && i === 0;
      if (ts.isJsxText(kid)) {
        if (isFirst && startsLower(kid.text)) {
          hits.push({ line: at(kid), value: kid.text.trim(), reason: `badge text "${kid.text.trim()}" starts lower case: badges are sentence case` });
        }
      } else if (ts.isJsxExpression(kid) && kid.expression) badgeExpression(kid.expression, isFirst);
      else if (ts.isJsxElement(kid) || ts.isJsxFragment(kid)) badgeKids(kid, isFirst);
    });
  }
  function badgeHits(el) { badgeKids(el, true); }
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
  const usedNames = new Set();
  for (const file of collectSources(SRC)) {
    const rel = relative(SRC, file);
    for (const hit of findEnumLabelHits(readFileSync(file, 'utf8'), file)) {
      const allowed = ALLOWED.findIndex((a) => a.file === rel && a.value === hit.value);
      const named = ALLOWED_NAMES.findIndex((a) => a.file === rel && a.value === hit.value);
      if (allowed >= 0) used.add(allowed);
      else if (named >= 0) usedNames.add(named);
      else problems.push({ file: rel, ...hit });
    }
  }
  ALLOWED.forEach((a, i) => {
    if (!used.has(i)) problems.push({ file: a.file, line: 0, reason: `ALLOWED entry for ${a.value} no longer matches anything: delete it` });
  });
  ALLOWED_NAMES.forEach((a, i) => {
    if (!usedNames.has(i)) problems.push({ file: a.file, line: 0, reason: `ALLOWED_NAMES entry for ${a.value} no longer matches anything: delete it` });
  });
  if (problems.length > 0) {
    console.error('check:enum-labels found person-facing stored values or a leading "You" mid-sentence:');
    for (const p of problems) console.error(`  src/${p.file}:${p.line} ${p.reason}`);
    process.exit(1);
  }
  console.log('check:enum-labels ok');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
